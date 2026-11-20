# Agent Allowance Vault

Give an AI agent a tUSD8 budget on **QDay Aevum testnet**, not your keys.

An owner funds a vault once and gives each agent key a per-payment limit, a 24-hour limit, a list of sellers it may pay, an expiry and an instant revoke. The agent pays for APIs per request by signing; it holds no tokens and no gas. Sellers settle each payment on Aevum, deliver exactly once per payment, and build the agent's reputation from real, paid receipts. Each grant can also commit to the agent's ML-DSA-65 (post-quantum) key, and the seller checks a hybrid ECDSA + ML-DSA-65 signature on every payment.

Built for the [Aevum Builder Challenge #1](https://dorahacks.io/hackathon/qday/detail), track **Native AI Assistants**.

## Logo

![Agent Allowance Vault logo](docs/logo.svg.png)

Vector files: [logo](web/public/logo.svg), [square mark](web/public/logo-mark.svg). The app uses the mark in the header and browser tab.

## The problem

Letting an agent pay today means one of two bad options:

- give it a funded private key, so one bug, prompt injection or leak can drain everything; or
- approve every payment by hand, which defeats the point of an agent.

Sellers have the opposite problem: an anonymous address pays them, with no way to tell a trustworthy agent from a fresh throwaway, and no shared record of what each payment bought.

## How it works

```
 Owner (browser wallet)                              Seller (this repo's web app)
   │ deposit tUSD8, register identity,                 /api/paid/summarize
   │ grant(agent, caps, payees, expiry, pqKeyHash)       │
   ▼                                                     │
┌──────────────────── Aevum testnet (44005) ─────────────┼──────────────────────┐
│ IdentityRegistry   ERC-721 agent identity (ERC-8004 style)                    │
│ AllowanceVault     balances, grants, spend / spendWithSig, receipts per quote │
│ ReputationRegistry feedback only from a payee holding a receipt               │
└────────────────────────────────────────────────────────▲──────────────────────┘
                                                          │ spendWithSig (seller pays gas)
 Agent (examples/src/agent.ts, holds no gas)              │
   1. POST /api/paid/summarize  ──────────────────────▶  402 + quote {payee, amount, ref, deadline}
   2. checks the quote against its own MAX_PRICE
   3. signs EIP-712 Spend (ECDSA) + the same digest with ML-DSA-65
   4. POST again with X-Payment  ─────────────────────▶  verify sigs, simulate, settle, check receipt
                                 ◀─────────────────────  200 result + X-Payment-Response {txHash}
                                                          then giveFeedback(ref, 100)
```

### Contracts (`contracts/src`)

| Contract | What it does |
|---|---|
| `AllowanceVault` | Owner balances in tUSD8. `grant` sets per-payment cap, 24h cap, payee allowlist, expiry and an optional ML-DSA-65 key hash for an agent key. `spend` (agent sends the tx) or `spendWithSig` (anyone submits the agent's EIP-712 signature). Every payment is keyed by `(payee, ref)`, paid once, and stored as a receipt. `revoke` works in the next block. Deposits by `approve` + `deposit` or one EIP-3009 signature (`depositWithAuthorization`). |
| `IdentityRegistry` | ERC-721 agent identities with a `tokenURI` for the agent card, in the style of the ERC-8004 Identity Registry. Aevum has no ERC-8004 deployment yet, so the app ships its own. A grant must reference an identity its owner holds. |
| `ReputationRegistry` | ERC-8004-style feedback with one rule added: only a payee that holds a vault receipt for that `ref` can rate, once. Reputation cannot be farmed with fake reviews. |

### Safety and controls

- **Least privilege per agent key**: caps, payee allowlist and expiry are enforced on chain, not by the agent's code.
- **Revoke** takes effect in the next block; the seller also refuses to quote a revoked or expired agent.
- **Exactly-once delivery**: the seller's `ref` is unguessable and bound to the quote and the request body. The vault pays a `(payee, ref)` once, so a retry or a replayed signature never charges twice; the seller returns the stored result. A ref is scoped per payee, so nobody can squat another seller's ref.
- **Verifiable receipts**: before delivering, the seller reads `receiptOf(payee, ref)` and checks agent and amount on chain.
- **No gas on the agent**: agents only sign. The seller simulates first, so a capped, revoked or expired payment costs nothing.
- **Agent-side guardrail**: the agent refuses quotes above its own `MAX_PRICE`, and stops (does not retry around) when the owner's policy says no.
- **Plain-language errors** for every revert (`OverDailyCap` becomes "Daily limit reached: this payment needs 0.04 tUSD8 but only 0.02 tUSD8 is left today.").
- **Audit trail**: grants, payments, revokes and ratings are events; the Activity page reads them in 1,000-block chunks.
- **Seller hardening** (from the starter kit's relayer): refuses public anvil keys on Aevum, rate-limits quotes per agent, caps memory use.

### Post-quantum: what is real and what is not

QDay's ML-DSA-65 verify precompile arrives in Phase 2 (Aevum Q2 2027), so a contract cannot check an ML-DSA signature today. This project does what is possible now:

- the agent's ML-DSA-65 key is derived from its ECDSA key (one secret backs both, like QDay's one-mnemonic plan);
- the grant commits `keccak256(publicKey)` on chain (`pqKeyHash`), and the owner can rotate it (`rotatePqKey`);
- the agent signs the same EIP-712 digest with both keys; the seller refuses the payment unless the ML-DSA-65 signature verifies and the key matches the on-chain hash.

So the PQ check is enforced by the seller, off chain, against an on-chain commitment. When the precompile ships, the same check moves into `spendWithSig`. This matches QDay's planned hybrid ECDSA + ML-DSA-65 agent keys.

## Run it locally (5 minutes, no funds)

You need Node 22+, pnpm and Foundry.

```bash
make install          # Solidity libs + JS packages
make check            # build, Shanghai check, ABIs, 30 unit tests, 2 fork tests, typecheck

make fork             # terminal 1: local copy of Aevum (chain 440050) with the real tUSD8
make deploy-fork      # terminal 2: deploys the 3 contracts, writes deployments/440050.json
make env NETWORK=fork # prints the NEXT_PUBLIC_* lines
```

Put the printed lines in `web/.env.local`, plus:

```
NEXT_PUBLIC_NETWORKS=fork
SELLER_NETWORK=fork
SELLER_PRIVATE_KEY=<a test key; on the fork an anvil key is fine>
PRICE_PER_CALL=0.05
```

Then:

```bash
make dev                                   # web app + seller on http://localhost:3000
make deal TO=<owner address> AMOUNT=10     # fork only: test tUSD8 + gas

cd examples
export AGENT_KEY=0x<fresh random key>      # the agent: no tokens, no gas
export OWNER_KEY=0x<owner key>             # or use the Vault page with a browser wallet
export RPC_URL=http://127.0.0.1:8555 SELLER_URL=http://localhost:3000
pnpm agent whoami                          # agent address + ML-DSA-65 key hash
PQ=1 pnpm owner setup                      # register identity, deposit 1, grant 0.10 / 0.25 per day
pnpm agent demo                            # paid calls, safe retry, reputation discount, cap stop
pnpm pq-check                              # missing / wrong / foreign PQ signatures are refused
pnpm owner revoke && pnpm agent once "hi"  # refused at once
```

### Result of a real run (local fork, 2026-11-16)

```
quote ae83bce7: 0.05 tUSD8 · PQ signature required
resent the same payment → HTTP 200, replay=true, same tx=true. Charged once.
✓ #1 paid 0.05 tUSD8
✓ #2 paid 0.05 tUSD8
✓ #3 paid 0.05 tUSD8
quote 1313578c: 0.04 tUSD8 (20% reputation discount, 3 ratings avg 100) · PQ signature required
✓ #4 paid 0.04 tUSD8
✓ #5 paid 0.04 tUSD8
✗ #6 refused (OverDailyCap): Daily limit reached: this payment needs 0.04 tUSD8 but only 0.02 tUSD8 is left today.
Stopping: the owner's policy says no. The agent does not try to work around it.
```

The agent's gas balance stayed at 0 throughout.

## Deploy to Aevum testnet

```bash
cast wallet import aevum-deployer --interactive   # a TEST wallet only
make deploy-aevum ACCOUNT=aevum-deployer          # writes deployments/44005.json
make env NETWORK=aevum                            # NEXT_PUBLIC_* lines for web/.env.local
```

Fund wallets from the QDay Discord faucet (`/faucet <address>`: 1 tQDAY + 5 tUSD8, once). The seller key needs a little tQDAY for gas; the agent key needs nothing. Keep amounts in cents: 5 tUSD8 is enough for about 100 paid calls.

### Aevum deployment (live, 2026-11-17)

Deployed at block 3366555 from `0x6d691d7513E89A088642432DA591f609Ef7E11f2`. Source: this repo at the deployed commit (link added on submission). The explorer verifier is not working yet, so the source is not verified there.

| Contract | Address | Deploy tx |
|---|---|---|
| AllowanceVault | [`0x2F0b6847369C4E3f02571B1b44576Eb7d34Ce6f0`](https://explorer-test.qday.info/address/0x2F0b6847369C4E3f02571B1b44576Eb7d34Ce6f0) | [`0xee2c1207…`](https://explorer-test.qday.info/tx/0xee2c1207c8d6961c6026be105b9bddfc4bbdc86e8a5490946db9c2afbb466462) |
| IdentityRegistry | [`0xfD48bBbDFe36F4179dE8AEE3d45D4080E74D738e`](https://explorer-test.qday.info/address/0xfD48bBbDFe36F4179dE8AEE3d45D4080E74D738e) | [`0x73580c6d…`](https://explorer-test.qday.info/tx/0x73580c6de919007e48080868b4095fdbf1e9b120cdcfb906fd31186a30b3d8c4) |
| ReputationRegistry | [`0xDa6111F272E94e253a1485705B4ad31DF846CfFf`](https://explorer-test.qday.info/address/0xDa6111F272E94e253a1485705B4ad31DF846CfFf) | [`0x6d3846fd…`](https://explorer-test.qday.info/tx/0x6d3846fdb9269f152fe1ccb50127bcd79f4ef321f5e203bd8f9f03b0962b42d8) |
| tUSD8 | [`0x456569838f1d43009A91ebA4263147Afd7233483`](https://explorer-test.qday.info/address/0x456569838f1d43009A91ebA4263147Afd7233483) | (QDay) |

### Testnet demo run (2026-11-17)

Owner `0x6d69…11f2`, seller `0xC035…44a3`, agent `0xee45…1A61` (agent gas balance 0 before and after).

| Step | Result | Tx |
|---|---|---|
| Register agent identity #1 | ok | [`0x90716180…`](https://explorer-test.qday.info/tx/0x90716180cfd4c7932e5cd407b592aaad7113dbbb8a0475d75ef1631d9bc0335d) |
| Deposit 1 tUSD8 | ok | [`0xcc83f747…`](https://explorer-test.qday.info/tx/0xcc83f7476e6a6f12f93d16e51da761acce981c0c5d4e0f086907059810ce69a4) |
| Grant: 0.10 per payment, 0.25 per day, seller allowlisted, ML-DSA-65 key hash committed | ok | [`0xea18d9a1…`](https://explorer-test.qday.info/tx/0xea18d9a12b64ad023a42acd80a30aa0d7434a321c9c0f2a3d66a74e1ec5915be) |
| Paid call #1, 0.05 (same payment sent twice: one charge) | ok | [`0x1d11581f…`](https://explorer-test.qday.info/tx/0x1d11581fa83bf3781f78ad935d1a6ce8b38224ec87e33b18108e2a5282a0d51c) |
| Paid call #2, 0.05 | ok | [`0x779b1f54…`](https://explorer-test.qday.info/tx/0x779b1f54290957fbec73bf8916eb559fba7e62395ca543a9a565cd8eaafd9a95) |
| Paid call #3, 0.05 | ok | [`0x5cfcca0a…`](https://explorer-test.qday.info/tx/0x5cfcca0aee30e143aa6d2c9309c8f5c3deaadaf1d96e6883e4867fd364b28ab9) |
| Paid call #4, 0.05 | ok | [`0x79ced2f5…`](https://explorer-test.qday.info/tx/0x79ced2f5be97db685c15b0f561844607295c8b2f9b172b0337f2cffe058ed704) |
| Paid call #5, 0.04 (20% reputation discount) | ok | [`0xdce8a7ad…`](https://explorer-test.qday.info/tx/0xdce8a7ad99a2b3dfea58bccf7672c3f1b9e11c1cc5937b4833dea3403560c623) |
| Call #6 | refused before signing: "Daily limit reached: this payment needs 0.04 tUSD8 but only 0.01 tUSD8 is left today." | none |
| Payments with missing, wrong-message or foreign ML-DSA-65 signature | refused (`bad_pq_signature`) | none |
| Owner revokes the agent | ok | [`0x6aba89cd…`](https://explorer-test.qday.info/tx/0x6aba89cded55c9ebf4a0d6ef5f2288c5d5a9faab7137fb7c56c434f39a891e22) |
| Call after revoke | refused at quote time (`GrantRevoked`) | none |

Seller ratings (one per paid receipt): [`0x7720cfec…`](https://explorer-test.qday.info/tx/0x7720cfec3a2b2cd0ac6d82eee1befdc659b04d21da4cad74f5bbb073f8c66168), [`0xd31dba73…`](https://explorer-test.qday.info/tx/0xd31dba73ea412813187d7ae291f83b750b58bd9c57505d9fd0ce3d08b022b4b8), [`0xe9dd3fe4…`](https://explorer-test.qday.info/tx/0xe9dd3fe4937cc6cdf5d04e82c60501c8673b95db90cb2100c90f669f99762476), [`0xe04faceb…`](https://explorer-test.qday.info/tx/0xe04faceb0ab095ee6ffed6a07c9eef6d45c2bd7c16fae1932b6ea8fd0a74f8c9), [`0x0f6a6eb8…`](https://explorer-test.qday.info/tx/0x0f6a6eb83b8f761b48b4d2c24446192d7858d134f29f95cd8b0ccd238eae0dd5).

End state checked on chain: seller holds 0.24 tUSD8, vault holds 0.76 tUSD8, agent identity #1 has 5 ratings averaging 100, grant status revoked. The seller paid about 0.0015 tQDAY of gas for 10 transactions. Call #4 was not discounted because the seller's rating transactions are sent after delivery and had not landed yet; the discount applied from call #5.

## Seller API

`GET /api/seller`: payee address, network, vault, base price.

`POST /api/paid/summarize` with `{"text": "..."}` and header `x-agent: <agent address>`:

| Situation | Status | Body |
|---|---|---|
| No `x-payment` | 402 | `{ accepts: [Quote] }` (see `packages/aevum/src/payment.ts`) |
| Valid payment | 200 | `{ result, payment: { txHash, ref, amount, payee, agent, blockNumber }, replay }` + `x-payment-response` header |
| Same payment again | 200 | same result, `replay: true`, no second charge |
| Policy refusal | 402 / 403 | `{ error: "<plain sentence>", code: "OverDailyCap" \| "GrantRevoked" \| ... }` |
| Missing or bad PQ signature | 402 | `code: "bad_pq_signature"` |
| Payment being settled | 409 | `code: "in_flight"` (retry the same payment) |

`x-payment` is base64 JSON: `{ scheme: "vault-sig", quoteId, agent, signature, pq?: { publicKey, signature } }`. The flow follows x402's shape (402 + requirements, payment header, payment response header) with the vault as settlement. QDay's x402 facilitator has no published Aevum endpoint yet; when it does, add its `exact` scheme next to `vault-sig`.

## Project layout

```
contracts/src/          AllowanceVault, IdentityRegistry, ReputationRegistry (+ MockUSD8 for anvil)
contracts/test/         30 unit tests (every rejection path, fuzzed cap invariant), fork tests on real tUSD8
contracts/script/       Deploy.s.sol, writes deployments/<chainId>.json
packages/aevum/         chain config, generated ABIs, Spend typed data, 402 protocol types, ML-DSA helpers
web/                    Next.js: Setup, Vault (owner console), Activity (audit trail), seller API routes
examples/               agent.ts (the agent), owner.ts (CLI owner), pq-check.ts
tools/                  Shanghai opcode check, ABI generator, env printer
```

## Aevum specifics handled

Shanghai EVM (`solc 0.8.24`, no `MCOPY`/`TSTORE`; `make build` fails on Cancun opcodes), 1,000-block `eth_getLogs` limit (chunked reads), no WebSocket RPC (polling), legacy transactions, quote deadlines in block time rather than server time.

## Known limits

- Seller state (quotes, results, rate limits) is in memory: run one `next start` process, or move it to Redis before scaling out.
- The first owner to grant an agent key owns that key in the vault. Someone could front-run a grant for a key they saw; the fix for the owner is a new agent key. A consent signature from the agent would close this.
- One `grant` adds payees; removing one is a separate `setPayee` call.
- ML-DSA verification is off chain until QDay's precompile ships (see above).
- Reputation is a plain average of 0 to 100 scores; one demo seller rates every paid request 100.

## Roadmap

1. Record the demo video; host the web app (Vercel) with the seller key in a shared-state setup.
2. Agent as a Kernel v3.1 smart account through EntryPoint v0.7 (both are on Aevum) with the vault as its spending module.
3. x402 `exact` scheme next to `vault-sig` when QDay's facilitator is live; USD8 on mainnet.
4. Move the ML-DSA-65 check on chain with the Phase 2 precompile.
5. Point at QDay's official ERC-8004 registries once deployed.

## Credits and license

MIT. Based on [Aevum Starter Kit](https://github.com/qday-io/aevum-starter-kit) (MIT, PQA Labs); its LICENSE notice is kept. Third-party licenses are in [NOTICE.md](NOTICE.md).
