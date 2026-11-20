/**
 * Server-only: the demo seller behind /api/paid/*. It quotes a price per request, accepts a signed
 * vault payment, settles it on Aevum with `spendWithSig` (the seller pays gas, the agent needs none),
 * and rates the agent in the ReputationRegistry after delivery.
 *
 * State (quotes, results, rate limits) lives in this process's memory. That is fine for
 * `next start` on one server. On serverless hosts each instance has its own copy: move it to a
 * shared store (Redis, a database) before relying on it.
 */
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  isHex,
  keccak256,
  toHex,
  verifyTypedData,
  type Address,
  type Hex,
} from "viem";
import { nonceManager, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  aevumFork,
  allowanceVaultAbi,
  explainVaultError,
  isAnvilAccount,
  localAnvil,
  pqVerify,
  reputationRegistryAbi,
  spendTypedData,
  ZERO_HASH,
  type PaymentPayload,
  type PaymentResponse,
  type Quote,
} from "@aevum-kit/aevum";
import { defaultNetwork, networkByKey, type Network } from "./env";

const LOCAL_CHAINS = new Set<number>([localAnvil.id, aevumFork.id]);
const QUOTE_TTL_SECONDS = 300;
const MAX_QUOTES = 5_000;
const QUOTES_PER_AGENT_PER_MINUTE = 20;
const DISCOUNT_BPS = 2_000; // 20% off for agents with a good paid history
const DISCOUNT_MIN_RATINGS = 3;
const DISCOUNT_MIN_AVERAGE = 80;
export const TOKEN_DECIMALS = 6;

export class SellerError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

// ------------------------------------------------------------------ config

export function sellerNetwork(): Network {
  return networkByKey(process.env.SELLER_NETWORK?.trim()) ?? defaultNetwork;
}

let cachedAccount: PrivateKeyAccount | null | undefined;
function sellerAccount(net: Network): PrivateKeyAccount {
  if (cachedAccount === undefined) {
    const raw = process.env.SELLER_PRIVATE_KEY?.trim();
    const key = (raw?.startsWith("0x") ? raw : `0x${raw ?? ""}`) as Hex;
    cachedAccount = raw && isHex(key) && key.length === 66 ? privateKeyToAccount(key, { nonceManager }) : null;
  }
  if (!cachedAccount) throw new SellerError(503, "The seller is not configured: set SELLER_PRIVATE_KEY.", "not_configured");
  // anvil's keys are public; on a real network anyone could drain the seller's gas and payments.
  if (isAnvilAccount(cachedAccount.address) && !LOCAL_CHAINS.has(net.chain.id)) {
    throw new SellerError(503, "SELLER_PRIVATE_KEY is a public anvil key. Use a fresh test wallet on Aevum.", "unsafe_key");
  }
  return cachedAccount;
}

export function basePrice(): bigint {
  const v = process.env.PRICE_PER_CALL?.trim() || "0.05";
  const [whole, frac = ""] = v.split(".");
  return BigInt(whole || "0") * 10n ** BigInt(TOKEN_DECIMALS) + BigInt((frac + "000000").slice(0, TOKEN_DECIMALS));
}

export function seller() {
  const net = sellerNetwork();
  if (!net.vault || !net.reputation) {
    throw new SellerError(503, `No vault configured for ${net.label}. Set NEXT_PUBLIC_VAULT_* and NEXT_PUBLIC_REPUTATION_*.`, "not_configured");
  }
  const account = sellerAccount(net);
  const rpc = process.env.SELLER_RPC_URL?.trim() || net.chain.rpcUrls.default.http[0];
  const publicClient = createPublicClient({ chain: net.chain, transport: http(rpc) });
  const walletClient = createWalletClient({ account, chain: net.chain, transport: http(rpc) });
  return { net, account, vault: net.vault, reputation: net.reputation, publicClient, walletClient };
}

export const fmt = (v: bigint) => `${formatUnits(v, TOKEN_DECIMALS)} tUSD8`;

// ------------------------------------------------------------------ state

interface QuoteRecord {
  quote: Quote;
  agent: Address;
  bodyHash: Hex;
  status: "open" | "settling" | "paid";
  createdAt: number;
  result?: unknown;
  payment?: PaymentResponse;
  /** Server-clock expiry of the quote (the signed deadline itself is in block time). */
  expiresAtMs: number;
  /** Set once the spend tx is sent, so a retry after a timeout can recover instead of paying twice. */
  txHash?: Hex;
}

const quotes = new Map<string, QuoteRecord>();
const hits = new Map<string, number[]>();

