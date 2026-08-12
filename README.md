# Blockchain Testing Suite

Two unrelated test harnesses of ES-module Node scripts:

1. **Multi-chain transaction generation** — EVM + Cosmos traffic against a local chain to test mempools, nonces, and behavior under load.
2. **EVM RPC performance testing** — `eth_getLogs` stress and load tests against external endpoints.

## Layout

```
blockchain-spammer.js   Main entrypoint: unified EVM+Cosmos spammer (interactive wizard + CLI)
deploy-contracts.js     Deploy the test contracts (required before spamming)
contracts/              Solidity test contracts (TestERC20, TestStorage, TestCounter)
lib/                    Shared modules (metrics-analyzer, load-profiles, get-logs, rpc-metrics)
tools/                  Focused single-purpose CLI tools
legacy/                 Superseded scripts, archived for reference (do not use)
```

## Quick Start

```bash
yarn install
cp .env.example .env        # set RPC URLs + at least PRIVATE_KEY / MNEMONIC

node deploy-contracts.js                 # deploy contracts, writes addresses to .env + deployment.json
node blockchain-spammer.js               # interactive wizard
node blockchain-spammer.js --deploy --duration 300   # deploy + spam 5 min
```

## Workflows

### Generate transaction load

```bash
# EVM only: mixed tx types, 30 TPS for 2 min
node blockchain-spammer.js --chains=evm --mode=mixed --evm-tps=30 --duration=120

# Cosmos only: bank sends + staking, 10 TPS for 2 min
node blockchain-spammer.js --chains=cosmos --mode=bank --cosmos-tps=10 --duration=120

# Both chains concurrently, with live mempool dashboard
node blockchain-spammer.js --chains=both --mode=mixed --evm-tps=20 --cosmos-tps=10 --duration=180 --dashboard

# Enable all advanced features (nonce gaps, tx replacement, mempool cleanup)
node blockchain-spammer.js --chains=both --mode=mixed --advanced
```

Run `node blockchain-spammer.js --help` for the full option list.

### Monitor the mempool

```bash
node tools/mempool-dashboard.js          # dual-chain dashboard (also auto-launched via --dashboard)
```

### Fix stuck / nonce-gapped transactions

```bash
node tools/fix-nonce.js                                  # re-broadcast queued txs, preserving payload
node tools/fix-nonce.js --source nonce-count             # replace latest/pending nonce gaps
node tools/fix-nonce.js --payload self-transfer --dry-run  # preview before broadcasting
node tools/fix-nonce.js --demo                           # interactive nonce-gap demo
```

### Stress-test an RPC endpoint with eth_getLogs

```bash
# Benchmark a specific contract (scan/growth/analysis modes)
node tools/stress-test.js -r https://eth-mainnet.g.alchemy.com/v2/KEY -c 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48

# Load generation: curated high-activity contracts, parallel queries
node tools/heavy-stress-test.js -r https://polygon-rpc.com -a -l heavy -p 5
node tools/heavy-stress-test.js --list          # list preconfigured contracts by chain

# Fetch a full block range without the 10,000-log truncation limit
node tools/get-logs.js -r <RPC_URL> -c <CONTRACT> -b <start> -e <end>
```

### Verify precompiles (local chain)

```bash
node tools/precompiles.js                          # all sections
node tools/precompiles.js --section write          # state-changing tests only
node tools/precompiles.js --rpc http://localhost:8545 --wallet dev1
```

## Environment

`.env` holds RPC URLs, chain IDs, and up to 4 wallets: `PRIVATE_KEY`..`PRIVATE_KEY_3` (EVM) and `MNEMONIC`..`MNEMONIC_3` (Cosmos). `deploy-contracts.js` writes contract addresses to both `.env` and `deployment.json`.

Hardcoded defaults (override via `--evm-chain-id`, `--cosmos-chain-id`, `--cosmos-prefix` or env): EVM chain ID `262144`, Cosmos chain ID `'9001'`, Cosmos prefix `evmd`.

## Modes

- **EVM** (`--chains=evm`): `eth`, `erc20`, `counter`, `storage`, `mixed`, `concurrent`
- **Cosmos** (`--chains=cosmos`): `bank`, `staking`, `mixed`
- **Both** (`--chains=both`): `mixed` (default, concurrent loops), `sequential`, `burst`, `unified`, `advanced`

## Architecture Notes

- Keys use `eth_secp256k1`, so one private key drives both chains. The Cosmos address is the EVM address bytes bech32-encoded **without ripemd160 hashing**; Cosmos signing uses **Keccak256, not SHA256** (`blockchain-spammer.js:1275`).
- `blockchain-spammer.js` subsumes the former standalone spammers (`evm-spam.js`, `cosmos-spam.js`, `dual-spam.js`, etc.) — archived in `legacy/`.
- `eth_getLogs` truncates at exactly 10,000 logs; `lib/get-logs.js` returns the full set via recursive binary splitting.
- `tools/fix-nonce.js` subsumes the former `nonce-*.js`, `replace-stuck-txs.js`, `tx-replacer.js`; `tools/precompiles.js` subsumes the three `test-precompiles-*.js` scripts.

## Verification

No test framework. Syntax-check any change with `node --check <script.js>`, then run against a local node (EVM `http://localhost:8545`, Cosmos `http://localhost:26657`) before touching external endpoints. Keep `--duration` short for first smoke runs.
