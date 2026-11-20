/**
 * Owner tasks from the command line (the web Vault page does the same with a browser wallet).
 *
 *   pnpm example owner setup     # register identity, deposit, grant AGENT_KEY's address
 *   pnpm example owner status    # grant, spend today, reputation
 *   pnpm example owner revoke    # stop the agent in the next block
 *
 * Env: OWNER_KEY, AGENT_KEY (only its address and PQ key are used), SELLER_URL, RPC_URL,
 *      DEPOSIT (default 1), PER_TX (0.10), DAILY (0.25), HOURS (24), PQ (1 to commit the agent's ML-DSA-65 key).
 */
import { createWalletClient, formatUnits, http, parseEventLogs, parseUnits, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  aevumTestnet,
  allowanceVaultAbi,
  erc20Abi,
  identityRegistryAbi,
  isAnvilAccount,
  pqKeyFromAgentKey,
  reputationRegistryAbi,
  txUrl,
  ZERO_HASH,
} from "@aevum-kit/aevum";
import { connect, requiredKey } from "./env";
import { loadDeployment } from "./deployment";

const command = process.argv[2] ?? "status";
const { client, chain, rpcUrl } = await connect();
const d = loadDeployment(chain.id);
const owner = privateKeyToAccount(requiredKey("OWNER_KEY"));
const agentKey = requiredKey("AGENT_KEY");
const agent = privateKeyToAccount(agentKey).address;
const wallet = createWalletClient({ account: owner, chain, transport: http(rpcUrl) });
const sellerUrl = process.env.SELLER_URL?.trim() || "http://localhost:3000";
const DEC = 6;
const fmt = (v: bigint) => `${formatUnits(v, DEC)} tUSD8`;
const link = (h: Hex) => (chain.id === aevumTestnet.id ? txUrl(h) : `tx ${h}`);

if (chain.id === aevumTestnet.id && isAnvilAccount(owner.address)) {
  console.error("OWNER_KEY is a public anvil key. Use your own test wallet on Aevum.");
  process.exit(1);
}

async function send(label: string, write: () => Promise<Hex>) {
  const hash = await write();
  const r = await client.waitForTransactionReceipt({ hash });
  console.log(`${r.status === "success" ? "✓" : "✗"} ${label}  ${link(hash)}`);
  if (r.status !== "success") process.exit(1);
  return r;
}

async function setup() {
  const info = (await fetch(`${sellerUrl}/api/seller`).then((r) => r.json())) as { payee?: Address; error?: string };
  if (!info.payee) throw new Error(`Seller not reachable at ${sellerUrl}: ${info.error ?? "no payee"}`);
  console.log(`Owner ${owner.address}\nAgent ${agent}\nSeller ${info.payee}\n`);

  const r = await send("register identity", () => wallet.writeContract({ address: d.identity,
    abi: identityRegistryAbi,
    functionName: "register",
    args: [process.env.AGENT_URI ?? `${sellerUrl}/agents/research-bot.json`], type: "legacy" }));
  const [registered] = parseEventLogs({ abi: identityRegistryAbi, logs: r.logs, eventName: "Registered" });
  const agentId = registered.args.agentId;
  console.log(`  identity #${agentId}`);

  const deposit = parseUnits(process.env.DEPOSIT ?? "1", DEC);
  const allowance = await client.readContract({ address: d.token, abi: erc20Abi, functionName: "allowance", args: [owner.address, d.vault] });
  if (allowance < deposit) await send("approve", () => wallet.writeContract({ address: d.token, abi: erc20Abi, functionName: "approve", args: [d.vault, deposit], type: "legacy" }));
  await send(`deposit ${fmt(deposit)}`, () => wallet.writeContract({ address: d.vault, abi: allowanceVaultAbi, functionName: "deposit", args: [deposit], type: "legacy" }));

  const pqHash = process.env.PQ === "1" ? pqKeyFromAgentKey(agentKey).pqKeyHash : ZERO_HASH;
  const perTx = parseUnits(process.env.PER_TX ?? "0.10", DEC);
  const daily = parseUnits(process.env.DAILY ?? "0.25", DEC);
  const expiry = BigInt(Math.floor(Date.now() / 1000) + Math.round(Number(process.env.HOURS ?? "24") * 3600));
  const label = `grant: ${fmt(perTx)} per payment, ${fmt(daily)} per day, seller ${info.payee}${pqHash !== ZERO_HASH ? ", PQ key committed" : ""}`;
  await send(label, () =>
    wallet.writeContract({
      address: d.vault,
      abi: allowanceVaultAbi,
      functionName: "grant",
      args: [agent, agentId, perTx, daily, expiry, [info.payee!], pqHash],
      type: "legacy",
    }),
  );
}

async function status() {
  const g = await client.readContract({ address: d.vault, abi: allowanceVaultAbi, functionName: "grantOf", args: [agent] });
  if (g.owner === "0x0000000000000000000000000000000000000000") return console.log(`Agent ${agent} has no grant.`);
  const [remaining, bal, [count, avg]] = await Promise.all([
    client.readContract({ address: d.vault, abi: allowanceVaultAbi, functionName: "remainingToday", args: [agent] }),
    client.readContract({ address: d.vault, abi: allowanceVaultAbi, functionName: "balanceOf", args: [g.owner] }),
    client.readContract({ address: d.reputation, abi: reputationRegistryAbi, functionName: "getSummary", args: [g.agentId] }),
  ]);
  console.log({
    agent,
    owner: g.owner,
    identity: `#${g.agentId}`,
    status: g.revoked ? "revoked" : Number(g.expiry) * 1000 < Date.now() ? "expired" : "active",
    perPayment: fmt(g.perTxCap),
    dailyCap: fmt(g.dailyCap),
    remainingToday: fmt(remaining),
    ownerVaultBalance: fmt(bal),
    reputation: count ? `${avg}/100 over ${count} paid requests` : "unrated",
    pqKeyHash: g.pqKeyHash === ZERO_HASH ? "none" : g.pqKeyHash,
  });
}

async function revoke() {
  await send(`revoke ${agent}`, () => wallet.writeContract({ address: d.vault, abi: allowanceVaultAbi, functionName: "revoke", args: [agent], type: "legacy" }));
}

const commands: Record<string, () => Promise<void>> = { setup, status, revoke };
if (!commands[command]) {
  console.error(`Unknown command "${command}". Use: setup | status | revoke`);
  process.exit(1);
}
await commands[command]();
