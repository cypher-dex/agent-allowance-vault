"use client";

import { allowanceVaultAbi, erc20Abi, getLogsChunked, identityRegistryAbi, reputationRegistryAbi, txUrl } from "@aevum-kit/aevum";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { formatUnits, getAbiItem, isAddress, isHex, parseUnits, type Address, type Hex, type PublicClient } from "viem";
import { useAccount, usePublicClient, useReadContract, useWriteContract } from "wagmi";
import { CopyValue, Drawer, Skeleton, Stat } from "@/components/ui";
import { useToken } from "@/components/useToken";
import { explain } from "@/lib/errors";
import { short, timeLeft } from "@/lib/format";
import { useNetwork } from "@/lib/network";

const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;
const POLL_MS = 5_000;

type Notice = { kind: "good" | "bad" | "warn"; text: string; tx?: Hex } | null;

export default function VaultPage() {
  const { net } = useNetwork();
  const chainId = net.chain.id;
  const vault = net.vault;
  const identity = net.identity;
  const reputation = net.reputation;
  const client = usePublicClient({ chainId }) as PublicClient | undefined;
  const { address, isConnected, chainId: walletChain } = useAccount();
  const token = useToken();
  const qc = useQueryClient();
  const { writeContractAsync } = useWriteContract();
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [drawer, setDrawer] = useState<"funds" | "identity" | "grant" | null>(null);
  const closeDrawer = () => setDrawer(null);

  const onChain = isConnected && walletChain === chainId;
  const fmt = (v: bigint) => `${formatUnits(v, token.decimals)} ${token.symbol}`;

  const walletBal = useReadContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId,
    query: { enabled: Boolean(token.address && address), refetchInterval: POLL_MS },
  });
  const vaultBal = useReadContract({
    address: vault,
    abi: allowanceVaultAbi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId,
    query: { enabled: Boolean(vault && address), refetchInterval: POLL_MS },
  });

  // My agent identities and my grants, rebuilt from events (Aevum: 1,000 blocks per getLogs call).
  const mine = useQuery({
    queryKey: ["mine", chainId, vault, identity, address],
    enabled: Boolean(client && vault && identity && address),
    refetchInterval: POLL_MS * 2,
    queryFn: async () => {
      const head = await client!.getBlockNumber();
      const from = net.deployBlock ?? (head > 5_000n ? head - 5_000n : 0n);
      const [registered, granted] = await Promise.all([
        getLogsChunked(client!, { address: identity!, event: getAbiItem({ abi: identityRegistryAbi, name: "Registered" }), args: { owner: address }, fromBlock: from, toBlock: head }),
        getLogsChunked(client!, { address: vault!, event: getAbiItem({ abi: allowanceVaultAbi, name: "Granted" }), args: { owner: address }, fromBlock: from, toBlock: head }),
      ]);
      const ids = registered.map((l) => ({ agentId: l.args.agentId!, uri: l.args.agentURI ?? "" }));
      const agents = [...new Set(granted.map((l) => l.args.agent!))];
      const rows = await Promise.all(
        agents.map(async (agent) => {
          const [grant, remaining] = await Promise.all([
            client!.readContract({ address: vault!, abi: allowanceVaultAbi, functionName: "grantOf", args: [agent] }),
            client!.readContract({ address: vault!, abi: allowanceVaultAbi, functionName: "remainingToday", args: [agent] }),
          ]);
          const [count, average] = reputation
            ? await client!.readContract({ address: reputation, abi: reputationRegistryAbi, functionName: "getSummary", args: [grant.agentId] })
            : [0n, 0n];
          return { agent, grant, remaining, count, average };
        }),
      );
      return { ids, rows };
    },
  });

  const seller = useQuery({
    queryKey: ["seller-info"],
    queryFn: async () => {
      const r = await fetch("/api/seller");
      return r.ok ? ((await r.json()) as { payee: Address; chainId: number; basePriceLabel: string }) : null;
    },
  });

  async function run(label: string, fn: () => Promise<Hex>, done: string): Promise<boolean> {
    setBusy(label);
    setNotice(null);
    try {
      const hash = await fn();
      const receipt = await client!.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The transaction reverted.");
      setNotice({ kind: "good", text: done, tx: hash });
      await qc.invalidateQueries();
      return true;
    } catch (e) {
      setNotice({ kind: "bad", text: explain(e) });
      return false;
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    if (notice?.kind !== "good") return;
    const t = setTimeout(() => setNotice(null), 10_000);
    return () => clearTimeout(t);
  }, [notice]);

  // ---------------------------------------------------------------- funds
  const [fundMode, setFundMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  async function submitFunds() {
    if (!vault || !token.address || !address) return;
    let value: bigint;
    try {
      value = parseUnits(amount, token.decimals);
    } catch {
      return setNotice({ kind: "bad", text: "Enter an amount like 1 or 0.5." });
    }
    if (value <= 0n) return setNotice({ kind: "bad", text: "Enter an amount above zero." });
    if (fundMode === "withdraw") {
      const ok = await run("withdraw", () => writeContractAsync({ address: vault, abi: allowanceVaultAbi, functionName: "withdraw", args: [value], chainId }), `Withdrew ${amount} ${token.symbol}.`);
      if (ok) closeDrawer();
      return;
    }
    const allowance = await client!.readContract({ address: token.address, abi: erc20Abi, functionName: "allowance", args: [address, vault] });
    if (allowance < value) {
      const approved = await run("approve", () => writeContractAsync({ address: token.address!, abi: erc20Abi, functionName: "approve", args: [vault, value], chainId }), "Approved. Confirm the deposit next.");
      if (!approved) return;
    }
    const ok = await run("deposit", () => writeContractAsync({ address: vault, abi: allowanceVaultAbi, functionName: "deposit", args: [value], chainId }), `Deposited ${amount} ${token.symbol}.`);
    if (ok) closeDrawer();
  }

  // ---------------------------------------------------------------- identity
  const [uri, setUri] = useState("");
  async function register() {
    if (!identity) return;
    if (!/^(https?|ipfs):\/\/\S+$/.test(uri)) return setNotice({ kind: "bad", text: "Enter the agent card URL (https://… or ipfs://…)." });
    const ok = await run("register", () => writeContractAsync({ address: identity, abi: identityRegistryAbi, functionName: "register", args: [uri], chainId }), "Agent identity registered.");
    if (ok) {
      setUri("");
      setDrawer(null);
    }
  }

  // ---------------------------------------------------------------- grant
  const [agent, setAgent] = useState("");
  const [agentId, setAgentId] = useState("");
  const [perTx, setPerTx] = useState("");
  const [daily, setDaily] = useState("");
  const [hours, setHours] = useState("");
  const [payees, setPayees] = useState<string[]>([]);
  const [payeeDraft, setPayeeDraft] = useState("");
  const [payeeError, setPayeeError] = useState("");
  const [pqHash, setPqHash] = useState("");

  function addPayees(text: string) {
    const parts = text.split(/[\s,]+/).filter(Boolean);
    const bad = parts.find((p) => !isAddress(p));
    if (bad) return setPayeeError(`Not an address: ${short(bad)}`);
    setPayeeError("");
    setPayees((cur) => [...cur, ...parts.filter((p) => !cur.some((c) => c.toLowerCase() === p.toLowerCase()))]);
    setPayeeDraft("");
  }

  async function grant() {
    if (!vault) return;
    if (!isAddress(agent)) return setNotice({ kind: "bad", text: "The agent key must be an address (0x…, 40 hex characters)." });
    const id = agentId || (mine.data?.ids.at(-1)?.agentId.toString() ?? "");
    if (!/^\d+$/.test(id)) return setNotice({ kind: "bad", text: "Register an agent identity first, then pick it." });
    const sellers = payeeDraft ? [...payees, ...payeeDraft.split(/[\s,]+/).filter(Boolean)] : payees;
    const bad = sellers.find((p) => !isAddress(p));
    if (bad) return setNotice({ kind: "bad", text: `Not an address: ${bad}` });
    if (sellers.length === 0) return setNotice({ kind: "bad", text: "Add at least one seller this agent may pay." });
    if (pqHash && !(isHex(pqHash) && pqHash.length === 66)) return setNotice({ kind: "bad", text: "The PQ key hash must be 32 bytes of hex (0x + 64 characters), or empty." });
    let perTxV: bigint, dailyV: bigint;
    try {
      perTxV = parseUnits(perTx, token.decimals);
      dailyV = parseUnits(daily, token.decimals);
    } catch {
      return setNotice({ kind: "bad", text: "Limits must be amounts like 0.10." });
    }
    if (perTxV <= 0n || dailyV <= 0n) return setNotice({ kind: "bad", text: "Both limits must be above zero." });
    if (!(Number(hours) > 0)) return setNotice({ kind: "bad", text: "Enter how many hours the allowance lasts." });
    const expiry = BigInt(Math.floor(Date.now() / 1000) + Math.round(Number(hours) * 3600));
    const ok = await run(
      "grant",
      () =>
        writeContractAsync({
          address: vault,
          abi: allowanceVaultAbi,
          functionName: "grant",
          args: [agent as Address, BigInt(id), perTxV, dailyV, expiry, [...new Set(sellers)] as Address[], (pqHash || ZERO_HASH) as Hex],
          chainId,
        }),
      `Agent ${short(agent)} can now spend up to ${perTx} per payment and ${daily} per day.`,
    );
    if (ok) {
      setAgent("");
      setPerTx("");
      setDaily("");
      setHours("");
      setPayees([]);
      setPayeeDraft("");
      setPqHash("");
      setDrawer(null);
    }
  }

  async function revoke(a: Address) {
    if (!vault) return;
    await run(`revoke-${a}`, () => writeContractAsync({ address: vault, abi: allowanceVaultAbi, functionName: "revoke", args: [a], chainId }), `Agent ${short(a)} revoked. Its next payment will be refused.`);
  }

  // ---------------------------------------------------------------- render
  if (!vault || !identity) {
    return (
      <main className="shell">
        <div className="card empty">
          <strong>No vault configured for {net.label}</strong>
          <p>
            Deploy with <code>make deploy-{net.key}</code>, then run <code>make env NETWORK={net.key}</code>.
          </p>
        </div>
      </main>
    );
  }

  const blockReason = !isConnected ? "Connect a wallet to continue." : !onChain ? `Switch your wallet to ${net.label} to continue.` : null;
  const now = Date.now();
  const rows = (mine.data?.rows ?? []).map((r) => {
    const expiresMs = Number(r.grant.expiry) * 1000;
    const windowOpen = now / 1000 < Number(r.grant.windowStart) + 86400;
    const spent = windowOpen ? r.grant.spentInWindow : 0n;
    const status: "active" | "expiring" | "expired" | "revoked" = r.grant.revoked ? "revoked" : expiresMs <= now ? "expired" : expiresMs - now < 6 * 3600_000 ? "expiring" : "active";
    return { ...r, expiresMs, spent, status };
  });
  const live = rows.filter((r) => r.status === "active" || r.status === "expiring");
  const spentToday = live.reduce((a, r) => a + r.spent, 0n);
  const dailyTotal = live.reduce((a, r) => a + r.grant.dailyCap, 0n);
  const nextExpiry = live.length ? Math.min(...live.map((r) => r.expiresMs)) : null;
  const loading = isConnected && (mine.isLoading || vaultBal.data === undefined);
  const grantFirst = vaultBal.data !== undefined && vaultBal.data > 0n;
  const num = (v: bigint) => formatUnits(v, token.decimals);
  const pendingText: Record<string, string> = {
    approve: "Approving the token… confirm in your wallet.",
    deposit: "Depositing… waiting for confirmation.",
    withdraw: "Withdrawing… waiting for confirmation.",
    register: "Registering identity… waiting for confirmation.",
    grant: "Granting allowance… waiting for confirmation.",
  };
  const pending = busy ? (busy.startsWith("revoke-") ? "Revoking… waiting for confirmation." : pendingText[busy]) : null;

  return (
    <main className="shell">
      <section className="page-head">
        <div>
          <h1>Agents</h1>
          <p className="lede">Fund the vault, then give each agent key limits. Revoke takes effect in the next block.</p>
          <div className="meta">
            <span>Vault</span>
            <CopyValue value={vault} label="vault address" />
          </div>
        </div>
        <div className="actions">
          <button type="button" className={isConnected && !grantFirst ? "btn" : "btn secondary"} disabled={!isConnected} title={isConnected ? undefined : "Connect a wallet first"} onClick={() => setDrawer("funds")}>
            Fund vault
          </button>
          <button type="button" className="btn secondary" disabled={!isConnected} title={isConnected ? undefined : "Connect a wallet first"} onClick={() => setDrawer("identity")}>
            Register identity
          </button>
          <button type="button" className={isConnected && grantFirst ? "btn" : "btn secondary"} disabled={!isConnected} title={isConnected ? undefined : "Connect a wallet first"} onClick={() => setDrawer("grant")}>
            Grant allowance
          </button>
          {!isConnected && <p className="fine" style={{ flexBasis: "100%", textAlign: "right" }}>Connect a wallet to fund the vault or grant allowances.</p>}
        </div>
      </section>

      <section className="stats" aria-label="Summary">
        <Stat
          label="Vault balance"
          value={!isConnected ? "—" : vaultBal.data === undefined ? <Skeleton large /> : num(vaultBal.data)}
          unit={token.symbol}
          sub={!isConnected ? "Connect a wallet to see this" : walletBal.data !== undefined ? `Wallet holds ${fmt(walletBal.data)}` : undefined}
        />
        <Stat
          label="Spent today"
          value={!isConnected ? "—" : loading ? <Skeleton large /> : num(spentToday)}
          unit={token.symbol}
          sub={!isConnected ? "Connect a wallet to see this" : !loading ? (dailyTotal ? `of ${num(dailyTotal)} daily limits` : "No active limits") : undefined}
        />
        <Stat
          label="Active agents"
          value={!isConnected ? "—" : loading ? <Skeleton large /> : live.length}
          sub={!isConnected ? "Connect a wallet to see this" : !loading ? `${rows.length - live.length} revoked or expired` : undefined}
        />
        <Stat
          label="Next expiry"
          value={!isConnected ? "—" : loading ? <Skeleton large /> : nextExpiry ? timeLeft(nextExpiry / 1000).replace(" left", "") : "None"}
          sub={!isConnected ? "Connect a wallet to see this" : nextExpiry ? new Date(nextExpiry).toLocaleString() : undefined}
          warn={nextExpiry !== null && nextExpiry - now < 6 * 3600_000}
        />
      </section>

      <section className="card flush">
        <div className="card-head">
          <div>
            <h2>Allowances</h2>
            <p className="sub">Read from the chain every few seconds.</p>
          </div>
        </div>
        {!isConnected ? (
          <div className="empty">
            <AgentIcon />
            <strong>Connect a wallet to see your agents</strong>
            <p>Use Connect Wallet in the header. Agents you granted an allowance to are read from the vault with your address.</p>
          </div>
        ) : mine.error ? (
          <div className="empty">
            <strong>Couldn&apos;t read grants</strong>
            <p>{(mine.error as Error).message}</p>
          </div>
        ) : mine.isLoading ? (
          <div className="table-wrap">
            <table className="data" aria-busy="true">
              <tbody>
                {[0, 1, 2].map((i) => (
                  <tr key={i}>
                    {[0, 1, 2, 3, 4].map((j) => (
                      <td key={j}>
                        <Skeleton />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : rows.length === 0 ? (
          <div className="empty">
            <AgentIcon />
            <strong>No agents yet</strong>
            <p>An agent can pay only what you allow here: a limit per payment, a daily limit, chosen sellers and an expiry.</p>
            <button type="button" className="btn" onClick={() => setDrawer(grantFirst ? "grant" : "funds")}>
              {grantFirst ? "Grant your first allowance" : "Fund the vault to start"}
            </button>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th className="right">Per payment</th>
                  <th className="right">Per 24h</th>
                  <th>Used today</th>
                  <th>Expires</th>
                  <th>Status</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map(({ agent: a, grant: g, remaining, count, average, spent, status, expiresMs }) => {
                  const pct = g.dailyCap ? Number((spent * 100n) / g.dailyCap) : 0;
                  return (
                    <tr key={a}>
                      <td>
                        <CopyValue value={a} label="agent address" />
                        <div className="cell-sub">
                          #{g.agentId.toString()} · {count ? `${average}/100 from ${count}` : "unrated"} · {g.pqKeyHash === ZERO_HASH ? "no PQ key" : "PQ key"}
                        </div>
                      </td>
                      <td className="right mono">{num(g.perTxCap)}</td>
                      <td className="right mono">{num(g.dailyCap)}</td>
                      <td>
                        <div className={`meter ${pct >= 100 ? "full" : ""}`} title={`${num(remaining)} left`}>
                          <span style={{ width: `${Math.min(pct, 100)}%` }} />
                        </div>
                        <span className="cell-sub mono">
                          {num(spent)} / {num(g.dailyCap)}
                        </span>
                      </td>
                      <td>
                        {status === "revoked" ? <span className="fine">—</span> : (
                          <>
                            {timeLeft(expiresMs / 1000)}
                            <div className="cell-sub">{new Date(expiresMs).toLocaleDateString()}</div>
                          </>
                        )}
                      </td>
                      <td>
                        <span className={`status-pill ${status === "active" ? "good" : status === "revoked" ? "bad" : "warn"}`}>{status[0].toUpperCase() + status.slice(1)}</span>
                      </td>
                      <td className="right">
                        {status !== "revoked" && g.owner !== ZERO && (
                          <button type="button" className="btn warn small" disabled={!onChain || Boolean(busy)} title={blockReason ?? undefined} onClick={() => revoke(a)}>
                            {busy === `revoke-${a}` ? "Revoking…" : "Revoke"}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Drawer
        open={drawer === "funds"}
        onClose={closeDrawer}
        title="Fund vault"
        subtitle="Agents spend from the vault, never from your wallet."
        footer={
          <>
            {blockReason && <p className="fine">{blockReason}</p>}
            <div className="actions">
              <button type="button" className="btn secondary" onClick={closeDrawer}>
                Cancel
              </button>
              <button type="button" className="btn" disabled={Boolean(blockReason) || Boolean(busy)} onClick={submitFunds}>
                {busy === "approve" ? "Approving…" : busy === "deposit" ? "Depositing…" : busy === "withdraw" ? "Withdrawing…" : fundMode === "deposit" ? "Deposit" : "Withdraw"}
              </button>
            </div>
          </>
        }
      >
        <div className="segmented" role="group" aria-label="Action">
          <button type="button" aria-pressed={fundMode === "deposit"} onClick={() => setFundMode("deposit")}>
            Deposit
          </button>
          <button type="button" aria-pressed={fundMode === "withdraw"} onClick={() => setFundMode("withdraw")}>
            Withdraw
          </button>
        </div>
        <dl className="balances">
          <div>
            <dt>Wallet</dt>
            <dd>{walletBal.data !== undefined ? fmt(walletBal.data) : "—"}</dd>
          </div>
          <div>
            <dt>Vault</dt>
            <dd>{vaultBal.data !== undefined ? fmt(vaultBal.data) : "—"}</dd>
          </div>
        </dl>
        <label className="lbl">
          Amount
          <div className="input-wrap">
            <input className="field" inputMode="decimal" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
            <span className="suffix">{token.symbol}</span>
          </div>
          <span className="hint">{fundMode === "deposit" ? "Needs one approval, then the deposit." : "Moves unspent funds back to your wallet."}</span>
        </label>
      </Drawer>

      <Drawer
        open={drawer === "identity"}
        onClose={closeDrawer}
        title="Register agent identity"
        subtitle="An ERC-8004 style identity token. Sellers see its reputation, built only from payments it really made."
        footer={
          <>
            {blockReason && <p className="fine">{blockReason}</p>}
            <div className="actions">
              <button type="button" className="btn secondary" onClick={closeDrawer}>
                Cancel
              </button>
              <button type="button" className="btn" disabled={Boolean(blockReason) || Boolean(busy)} onClick={register}>
                {busy === "register" ? "Registering…" : "Register identity"}
              </button>
            </div>
          </>
        }
      >
        <label className="lbl">
          Agent card URL
          <input className="field mono" placeholder="https://example.com/agents/my-agent.json" value={uri} onChange={(e) => setUri(e.target.value.trim())} />
          <span className="hint">A JSON file describing the agent: name, description, endpoints.</span>
        </label>
        {mine.data && mine.data.ids.length > 0 && (
          <div>
            <p className="stat-label">Your identities</p>
            <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
              {mine.data.ids.map((i) => (
                <li key={i.agentId.toString()} className="fine">
                  <span className="mono">#{i.agentId.toString()}</span> {i.uri}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Drawer>

      <Drawer
        open={drawer === "grant"}
        onClose={closeDrawer}
        title="Grant allowance"
        subtitle="The agent key is the address your agent signs with. It needs no gas: the seller submits its signed payments."
        footer={
          <>
            {blockReason && <p className="fine">{blockReason}</p>}
            <div className="actions">
              <button type="button" className="btn secondary" onClick={closeDrawer}>
                Cancel
              </button>
              <button type="button" className="btn" disabled={Boolean(blockReason) || Boolean(busy)} onClick={grant}>
                {busy === "grant" ? "Granting…" : "Grant allowance"}
              </button>
            </div>
          </>
        }
      >
        <div className="form-grid">
          <label className="lbl full">
            Agent key
            <input className="field mono" placeholder="0x…" value={agent} onChange={(e) => setAgent(e.target.value.trim())} />
          </label>
          <label className="lbl full">
            Identity
            {mine.data?.ids.length ? (
              <select className="field" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                <option value="">Latest (#{mine.data.ids.at(-1)!.agentId.toString()})</option>
                {mine.data.ids.map((i) => (
                  <option key={i.agentId.toString()} value={i.agentId.toString()}>
                    #{i.agentId.toString()}
                  </option>
                ))}
              </select>
            ) : (
              <span className="hint">
                None yet.{" "}
                <button type="button" className="copy" onClick={() => setDrawer("identity")}>
                  Register one first
                </button>
              </span>
            )}
          </label>
          <label className="lbl">
            Max per payment
            <div className="input-wrap">
              <input className="field" inputMode="decimal" placeholder="0.10" value={perTx} onChange={(e) => setPerTx(e.target.value)} />
              <span className="suffix">{token.symbol}</span>
            </div>
          </label>
          <label className="lbl">
            Max per 24h
            <div className="input-wrap">
              <input className="field" inputMode="decimal" placeholder="0.25" value={daily} onChange={(e) => setDaily(e.target.value)} />
              <span className="suffix">{token.symbol}</span>
            </div>
          </label>
          <label className="lbl full">
            Expires in
            <div className="input-wrap">
              <input className="field" inputMode="numeric" placeholder="24" value={hours} onChange={(e) => setHours(e.target.value)} />
              <span className="suffix">hours</span>
            </div>
          </label>
          <div className="lbl full">
            <label htmlFor="payee-input">Allowed sellers</label>
            <div className="chips">
              {payees.map((p) => (
                <span className="chip-tag" key={p}>
                  {short(p)}
                  <button type="button" aria-label={`Remove ${p}`} onClick={() => setPayees((cur) => cur.filter((c) => c !== p))}>
                    ×
                  </button>
                </span>
              ))}
              <input
                id="payee-input"
                placeholder={payees.length ? "" : "Paste an address, press Enter"}
                value={payeeDraft}
                onChange={(e) => {
                  setPayeeDraft(e.target.value.trim());
                  setPayeeError("");
                }}
                onKeyDown={(e) => {
                  if ((e.key === "Enter" || e.key === ",") && payeeDraft) {
                    e.preventDefault();
                    addPayees(payeeDraft);
                  } else if (e.key === "Backspace" && !payeeDraft) setPayees((cur) => cur.slice(0, -1));
                }}
                onPaste={(e) => {
                  const text = e.clipboardData.getData("text");
                  if (/[\s,]/.test(text.trim())) {
                    e.preventDefault();
                    addPayees(text);
                  }
                }}
                onBlur={() => payeeDraft && addPayees(payeeDraft)}
              />
            </div>
            {payeeError ? (
              <span className="hint bad">{payeeError}</span>
            ) : seller.data && !payees.some((p) => p.toLowerCase() === seller.data!.payee.toLowerCase()) ? (
              <span className="hint">
                <button type="button" className="copy" onClick={() => addPayees(seller.data!.payee)}>
                  + Add demo seller <span className="mono">{short(seller.data.payee)}</span>
                </button>
                {seller.data.basePriceLabel} per call
              </span>
            ) : null}
          </div>
          <label className="lbl full">
            <span>
              Post-quantum key hash <span className="hint">optional</span>
            </span>
            <input className="field mono" placeholder="0x… keccak256 of the agent's ML-DSA-65 key" value={pqHash} onChange={(e) => setPqHash(e.target.value.trim())} />
            <span className="hint">Printed by <code>pnpm agent whoami</code>.</span>
          </label>
        </div>
      </Drawer>

      <div className="toasts" aria-live="polite">
        {pending && (
          <div className="toast pending" role="status">
            <span className="spinner" aria-hidden="true" />
            <div className="toast-body">{pending}</div>
          </div>
        )}
        {notice && (
          <div className={`toast ${notice.kind}`} role={notice.kind === "bad" ? "alert" : "status"}>
            <div className="toast-body">
              {notice.text}
              {notice.tx && (net.hasExplorer ? (
                <>
                  <br />
                  <a href={txUrl(notice.tx)} target="_blank" rel="noreferrer">
                    View transaction {short(notice.tx)}
                  </a>
                </>
              ) : (
                <>
                  <br />
                  <span className="mono">tx {short(notice.tx)}</span>
                </>
              ))}
            </div>
            <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => setNotice(null)}>
              ×
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

const AgentIcon = () => (
  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="4" y="8" width="16" height="11" rx="2" />
    <path d="M12 8V5M9 13h.01M15 13h.01M9 16h6" />
    <circle cx="12" cy="4" r="1" />
  </svg>
);
