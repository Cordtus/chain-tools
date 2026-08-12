#!/usr/bin/env node
/**
 * Fix stuck/queued nonce-gap transactions on the EVM chain.
 *
 * Merges the legacy tools: nonce-range-replacer.js, replace-stuck-txs.js,
 * tx-replacer.js, and nonce-gap-demo.js. Two discovery sources, two
 * replacement-payload policies, and optional fee bumping.
 *
 * Usage:
 *   node tools/fix-nonce.js --source txpool                  # re-broadcast queued txs, preserving payload
 *   node tools/fix-nonce.js --source nonce-count             # replace gap between latest/pending nonce
 *   node tools/fix-nonce.js --source nonce-count --payload self-transfer
 *   node tools/fix-nonce.js --demo                           # interactive gap demo
 *
 * Discovery:
 *   --source <txpool|nonce-count>   txpool_content.queued vs latest/pending nonce gap (default: txpool)
 *
 * Replacement:
 *   --payload <preserve|self-transfer>  preserve original to/value/data, or self-transfer (default: preserve)
 *   --chain-id <n>                 EVM chain ID (default: env EVM_CHAIN_ID or 262144)
 *   --fee-multiplier <n>           Multiply network gas price for replacement (default: 2)
 *   --priority-fee-gwei <n>        Priority fee in gwei (default: 0.1)
 *   --max-fee-gwei <n>             Cap max fee per gas in gwei (default: 2.5)
 *   --delay-ms <n>                 Delay between replacements (default: 250)
 *   --dry-run                      Report what would be replaced without broadcasting
 */
import { ethers } from 'ethers';
import { parseArgs } from 'util';
import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_CHAIN_ID = 262144;

class FixNonce {
    constructor(options = {}) {
        this.evmRpcUrl = options.rpcUrl || process.env.RPC_URL || 'http://localhost:8545';
        this.provider = new ethers.JsonRpcProvider(this.evmRpcUrl);
        this.chainId = parseInt(options.chainId || process.env.EVM_CHAIN_ID || DEFAULT_CHAIN_ID, 10);
        this.source = options.source || 'txpool';
        this.payload = options.payload || 'preserve';
        this.feeMultiplier = BigInt(options.feeMultiplier || 2);
        this.priorityFee = ethers.parseUnits(options.priorityFeeGwei || '0.1', 'gwei');
        this.maxFeePerGas = ethers.parseUnits(options.maxFeeGwei || '2.5', 'gwei');
        this.delayMs = parseInt(options.delayMs || 250, 10);
        this.dryRun = !!options.dryRun;

        this.stats = {
            analyzed: 0,
            attempted: 0,
            successful: 0,
            failed: 0,
            errors: [],
        };
    }

    loadWallets() {
        const privateKeys = [
            process.env.PRIVATE_KEY,
            process.env.PRIVATE_KEY_1,
            process.env.PRIVATE_KEY_2,
            process.env.PRIVATE_KEY_3,
        ].filter(Boolean);

        const wallets = {};
        for (const key of privateKeys) {
            try {
                const wallet = new ethers.Wallet(key, this.provider);
                wallets[wallet.address.toLowerCase()] = wallet;
            } catch (error) {
                console.error(`Failed to load wallet: ${error.message}`);
            }
        }
        console.log(`Loaded ${Object.keys(wallets).length} wallet(s)`);
        return wallets;
    }

    async discoverFromTxpool() {
        const txpoolContent = await this.provider.send('txpool_content', []);
        const queuedTxs = txpoolContent.result?.queued || {};

        const stuckTxs = [];
        for (const [address, nonceTxs] of Object.entries(queuedTxs)) {
            for (const [nonce, tx] of Object.entries(nonceTxs)) {
                stuckTxs.push({
                    address: address.toLowerCase(),
                    nonce: parseInt(nonce, 10),
                    originalHash: tx.hash,
                    to: tx.to,
                    value: tx.value || '0x0',
                    data: tx.input || '0x',
                    gasLimit: tx.gas,
                    originalGasPrice: tx.gasPrice || '0x0',
                });
            }
        }
        stuckTxs.sort((a, b) => a.address.localeCompare(b.address) || a.nonce - b.nonce);
        return stuckTxs;
    }

