# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Blockchain testing suite with two domains: **EVM RPC performance analysis** (`eth_getLogs` stress testing) and **multi-chain transaction generation** (EVM + Cosmos spamming). All scripts are standalone ES module Node.js scripts run directly with `node`.

## Commands

```bash
yarn install                          # Install dependencies
cp .env.example .env                  # Setup environment (edit with real values)
node deploy-contracts.js              # Deploy test contracts (must run before spamming)

# Transaction spamming (unified; legacy spammers archived in legacy/)
node blockchain-spammer.js --deploy --duration 300   # Unified EVM + Cosmos

# RPC stress testing
node tools/stress-test.js -r <RPC_URL> -c <CONTRACT> [OPTIONS]
node tools/heavy-stress-test.js -r <RPC_URL> -a -l heavy -p 5

# Monitoring / repair
node tools/mempool-dashboard.js        # React/Ink TUI for real-time mempool stats
node tools/fix-nonce.js                # replace stuck/nonce-gapped transactions
```

No test framework - scripts are validated by running against a local node (`localhost:8545` EVM, `localhost:26657` Cosmos).

## Architecture

### Dual-Chain Address Derivation (Critical Pattern)

The codebase uses **eth_secp256k1** (not Cosmos's default ed25519) so a single private key controls both EVM and Cosmos accounts. The Cosmos address is the EVM address bytes bech32-encoded (no ripemd160 hashing). This pattern appears in `blockchain-spammer.js` and the archived `dual-wallet.js`/`transaction-spammer.js`/`cosmos-spam.js` (in `legacy/`) - keep them consistent.

### Script Organization

**Main entrypoint:** `blockchain-spammer.js` - the unified EVM+Cosmos spammer (wizard + CLI). It subsumes the former `evm-spam.js`, `cosmos-spam.js`, `transaction-spammer.js`, `dual-spam.js`, `dual-wallet.js`, `unified-dual-spam.js`, `multi-chain-diverse-spam.js` - all archived in `legacy/`.

**Shared modules:** `lib/` - `metrics-analyzer.js` (MetricsAnalyzer), `load-profiles.js` (curated RPC load contracts), `get-logs.js` (truncation-safe fetchLogs), `rpc-metrics.js` (formatBytes/getResponseSize/correlation).

**Focused tools:** `tools/` - `mempool-dashboard.js`, `fix-nonce.js` (merged nonce tools), `precompiles.js` (merged precompile tests), `stress-test.js`, `heavy-stress-test.js`, `get-logs.js` (CLI), `remove-emojis.js`.

### Key Technical Constraints

- **eth_getLogs 10K limit:** Queries returning exactly 10,000 logs are truncated. `lib/get-logs.js` handles this via recursive binary splitting of block ranges.
- **Multi-wallet concurrency:** Up to 4 wallets (`PRIVATE_KEY` through `PRIVATE_KEY_3`, `MNEMONIC` through `MNEMONIC_3`). Each wallet tracks its own nonce independently. `blockchain-spammer.js` uses Map-based wallet locks to prevent concurrent nonce increments.
- **Contract deployment prerequisite:** `deploy-contracts.js` compiles Solidity at runtime via `solc`, auto-selects the highest-balance wallet as deployer, and persists addresses to both `deployment.json` and `.env`.
- **Protobuf for Cosmos:** Uses `cosmjs-types` with TxRaw/SignDoc/MsgSend - not JSON amino encoding.

### State & Output Files

- `deployment.json` - Persisted contract deployment state (addresses, deployer, network info)
- `debug_output.json` - Detailed transaction logs during spamming
- `spam-results-{timestamp}.json` - Run results with statistics
- `detailed-metrics-{timestamp}.json` - Comprehensive metrics export

## Coding Conventions

- ES modules (`import`/`export`), 4-space indentation, semicolons
- Class-based architecture: `EvmTransactionEngine`, `CosmosTransactionEngine`, `MetricsAnalyzer`
- Hardcoded chain IDs: EVM `262144`, Cosmos `'9001'` (Evmos-based local chain)
- Cosmos address prefix: `evmd` (not `cosmos`)
- `ethers` v6 API (not v5) - use `ethers.JsonRpcProvider`, not `ethers.providers.JsonRpcProvider`
- `@cosmjs/*` v0.31 with `DirectSecp256k1Wallet` (not amino signing)
