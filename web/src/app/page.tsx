"use client";

import { links, TUSD8_ADDRESS, erc20Abi } from "@aevum-kit/aevum";
import Link from "next/link";
import { formatEther, formatUnits } from "viem";
import { useAccount, useBalance, useBytecode, useReadContract, useWatchAsset } from "wagmi";
import { CheckIcon, CrossIcon, WarnIcon } from "@/components/Icons";
import { useToken } from "@/components/useToken";
import { useNetwork } from "@/lib/network";
import { short } from "@/lib/format";

type Status = "ok" | "warn" | "bad" | "idle";
interface Check {
  title: string;
  status: Status;
  value: string;
  detail: string;
  action?: { label: string; href?: string; onClick?: () => void };
}

const DISCORD_FAUCET = "Verify in the QDay Discord, then run /faucet <your address> (1 tQDAY + 5 tUSD8, once). See the README for the steps.";

// Shown on a fork, where balances surprise people: they are the real testnet balances.
const FORK_COPY = "Copied from Aevum testnet when the fork started. Spending it here doesn't touch the real testnet.";

export default function SetupPage() {
  const { net, select } = useNetwork();
  const appChain = net.chain;
  const chainMode = net.key;
  const vaultAddress = net.vault;
  const { address, isConnected, chainId, connector } = useAccount();
  const onChain = isConnected && chainId === appChain.id;
  const token = useToken();

  const gas = useBalance({ address, chainId: appChain.id, query: { enabled: onChain } });
  const tokenBal = useReadContract({
    address: token.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: address ? [address] : undefined,
    chainId: appChain.id,
    query: { enabled: onChain && Boolean(token.address) },
  });
  const code = useBytecode({ address: vaultAddress, chainId: appChain.id, query: { enabled: Boolean(vaultAddress) } });

  // Wallets don't list tokens on custom networks by themselves. This asks the wallet to show it
  // on the network it is on now (the app's network, since the button only shows when onChain).
  const { watchAsset } = useWatchAsset();
  const addToken =
    onChain && token.address
      ? {
          label: `Add ${token.symbol} to wallet`,
          onClick: () =>
            watchAsset({ type: "ERC20", options: { address: token.address!, symbol: token.symbol, decimals: token.decimals } }),
        }
      : undefined;

  const gasValue = gas.data?.value;
  const tokenValue = tokenBal.data;

  const checks: Check[] = [
    isConnected
      ? { title: "Wallet connected", status: "ok", value: short(address ?? ""), detail: `${connector?.name ?? "Wallet"} is connected.` }
      : { title: "Wallet connected", status: "bad", value: "not connected", detail: "Use the Connect wallet button in the header. MetaMask, Rabby and other browser wallets work." },
    !isConnected
      ? { title: "Network", status: "idle", value: "waiting for wallet", detail: `Needs ${appChain.name} (${appChain.id}).` }
      : onChain
        ? { title: "Network", status: "ok", value: `chain ${appChain.id}`, detail: `Connected to ${appChain.rpcUrls.default.http[0]}.` }
        : {
            title: "Network",
            status: "bad",
            value: `chain ${chainId}`,
            detail: `Switch to ${appChain.name} (${appChain.id}). Your wallet will offer to add it.`,
            action: { label: "Switch network", onClick: () => select(net.key) },
          },
    !onChain || gasValue === undefined
      ? { title: `Gas (${appChain.nativeCurrency.symbol})`, status: "idle", value: "waiting for wallet", detail: "Pays for transactions. Agents paying by signature don't need it; owners do." }
      : gasValue > 0n
        ? { title: `Gas (${appChain.nativeCurrency.symbol})`, status: "ok", value: `${Number(formatEther(gasValue)).toFixed(4)} ${appChain.nativeCurrency.symbol}`, detail: chainMode === "fork" ? FORK_COPY : "1 tQDAY covers hundreds of contract calls at 1 gwei." }
        : chainMode === "aevum"
          ? { title: "Gas (tQDAY)", status: "warn", value: "0 tQDAY", detail: DISCORD_FAUCET, action: { label: "Open web faucet", href: links.faucetWeb } }
          : { title: "Gas", status: "warn", value: "0", detail: chainMode === "fork" ? "Give yourself tQDAY and tUSD8 with `make deal TO=<address>`." : "Import one of anvil's default accounts into your wallet (local chain only)." },
    !onChain || tokenValue === undefined
      ? { title: `${token.symbol} balance`, status: "idle", value: "waiting for wallet", detail: "The stablecoin the vault holds (6 decimals)." }
      : tokenValue > 0n
        ? { title: `${token.symbol} balance`, status: "ok", value: `${formatUnits(tokenValue, token.decimals)} ${token.symbol}`, detail: chainMode === "fork" ? "Ready to pay. Also copied from Aevum testnet." : "Ready to pay.", action: addToken }
        : chainMode === "aevum"
          ? { title: "tUSD8 balance", status: "warn", value: "0 tUSD8", detail: DISCORD_FAUCET, action: addToken }
          : { title: `${token.symbol} balance`, status: "warn", value: "0", detail: chainMode === "fork" ? "On a fork, give yourself tUSD8 with `make deal TO=<address>`." : "MockUSD8 lets anyone mint: `make mint TO=<address>`.", action: addToken },
    !vaultAddress
      ? { title: "AllowanceVault", status: "warn", value: "not set", detail: chainMode === "aevum" ? "Deploy with `make deploy-aevum`, then `make env NETWORK=aevum` writes the addresses to web/.env.local." : chainMode === "fork" ? "Deploy with `make deploy-fork`, then `make env NETWORK=fork`." : "Deploy with `make deploy-local`, then `make env NETWORK=local`." }
      : code.isLoading
        ? { title: "AllowanceVault", status: "idle", value: short(vaultAddress), detail: "Looking it up…" }
        : code.data && code.data !== "0x"
          ? { title: "AllowanceVault", status: "ok", value: short(vaultAddress), detail: "Deployed and reachable." }
          : { title: "AllowanceVault", status: "bad", value: short(vaultAddress), detail: `No contract at this address on ${appChain.name}. Check NEXT_PUBLIC_VAULT_* in web/.env.local.` },
  ];

  const passed = checks.filter((c) => c.status === "ok").length;
  const left = checks.length - passed;

  return (
    <main className="shell">
      <section className="page-head">
        <div>
          <h1>Setup</h1>
          <p className="lede">
            {passed} of {checks.length} checks passed on {appChain.name} (chain {appChain.id}). {left ? `${left} left to fix.` : "Ready to use."}
          </p>
        </div>
        <Link className={left ? "btn secondary" : "btn"} href="/vault">
          Go to agents
        </Link>
      </section>

      <section className="grid-2" aria-label="Checks">
        <div className="card flush">
          {checks.map((c) => (
            <div className="check" key={c.title}>
              <div className={`chip ${c.status}`}>
                {c.status === "ok" ? <CheckIcon /> : c.status === "bad" ? <CrossIcon /> : c.status === "warn" ? <WarnIcon /> : null}
              </div>
              <div className="check-body">
                <div className="check-top">
                  <span className="check-title">{c.title}</span>
                  <span className={`check-value ${c.status === "ok" ? "" : c.status}`}>{c.value}</span>
                </div>
                <p className="check-detail">{c.detail}</p>
                {c.action && (
                  <div className="check-action">
                    {c.action.href ? (
                      <a className="btn small" href={c.action.href} target="_blank" rel="noreferrer">
                        {c.action.label}
                      </a>
                    ) : (
                      <button type="button" className="btn small" onClick={c.action.onClick}>
                        {c.action.label}
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="stack">
          <div className="card">
            <h2>Network details</h2>
            <p className="sub">
              {chainMode === "fork" && " Balances start as a copy of Aevum testnet; what you spend here stays on your machine."}
            </p>
            <dl className="kv">
              <dt>Name</dt>
              <dd>{appChain.name}</dd>
              <dt>Chain ID</dt>
              <dd>{appChain.id}</dd>
              <dt>RPC</dt>
              <dd className="mono">{appChain.rpcUrls.default.http[0]}</dd>
              <dt>Explorer</dt>
              <dd>{net.hasExplorer ? links.explorer.replace("https://", "") : "none (local chain)"}</dd>
              <dt>tUSD8</dt>
              <dd>{chainMode === "local" ? "MockUSD8 (local)" : <><span className="mono">{short(TUSD8_ADDRESS)}</span>, 6 decimals</>}</dd>
              <dt>EVM</dt>
              <dd>shanghai</dd>
            </dl>
            {isConnected && !onChain && (
              <button type="button" className="btn secondary block" style={{ marginTop: 16 }} onClick={() => select(net.key)}>
                Add {appChain.name} to wallet
              </button>
            )}
          </div>

          <details className="card info">
            <summary>Developer notes: how Aevum differs from Ethereum</summary>
            <ul>
              <li>
                Compile with <code>evm_version = &quot;shanghai&quot;</code>. Cancun builds deploy, then fail with <em>invalid opcode: MCOPY</em>.
              </li>
              <li>
                <code>eth_getLogs</code> accepts at most 1,000 blocks per call. Use <code>getLogsChunked</code> from the kit.
              </li>
              <li>No WebSocket RPC. Poll over HTTPS.</li>
            </ul>
          </details>
        </div>
      </section>
    </main>
  );
}