    async discoverFromNonceGap() {
        const wallets = this.loadWallets();
        const stuckTxs = [];
        for (const [address, wallet] of Object.entries(wallets)) {
            const latestNonce = await this.provider.getTransactionCount(wallet.address, 'latest');
            const pendingNonce = await this.provider.getTransactionCount(wallet.address, 'pending');
            const gap = pendingNonce - latestNonce;
            console.log(`${wallet.address}: latest=${latestNonce} pending=${pendingNonce} stuck=${gap}`);
            for (let nonce = latestNonce; nonce < pendingNonce; nonce++) {
                stuckTxs.push({ address, nonce });
            }
        }
        return stuckTxs;
    }

    async discover() {
        const stuckTxs =
            this.source === 'nonce-count' ? await this.discoverFromNonceGap() : await this.discoverFromTxpool();
        this.stats.analyzed = stuckTxs.length;
        console.log(`Found ${stuckTxs.length} stuck transaction(s)`);
        return stuckTxs;
    }

    async buildReplacement(stuckTx, wallet) {
        const feeData = await this.provider.getFeeData();
        const baseGasPrice = feeData.gasPrice || this.maxFeePerGas / 2n;
        const newMaxFee = Math.min(baseGasPrice * this.feeMultiplier, this.maxFeePerGas);

        if (this.payload === 'self-transfer') {
            return {
                to: wallet.address,
                value: ethers.parseUnits('0.000001', 'ether'),
                gasLimit: 21000,
                nonce: stuckTx.nonce,
                chainId: this.chainId,
                type: 2,
                maxFeePerGas: newMaxFee,
                maxPriorityFeePerGas: this.priorityFee,
            };
        }
        return {
            to: stuckTx.to || null,
            value: stuckTx.value,
            data: stuckTx.data || '0x',
            gasLimit: stuckTx.gasLimit || 21000,
            nonce: stuckTx.nonce,
            chainId: this.chainId,
            type: 2,
            maxFeePerGas: newMaxFee,
            maxPriorityFeePerGas: this.priorityFee,
        };
    }

    async replaceOne(stuckTx, wallet) {
        const tx = await this.buildReplacement(stuckTx, wallet);
        if (this.dryRun) {
            console.log(`[dry-run] would replace nonce ${stuckTx.nonce} (${stuckTx.originalHash || wallet.address})`);
            this.stats.successful++;
            return null;
        }
        try {
            const signedTx = await wallet.signTransaction(tx);
            const txResponse = await this.provider.broadcastTransaction(signedTx);
            console.log(`Replaced nonce ${stuckTx.nonce}: ${txResponse.hash}`);
            this.stats.successful++;
            return txResponse;
        } catch (error) {
            console.error(`Failed nonce ${stuckTx.nonce}: ${error.message}`);
            this.stats.failed++;
            this.stats.errors.push({ nonce: stuckTx.nonce, error: error.message });
            return null;
        }
    }

    async run() {
        console.log('Nonce / Stuck Transaction Repair\n');
        console.log(`Source: ${this.source} | Payload: ${this.payload} | Chain ID: ${this.chainId}${this.dryRun ? ' | DRY-RUN' : ''}`);

        const wallets = this.loadWallets();
        if (Object.keys(wallets).length === 0) {
            console.error('No wallets loaded. Check PRIVATE_KEY..PRIVATE_KEY_3 in .env');
            return;
        }

        const stuckTxs = await this.discover();
        if (stuckTxs.length === 0) {
            console.log('Nothing to replace');
            return;
        }

        // Group by wallet, process in nonce order
        const groups = {};
        for (const tx of stuckTxs) {
            const wallet = wallets[tx.address];
            if (!wallet) {
                console.log(`Skipping ${tx.originalHash || `nonce ${tx.nonce}`} for ${tx.address} (no wallet)`);
                continue;
            }
            (groups[tx.address] ||= []).push({ tx, wallet });
        }

        for (const txs of Object.values(groups)) {
            txs.sort((a, b) => a.tx.nonce - b.tx.nonce);
            for (const { tx, wallet } of txs) {
                this.stats.attempted++;
                await this.replaceOne(tx, wallet);
                await new Promise((resolve) => setTimeout(resolve, this.delayMs));
            }
        }

        console.log('\n' + '='.repeat(50));
        console.log('REPAIR RESULTS');
        console.log('='.repeat(50));
        console.log(`Analyzed: ${this.stats.analyzed}`);
        console.log(`Attempted: ${this.stats.attempted}`);
        console.log(`Successful: ${this.stats.successful}`);
        console.log(`Failed: ${this.stats.failed}`);
        if (this.stats.attempted > 0) {
            console.log(`Success Rate: ${((this.stats.successful / this.stats.attempted) * 100).toFixed(2)}%`);
        }
        if (this.stats.errors.length > 0) {
            console.log('\nErrors (first 5):');
            for (const err of this.stats.errors.slice(0, 5)) {
                console.log(`  Nonce ${err.nonce}: ${err.error}`);
            }
        }
    }
}

