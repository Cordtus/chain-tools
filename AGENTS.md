# Repository Guidelines

## What This Repo Is
Two unrelated domains, both ES-module Node scripts:
1. **Multi-chain transaction generation** — EVM + Cosmos spamming against a local chain (deployment, nonce management, mempool dashboards).
2. **EVM RPC performance testing** — `eth_getLogs` stress/load against external endpoints.

## Layout
- `blockchain-spammer.js` — main entrypoint: unified EVM+Cosmos spammer (interactive wizard + non-interactive CLI). Subsumes all former standalone spammers.
- `deploy-contracts.js` — deploy the test contracts (required before spamming).
- `contracts/` — Solidity test contracts compiled at runtime via `solc`.
- `lib/` — shared modules: `metrics-analyzer.js`, `load-profiles.js`, `get-logs.js` (truncation-safe fetchLogs), `rpc-metrics.js` (formatBytes/getResponseSize/correlation helpers).
- `tools/` — focused CLI tools: `mempool-dashboard.js`, `fix-nonce.js`, `precompiles.js`, `stress-test.js`, `heavy-stress-test.js`, `get-logs.js`, `remove-emojis.js`.
- `legacy/` — archived superseded/one-off scripts. Do NOT use; kept for reference only. Relative imports inside `legacy/` are fixed to `../lib/` where needed.

## Setup & Run
- `yarn install`, then `cp .env.example .env` and fill in keys/mnemonics/RPC URLs.
- Deploy before spamming: `node deploy-contracts.js` (compiles via `solc`, auto-picks the highest-balance wallet, writes addresses to both `deployment.json` and `.env`).
- Spam: `node blockchain-spammer.js` (wizard) or `node blockchain-spammer.js --deploy --duration 300`. Run `node blockchain-spammer.js --help` for full CLI.
- Tools: `node tools/mempool-dashboard.js`, `node tools/fix-nonce.js`, `node tools/stress-test.js -r <URL> -c <ADDR>`, `node tools/heavy-stress-test.js -r <URL> -a -l heavy -p 5`.
- All scripts are entry points guarded by `import.meta.url === \`file://${process.argv[1]}\`` where relevant; run directly with `node`, no build step.

## Verification (no test framework)
- Syntax-check any change: `node --check <script.js>`.
- Then run against a local node — EVM `http://localhost:8545`, Cosmos `http://localhost:26657` — before touching external endpoints.
- Keep `--duration` short for first smoke runs.

## Critical Dual-Chain Pattern
- Keys use `eth_secp256k1`, so one private key drives both chains. The Cosmos address is the EVM address bytes bech32-encoded **without ripemd160 hashing**; Cosmos signing uses **Keccak256, not SHA256** (`blockchain-spammer.js:1275`).
- Archived copies in `legacy/` (`dual-wallet.js`, `transaction-spammer.js`, `cosmos-spam.js`, `unified-dual-spam.js`) contain this pattern too — if you restore/extract logic from them, keep it consistent.
- Hardcoded defaults (override with `--evm-chain-id`, `--cosmos-chain-id`, `--cosmos-prefix` or env): EVM chain ID `262144`, Cosmos chain ID `'9001'`, Cosmos prefix `evmd`.

## Library Gotchas
- `ethers` **v6** API only: `ethers.JsonRpcProvider`, never `ethers.providers`.
- `@cosmjs/*` v0.31 with `DirectSecp256k1Wallet` and protobuf signing (`TxRaw`/`SignDoc`/`MsgSend` from `cosmjs-types`) — not amino JSON signing.
- `eth_getLogs` truncates at exactly 10,000 logs. `lib/get-logs.js` handles it via recursive binary splitting; reuse it instead of reimplementing.

## Concurrency & State
- Up to 4 wallets: `PRIVATE_KEY`..`PRIVATE_KEY_3` (EVM), `MNEMONIC`..`MNEMONIC_3` (Cosmos). Each tracks its own nonce; `blockchain-spammer.js` uses Map-based wallet locks to prevent concurrent nonce increments.
- State files at root: `deployment.json` (contract addresses), `debug_output.json`, `spam-results-{timestamp}.json`, `detailed-metrics-{timestamp}.json`.

## Conventions
- ES modules, 4-space indent, semicolons, class-based (e.g., `EvmTransactionEngine`, `CosmosTransactionEngine`, `MetricsAnalyzer`).
- New tools: focused script in `tools/` with a `main()`/CLI args; shared logic goes in `lib/`, not duplicated per-tool. Document one example command in `README.md` or script comments.
- `legacy/` is not git-ignored; do not modify archived scripts unless extracting a pattern.

## Security
- Never commit real private keys, mnemonics, or production RPC URLs — `.env` (root, mode 0600) and `.env.example` only.
- Prefer local/testnet endpoints and low-value accounts; redact addresses, hashes, and hostnames from shared logs.
