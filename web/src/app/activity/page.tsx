"use client";

import { allowanceVaultAbi, getLogsChunked, reputationRegistryAbi, txUrl } from "@aevum-kit/aevum";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { formatUnits, getAbiItem, type Hex, type PublicClient } from "viem";
import { useAccount, usePublicClient } from "wagmi";
import { Skeleton, Stat } from "@/components/ui";
import { useToken } from "@/components/useToken";
import { short } from "@/lib/format";
import { useNetwork } from "@/lib/network";

const WINDOWS = [
  { blocks: 1_000n, label: "1k blocks" },
  { blocks: 5_000n, label: "5k blocks" },
  { blocks: 20_000n, label: "20k blocks" },
];

const KIND = {
  spent: { label: "Payment", tone: "good" },
  granted: { label: "Grant", tone: "neutral" },
  revoked: { label: "Revoke", tone: "bad" },
  feedback: { label: "Rating", tone: "neutral" },
} as const;

type Row = {
  kind: "spent" | "feedback" | "revoked" | "granted";
  block: bigint;
  logIndex: number;
  tx: Hex;
  who: string;
  detail: string;
  amount?: bigint;
};

/** Audit trail: every payment, rating, grant and revoke, read from the chain in 1,000-block chunks. */
export default function ActivityPage() {
  const { net } = useNetwork();
  const chainId = net.chain.id;
  const client = usePublicClient({ chainId }) as PublicClient | undefined;
  const { address } = useAccount();
  const token = useToken();
  const [windowSize, setWindowSize] = useState(5_000n);
  const [onlyMine, setOnlyMine] = useState(false);
  const [progress, setProgress] = useState(0);

  const logs = useQuery({
    queryKey: ["activity", chainId, net.vault, net.reputation, windowSize.toString(), onlyMine ? address : null],
    enabled: Boolean(client && net.vault),
    refetchInterval: 10_000,
    queryFn: async () => {
      const head = await client!.getBlockNumber();
      let from = head > windowSize ? head - windowSize + 1n : 0n;
      if (net.deployBlock !== undefined && net.deployBlock > from) from = net.deployBlock;
      setProgress(0);
      const owner = onlyMine && address ? address : undefined;
      const onProgress = (done: bigint, total: bigint) => setProgress(total ? Number((done * 100n) / total) : 100);
      const [spent, granted, revoked] = await Promise.all([
        getLogsChunked(client!, { address: net.vault!, event: getAbiItem({ abi: allowanceVaultAbi, name: "Spent" }), fromBlock: from, toBlock: head, onProgress }),
        getLogsChunked(client!, { address: net.vault!, event: getAbiItem({ abi: allowanceVaultAbi, name: "Granted" }), args: owner ? { owner } : undefined, fromBlock: from, toBlock: head }),
        getLogsChunked(client!, { address: net.vault!, event: getAbiItem({ abi: allowanceVaultAbi, name: "Revoked" }), args: owner ? { owner } : undefined, fromBlock: from, toBlock: head }),
      ]);
      const feedback = net.reputation
        ? await getLogsChunked(client!, { address: net.reputation, event: getAbiItem({ abi: reputationRegistryAbi, name: "NewFeedback" }), fromBlock: from, toBlock: head })
        : [];
      const rows: Row[] = [
        ...spent
          .filter((l) => !owner || l.args.owner?.toLowerCase() === owner.toLowerCase())
          .map((l) => ({
            kind: "spent" as const,
            block: l.blockNumber!,
            logIndex: l.logIndex!,
            tx: l.transactionHash!,
            who: `agent ${short(l.args.agent!)} → ${short(l.args.payee!)}`,
            detail: `identity #${l.args.agentId}, quote ${short(l.args.ref!)}`,
            amount: l.args.amount,
          })),
        ...granted.map((l) => ({
          kind: "granted" as const,
          block: l.blockNumber!,
          logIndex: l.logIndex!,
          tx: l.transactionHash!,
          who: `owner ${short(l.args.owner!)} → agent ${short(l.args.agent!)}`,
          detail: `max ${formatUnits(l.args.perTxCap!, token.decimals)} per payment, ${formatUnits(l.args.dailyCap!, token.decimals)} per day`,
        })),
        ...revoked.map((l) => ({
          kind: "revoked" as const,
          block: l.blockNumber!,
          logIndex: l.logIndex!,
          tx: l.transactionHash!,
          who: `owner ${short(l.args.owner!)}`,
          detail: `revoked agent ${short(l.args.agent!)}`,
        })),
        ...feedback.map((l) => ({
          kind: "feedback" as const,
          block: l.blockNumber!,
          logIndex: l.logIndex!,
          tx: l.transactionHash!,
          who: `seller ${short(l.args.payee!)}`,
          detail: `rated identity #${l.args.agentId} ${l.args.score}/100 (${l.args.tag || "no tag"})`,
        })),
      ].sort((a, b) => (a.block === b.block ? b.logIndex - a.logIndex : a.block > b.block ? -1 : 1));
      const total = rows.reduce((s, r) => s + (r.amount ?? 0n), 0n);
      return { from, head, rows, total, payments: rows.filter((r) => r.kind === "spent").length };
    },
  });

  return (
    <main className="shell">
      <div className="page-head">
        <div>
          <h1>Activity</h1>
          <p className="lede">Payments, grants, revokes and seller ratings from the vault. Each payment names the quote it paid for.</p>
        </div>
      </div>

      <section className="stats" aria-label="Summary">
        <Stat label="Agent payments" value={logs.data ? logs.data.payments : <Skeleton large />} sub={logs.data ? `up to block ${logs.data.head}` : "Reading the chain"} />
        <Stat label="Total paid" value={logs.data ? formatUnits(logs.data.total, token.decimals) : <Skeleton large />} unit={logs.data ? token.symbol : undefined} />
      </section>

      {!net.vault ? (
        <div className="card empty">
          <strong>No vault configured for {net.label}</strong>
          <p>
            Run <code>make env NETWORK={net.key}</code> after deploying.
          </p>
        </div>
      ) : (
        <section className="card flush">
          <div className="toolbar">
            <span className="fine">Scan the last</span>
            <div className="segmented" role="group" aria-label="How many blocks to scan">
              {WINDOWS.map((w) => (
                <button key={w.label} type="button" aria-pressed={windowSize === w.blocks} onClick={() => setWindowSize(w.blocks)}>
                  {w.label}
                </button>
              ))}
            </div>
            <label className="toggle">
              <input type="checkbox" checked={onlyMine} disabled={!address} onChange={(e) => setOnlyMine(e.target.checked)} />
              Only my vault
            </label>
          </div>

          {logs.isFetching && !logs.data && (
            <div style={{ padding: "18px 24px" }} aria-live="polite">
              <div className="progress" role="progressbar" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${progress}%` }} />
              </div>
              <p className="fine" style={{ marginTop: 8 }}>
                Scanning {windowSize.toLocaleString("en-US")} blocks, 1,000 at a time… {progress}%
              </p>
              <table className="data" aria-busy="true" style={{ marginTop: 16 }}>
                <tbody>
                  {[0, 1, 2, 3].map((i) => (
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
          )}
          {logs.error && (
            <div className="empty">
              <strong>Couldn&apos;t read events</strong>
              <p>{(logs.error as Error).message}</p>
            </div>
          )}
          {logs.data && logs.data.rows.length === 0 && (
            <div className="empty">
              <strong>No activity in this range</strong>
              <p>
                Blocks {logs.data.from.toString()} to {logs.data.head.toString()} have no payments, grants or revokes. Scan more blocks, or grant an agent on the Agents page.
              </p>
            </div>
          )}
          {logs.data && logs.data.rows.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Who</th>
                    <th>Detail</th>
                    <th className="right">Amount</th>
                    <th className="right">Block</th>
                    <th>Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.data.rows.map((r) => (
                    <tr key={`${r.tx}-${r.logIndex}`}>
                      <td>
                        <span className={`status-pill ${KIND[r.kind].tone}`}>{KIND[r.kind].label}</span>
                      </td>
                      <td className="mono">{r.who}</td>
                      <td>{r.detail}</td>
                      <td className="right num">{r.amount !== undefined ? `${formatUnits(r.amount, token.decimals)} ${token.symbol}` : ""}</td>
                      <td className="right num">{r.block.toString()}</td>
                      <td>
                        {net.hasExplorer ? (
                          <a href={txUrl(r.tx)} target="_blank" rel="noreferrer">
                            {short(r.tx)}
                          </a>
                        ) : (
                          <span className="mono">{short(r.tx)}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
