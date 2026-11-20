/**
 * An AI agent that pays for an API per request, within the allowance its owner granted.
 * The agent key holds no tokens and no gas: it only signs. The seller settles on Aevum.
 *
 *   pnpm example agent whoami        # agent address + ML-DSA-65 key hash (give both to the owner)
 *   pnpm example agent demo          # the demo run: paid calls, a safe retry, then the daily cap stops it
 *   pnpm example agent once "text"   # one paid call
 *
 * Env: AGENT_KEY, SELLER_URL (default http://localhost:3000), RPC_URL, MAX_CALLS (demo, default 8).
 * The agent never pays more than the quote and refuses quotes above MAX_PRICE (default 0.10).
 */
import { formatUnits, parseUnits, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  aevumTestnet,
  decodeHeader,
  encodeHeader,
  HEADER_AGENT,
  HEADER_PAYMENT,
  HEADER_PAYMENT_RESPONSE,
  pqKeyFromAgentKey,
  pqSign,
  spendTypedData,
  txUrl,
  type PaymentPayload,
  type PaymentResponse,
  type Quote,
} from "@aevum-kit/aevum";
import { hashTypedData } from "viem";
import { requiredKey } from "./env";

const agentKey = requiredKey("AGENT_KEY");
const agent = privateKeyToAccount(agentKey);
const pq = pqKeyFromAgentKey(agentKey);
const sellerUrl = process.env.SELLER_URL?.trim() || "http://localhost:3000";
const maxPrice = parseUnits(process.env.MAX_PRICE ?? "0.10", 6);
const fmt = (v: bigint | string) => `${formatUnits(BigInt(v), 6)} tUSD8`;

const DOCS = [
  "Stablecoins settle in seconds. Agents need to pay per request without a human approving each payment. A spending policy enforced on chain lets an owner cap the damage of a wrong or compromised agent. Revoking access must take effect immediately.",
  "QDay anchors its ledger to the Abelian layer 1, which uses lattice-based cryptography. Accounts still sign with ECDSA today. Native post-quantum accounts with ML-DSA-65 are planned for Phase 2. Hybrid agent keys combine both schemes during the transition.",
  "The seller quotes a price for each request. The agent signs a payment for exactly that quote. The seller settles the payment on Aevum, checks the receipt, and only then returns the result. A retry of the same quote returns the stored result and is never charged twice.",
];

type Outcome =
  | { ok: true; result: unknown; payment: PaymentResponse; replay: boolean; quote: Quote }
  | { ok: false; status: number; error: string; code?: string };