async function runDemo() {
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL || 'http://localhost:8545');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    const createTx = async (nonce) => {
        const feeData = await provider.getFeeData();
        const tx = {
            to: wallet.address,
            value: Math.floor(Math.random() * 1000),
            gasLimit: 21000,
            maxFeePerGas: (feeData.gasPrice || 1000000000n) * 20n,
            maxPriorityFeePerGas: (feeData.gasPrice || 1000000000n) * 20n,
            nonce,
            chainId: (await provider.getNetwork()).chainId,
        };
        return (await provider.broadcastTransaction(await wallet.signTransaction(tx))).hash;
    };

    const latest = await provider.getTransactionCount(wallet.address, 'latest');
    const pending = await provider.getTransactionCount(wallet.address, 'pending');
    if (pending > latest) {
        console.log(`Clearing ${pending - latest} stuck transaction(s)...`);
        for (let nonce = latest; nonce < pending; nonce++) {
            try {
                await createTx(nonce);
                await new Promise((resolve) => setTimeout(resolve, 500));
            } catch { /* continue */ }
        }
        await new Promise((resolve) => setTimeout(resolve, 3000));
    }

    const startNonce = await provider.getTransactionCount(wallet.address, 'pending');
    console.log(`Creating 3 gapped transactions from nonce ${startNonce}...`);
    for (let i = 1; i <= 3; i++) {
        const hash = await createTx(startNonce + i);
        console.log(`Gap nonce ${startNonce + i}: ${hash}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    console.log(`Filling gap nonce ${startNonce}...`);
    console.log(`Filled: ${await createTx(startNonce)}`);
    await new Promise((resolve) => setTimeout(resolve, 8000));
    console.log(`Demo complete. Final pending nonce: ${await provider.getTransactionCount(wallet.address, 'pending')}`);
}

const args = parseArgs({
    args: process.argv.slice(2),
    options: {
        source: { type: 'string' },
        payload: { type: 'string' },
        'chain-id': { type: 'string' },
        'fee-multiplier': { type: 'string' },
        'priority-fee-gwei': { type: 'string' },
        'max-fee-gwei': { type: 'string' },
        'delay-ms': { type: 'string' },
        'dry-run': { type: 'boolean' },
        demo: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
    },
    strict: false,
});

if (import.meta.url === `file://${process.argv[1]}`) {
    if (args.values.help) {
        console.log(`
Fix stuck/queued nonce-gap transactions.

Usage: node tools/fix-nonce.js [OPTIONS] | node tools/fix-nonce.js --demo

Discovery:
  --source <txpool|nonce-count>   queued-mempool scan or latest/pending nonce gap (default: txpool)

Replacement:
  --payload <preserve|self-transfer>  keep original to/value/data, or self-transfer (default: preserve)
  --chain-id <n>                 EVM chain ID (default: 262144)
  --fee-multiplier <n>           multiply network gas price (default: 2)
  --priority-fee-gwei <n>        priority fee in gwei (default: 0.1)
  --max-fee-gwei <n>             max fee cap in gwei (default: 2.5)
  --delay-ms <n>                 delay between replacements (default: 250)
  --dry-run                      report without broadcasting

Demo:
  --demo                         interactive nonce-gap create + fill demo

Examples:
  node tools/fix-nonce.js --source txpool
  node tools/fix-nonce.js --source nonce-count --payload self-transfer --dry-run
  node tools/fix-nonce.js --demo
`);
        process.exit(0);
    }

    if (args.values.demo) {
        runDemo().catch(console.error);
    } else {
        const fixer = new FixNonce({
            source: args.values.source,
            payload: args.values.payload,
            chainId: args.values['chain-id'],
            feeMultiplier: args.values['fee-multiplier'],
            priorityFeeGwei: args.values['priority-fee-gwei'],
            maxFeeGwei: args.values['max-fee-gwei'],
            delayMs: args.values['delay-ms'],
            dryRun: args.values['dry-run'],
        });
        fixer.run().catch(console.error);
    }
}

export default FixNonce;