function rateLimited(bucket: string, max: number): boolean {
  const now = Date.now();
  const recent = (hits.get(bucket) ?? []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(bucket, recent);
  return recent.length > max;
}

function prune() {
  const now = Date.now();
  for (const [id, r] of quotes) {
    if (r.status !== "settling" && now - r.createdAt > 3_600_000) quotes.delete(id);
  }
}

export function hashBody(body: string): Hex {
  return keccak256(toHex(body));
}

// ------------------------------------------------------------------ quote

export async function createQuote(agent: Address, resource: string, bodyHash: Hex): Promise<Quote> {
  const s = seller();
  if (rateLimited(`quote:${agent.toLowerCase()}`, QUOTES_PER_AGENT_PER_MINUTE)) {
    throw new SellerError(429, "Too many quotes for this agent. Wait a minute.", "rate_limited");
  }
  if (quotes.size > MAX_QUOTES) prune();
  if (quotes.size > MAX_QUOTES) throw new SellerError(503, "The seller is busy. Try again shortly.", "busy");

  const [grant, token, block] = await Promise.all([
    s.publicClient.readContract({ address: s.vault, abi: allowanceVaultAbi, functionName: "grantOf", args: [agent] }),
    s.publicClient.readContract({ address: s.vault, abi: allowanceVaultAbi, functionName: "token" }),
    s.publicClient.getBlock({ blockTag: "latest" }),
  ]);
  // Deadlines and expiry are checked by the contract against block time, so quote in block time,
  // not this server's clock (they can drift apart).
  const chainNow = block.timestamp;
  if (grant.owner === "0x0000000000000000000000000000000000000000") {
    throw new SellerError(403, explainVaultError("NoGrant"), "no_grant");
  }
  // Refuse early, before the agent signs anything, when the vault would refuse anyway.
  if (grant.revoked) throw new SellerError(403, explainVaultError("GrantRevoked"), "GrantRevoked");
  if (chainNow >= grant.expiry) throw new SellerError(403, explainVaultError("GrantExpired"), "GrantExpired");

  const [count, average] = await s.publicClient.readContract({
    address: s.reputation,
    abi: reputationRegistryAbi,
    functionName: "getSummary",
    args: [grant.agentId],
  });
  const base = basePrice();
  const discountBps = count >= DISCOUNT_MIN_RATINGS && average >= DISCOUNT_MIN_AVERAGE ? DISCOUNT_BPS : 0;
  const amount = base - (base * BigInt(discountBps)) / 10_000n;

  const quoteId = crypto.randomUUID();
  const quote: Quote = {
    scheme: "vault-sig",
    quoteId,
    chainId: s.net.chain.id,
    vault: s.vault,
    token,
    payee: s.account.address,
    amount: amount.toString(),
    // Unguessable and bound to this quote, so nobody can pre-claim it.
    ref: keccak256(toHex(`${quoteId}:${bodyHash}`)),
    deadline: Number(chainNow) + QUOTE_TTL_SECONDS,
    resource,
    pricing: {
      base: base.toString(),
      discountBps,
      reputation: { count: Number(count), average: Number(average) },
    },
    pqRequired: grant.pqKeyHash !== ZERO_HASH,
  };
  quotes.set(quoteId, { quote, agent, bodyHash, status: "open", createdAt: Date.now(), expiresAtMs: Date.now() + QUOTE_TTL_SECONDS * 1000 });
  return quote;
}

// ------------------------------------------------------------------ settle

export type Settled = { result: unknown; payment: PaymentResponse; replay: boolean };

/**
 * Verify a payment for a quote, settle it on chain, then produce the result with `work`.
 * Idempotent: the same paid quote returns the stored result instead of charging again.
 */
export async function settle(payload: PaymentPayload, bodyHash: Hex, work: () => Promise<unknown>): Promise<Settled> {
  const s = seller();
  const rec = quotes.get(payload.quoteId);
  if (!rec) throw new SellerError(402, "Unknown or expired quote. Ask for a new one.", "unknown_quote");
  if (rec.agent.toLowerCase() !== payload.agent.toLowerCase()) {
    throw new SellerError(402, "This quote was issued to a different agent.", "wrong_agent");
  }
  if (rec.bodyHash !== bodyHash) throw new SellerError(402, "The request changed after it was quoted. Ask for a new quote.", "body_changed");
  if (rec.status === "paid") return { result: rec.result, payment: rec.payment!, replay: true };
  if (rec.status === "settling") throw new SellerError(409, "This payment is already being settled. Retry in a few seconds.", "in_flight");

  const q = rec.quote;
  if (Date.now() > rec.expiresAtMs) throw new SellerError(402, "The quote expired before payment. Ask for a new one.", "quote_expired");

  const message = {
    agent: payload.agent,
    payee: q.payee,
    amount: BigInt(q.amount),
    ref: q.ref,
    deadline: BigInt(q.deadline),
  };
  const typed = spendTypedData(q.chainId, q.vault, message);

  // 1. Cheap off-chain checks first, so bad payments never cost gas.
  const ok = await verifyTypedData({ address: payload.agent, ...typed, signature: payload.signature }).catch(() => false);
  if (!ok) throw new SellerError(402, explainVaultError("BadSignature"), "bad_signature");

  if (q.pqRequired) {
    const grant = await s.publicClient.readContract({ address: q.vault, abi: allowanceVaultAbi, functionName: "grantOf", args: [payload.agent] });
    const digest = await s.publicClient.readContract({
      address: q.vault,
      abi: allowanceVaultAbi,
      functionName: "spendDigest",
      args: [message.agent, message.payee, message.amount, message.ref, message.deadline],
    });
    if (!payload.pq || !pqVerify(digest, payload.pq.signature, payload.pq.publicKey, grant.pqKeyHash)) {
      throw new SellerError(402, "This agent's grant requires a post-quantum (ML-DSA-65) signature, and it is missing or invalid.", "bad_pq_signature");
    }
  }

  rec.status = "settling";
  try {
    const args = [message.agent, message.payee, message.amount, message.ref, message.deadline, payload.signature] as const;
    let txHash = rec.txHash;
    if (!txHash) {
      // 2. Simulate, so a cap, revoke or expiry is reported in plain words and costs nothing.
      await s.publicClient.simulateContract({ account: s.account, address: q.vault, abi: allowanceVaultAbi, functionName: "spendWithSig", args });

      // 3. Settle on chain.
      txHash = await s.walletClient.writeContract({
        address: q.vault,
        abi: allowanceVaultAbi,
        functionName: "spendWithSig",
        args,
        type: "legacy",
        chain: s.net.chain,
      });
      rec.txHash = txHash;
    }
    // A retry after a timeout lands here with the stored hash and just waits again.
    const receipt = await s.publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
    if (receipt.status !== "success") {
      rec.txHash = undefined;
      throw new SellerError(402, "The payment transaction reverted.", "reverted");
    }

    // 4. Trust the chain, not our own bookkeeping: the receipt must show exactly this payment.
    const rc = await s.publicClient.readContract({ address: q.vault, abi: allowanceVaultAbi, functionName: "receiptOf", args: [q.payee, q.ref] });
    if (rc.agent.toLowerCase() !== payload.agent.toLowerCase() || rc.amount !== message.amount) {
      throw new SellerError(402, "The on-chain receipt does not match the quote.", "receipt_mismatch");
    }

    const result = await work();
    const payment: PaymentResponse = {
      txHash,
      ref: q.ref,
      amount: q.amount,
      payee: q.payee,
      agent: payload.agent,
      blockNumber: receipt.blockNumber.toString(),
    };
    rec.status = "paid";
    rec.result = result;
    rec.payment = payment;

    // 5. Rate the agent after delivery. Not awaited: the buyer should not wait for it.
    void rate(q.ref).catch((e) => console.error("[seller] feedback failed", q.ref, e));
    return { result, payment, replay: false };
  } catch (e) {
    if (rec.status === "settling") rec.status = "open";
    throw toSellerError(e);
  }
}

async function rate(ref: Hex) {
  const s = seller();
  const hash = await s.walletClient.writeContract({
    address: s.reputation,
    abi: reputationRegistryAbi,
    functionName: "giveFeedback",
    args: [ref, 100, "paid-on-time"],
    type: "legacy",
    chain: s.net.chain,
  });
  await s.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
}

export function toSellerError(e: unknown): SellerError {
  if (e instanceof SellerError) return e;
  if (e instanceof BaseError) {
    const revert = e.walk((x) => x instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName) {
      const name = revert.data.errorName;
      const status = name === "RefAlreadyPaid" ? 409 : 402;
      return new SellerError(status, explainVaultError(name, revert.data.args ?? [], fmt), name);
    }
    console.error("[seller]", e.shortMessage);
    return new SellerError(502, `The network did not accept the payment: ${e.shortMessage}`, "chain_error");
  }
  console.error("[seller]", e);
  return new SellerError(500, "The seller hit an unexpected error. Nothing was delivered.", "internal");
}