async function post(path: string, body: string, headers: Record<string, string>): Promise<Response> {
  return fetch(`${sellerUrl}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
}

/** Retries network errors, 5xx and "in flight" (409) with the SAME payment: safe because the vault pays a quote once. */
async function withRetry(fn: () => Promise<Response>, attempts = 4): Promise<Response> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fn();
      const retryable = res.status >= 500 || (res.status === 409 && (await res.clone().json()).code === "in_flight");
      if (!retryable || i === attempts - 1) return res;
      console.log(`    … seller answered ${res.status}, retrying the same payment (${i + 1}/${attempts - 1})`);
    } catch (e) {
      last = e;
      if (i === attempts - 1) throw e;
      console.log(`    … network error, retrying the same payment (${i + 1}/${attempts - 1})`);
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
  }
  throw last;
}

async function sign(quote: Quote): Promise<PaymentPayload> {
  const typed = spendTypedData(quote.chainId, quote.vault, {
    agent: agent.address,
    payee: quote.payee,
    amount: BigInt(quote.amount),
    ref: quote.ref,
    deadline: BigInt(quote.deadline),
  });
  const signature = await agent.signTypedData(typed);
  const payload: PaymentPayload = { scheme: "vault-sig", quoteId: quote.quoteId, agent: agent.address, signature };
  // Hybrid signing: the same EIP-712 digest, also signed with the agent's ML-DSA-65 key.
  if (quote.pqRequired) payload.pq = { publicKey: pq.publicKey, signature: pqSign(hashTypedData(typed), pq.secretKey) };
  return payload;
}

/** One paid call: ask, get a quote, check it against our own policy, sign, pay, get the result. */
async function call(text: string, opts: { replayPaymentOnce?: boolean } = {}): Promise<Outcome> {
  const body = JSON.stringify({ text });
  const ask = await post("/api/paid/summarize", body, { [HEADER_AGENT]: agent.address });
  if (ask.status !== 402) {
    const j = (await ask.json().catch(() => ({}))) as { error?: string; code?: string };
    return { ok: false, status: ask.status, error: j.error ?? `Unexpected ${ask.status}`, code: j.code };
  }
  const { accepts } = (await ask.json()) as { accepts: Quote[] };
  const quote = accepts.find((q) => q.scheme === "vault-sig");
  if (!quote) return { ok: false, status: 402, error: "The seller offered no payment scheme this agent supports." };

  // The agent's own guardrail, on top of the vault's: never trust the seller's price blindly.
  if (BigInt(quote.amount) > maxPrice) return { ok: false, status: 402, error: `Quote ${fmt(quote.amount)} is above this agent's MAX_PRICE ${fmt(maxPrice)}. Not paying.` };
  const discount = quote.pricing.discountBps ? ` (${quote.pricing.discountBps / 100}% reputation discount, ${quote.pricing.reputation.count} ratings avg ${quote.pricing.reputation.average})` : "";
  console.log(`    quote ${quote.quoteId.slice(0, 8)}: ${fmt(quote.amount)}${discount}${quote.pqRequired ? " · PQ signature required" : ""}`);

  const payment = encodeHeader(await sign(quote));
  const send = () => post("/api/paid/summarize", body, { [HEADER_AGENT]: agent.address, [HEADER_PAYMENT]: payment });
  const res = await withRetry(send);
  const j = (await res.json()) as { result?: unknown; payment?: PaymentResponse; replay?: boolean; error?: string; code?: string };
  if (!res.ok) return { ok: false, status: res.status, error: j.error ?? `Seller answered ${res.status}`, code: j.code };

  const header = decodeHeader<PaymentResponse>(res.headers.get(HEADER_PAYMENT_RESPONSE));
  if (header?.txHash !== j.payment?.txHash) return { ok: false, status: 502, error: "Payment response header and body disagree." };

  if (opts.replayPaymentOnce) {
    // Simulate a client that lost the response and sends the same payment again.
    const again = await send();
    const r2 = (await again.json()) as { replay?: boolean; payment?: PaymentResponse };
    console.log(`    resent the same payment → HTTP ${again.status}, replay=${r2.replay}, same tx=${r2.payment?.txHash === j.payment?.txHash}. Charged once.`);
  }
  return { ok: true, result: j.result, payment: j.payment!, replay: Boolean(j.replay), quote };
}

function show(i: number, o: Outcome) {
  if (o.ok) {
    const r = o.result as { summary: string; keywords: string[] };
    const tx = o.payment.txHash as Hex;
    console.log(`  ✓ #${i} paid ${fmt(o.payment.amount)} · ${o.quote.chainId === aevumTestnet.id ? txUrl(tx) : `tx ${tx}`}`);
    console.log(`    summary: ${r.summary.slice(0, 110)}${r.summary.length > 110 ? "…" : ""}`);
  } else {
    console.log(`  ✗ #${i} refused (${o.code ?? o.status}): ${o.error}`);
  }
}

const mode = process.argv[2] ?? "demo";
if (mode === "whoami") {
  console.log(`agent address : ${agent.address}`);
  console.log(`ML-DSA-65 hash: ${pq.pqKeyHash}`);
  console.log(`(public key ${(pq.publicKey.length - 2) / 2} bytes, derived from AGENT_KEY)`);
} else if (mode === "once") {
  const text = process.argv.slice(3).join(" ") || DOCS[0]!;
  show(1, await call(text));
} else if (mode === "demo") {
  console.log(`Agent ${agent.address} → seller ${sellerUrl}\n`);
  const max = Number(process.env.MAX_CALLS ?? 8);
  for (let i = 1; i <= max; i++) {
    const text = `${DOCS[(i - 1) % DOCS.length]} (request ${i} at ${new Date().toISOString()})`;
    const o = await call(text, { replayPaymentOnce: i === 1 });
    show(i, o);
    if (!o.ok) {
      const stop = ["OverDailyCap", "GrantRevoked", "GrantExpired", "NoGrant", "no_grant", "PayeeNotAllowed", "InsufficientVaultBalance"];
      if (o.code && stop.includes(o.code)) {
        console.log(`\nStopping: the owner's policy says no. The agent does not try to work around it.`);
        break;
      }
    }
  }
} else {
  console.error(`Unknown mode "${mode}". Use: whoami | demo | once "text"`);
  process.exit(1);
}
