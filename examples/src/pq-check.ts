// PQ enforcement check (`pnpm example pq-check`): the seller must refuse a payment whose ML-DSA-65 part is missing, wrong, or from another key.
import { hashTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeHeader, pqKeyFromAgentKey, pqSign, spendTypedData, type PaymentPayload, type Quote } from "@aevum-kit/aevum";

const key = process.env.AGENT_KEY as Hex;
const agent = privateKeyToAccount(key);
const url = `${process.env.SELLER_URL}/api/paid/summarize`;
const body = JSON.stringify({ text: `pq negative test ${Date.now()}. second.` });
const h = { "content-type": "application/json", "x-agent": agent.address };

async function attempt(label: string, mutate: (p: PaymentPayload, digest: Hex) => void) {
  const q = ((await (await fetch(url, { method: "POST", headers: h, body })).json()) as { accepts: Quote[] }).accepts[0]!;
  const typed = spendTypedData(q.chainId, q.vault, { agent: agent.address, payee: q.payee, amount: BigInt(q.amount), ref: q.ref, deadline: BigInt(q.deadline) });
  const p: PaymentPayload = { scheme: "vault-sig", quoteId: q.quoteId, agent: agent.address, signature: await agent.signTypedData(typed) };
  mutate(p, hashTypedData(typed));
  const r = await fetch(url, { method: "POST", headers: { ...h, "x-payment": encodeHeader(p) }, body });
  console.log(label, "→", r.status, JSON.stringify(await r.json()));
}

const mine = pqKeyFromAgentKey(key);
const other = pqKeyFromAgentKey(`0x${"11".repeat(32)}`);
await attempt("no PQ signature      ", () => {});
await attempt("PQ sig over wrong msg", (p) => (p.pq = { publicKey: mine.publicKey, signature: pqSign(`0x${"00".repeat(32)}`, mine.secretKey) }));
await attempt("PQ from another key  ", (p, d) => (p.pq = { publicKey: other.publicKey, signature: pqSign(d, other.secretKey) }));
await attempt("valid hybrid (control)", (p, d) => (p.pq = { publicKey: mine.publicKey, signature: pqSign(d, mine.secretKey) }));
