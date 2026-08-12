import DualWallet from './dual-wallet.js';
import { ethers } from 'ethers';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

/**
 * Enhanced transaction spammer that uses dual-chain wallets
 * Each wallet can perform both EVM and Cosmos transactions from the same account
 */
class DualChainSpammer {
    constructor() {
        this.evmRpcUrl = process.env.RPC_URL || 'http://localhost:8545';
        this.cosmosRpcUrl = process.env.COSMOS_RPC_URL || 'http://localhost:26657';
        
        this.evmProvider = new ethers.JsonRpcProvider(this.evmRpcUrl);
        this.wallets = [];
        this.contracts = {};
        
        this.stats = {
            totalTxs: 0,
            successfulTxs: 0,
            failedTxs: 0,
            evmTxs: 0,
            cosmosTxs: 0,
            evmSuccessful: 0,
            cosmosSuccessful: 0,
            startTime: null,
            endTime: null,
            transactions: []
        };
        
        console.log('Initialized Dual Chain Spammer');
    }
    
    async initialize() {
        console.log('Initializing dual-chain wallets...');
        
        const mnemonics = [
            process.env.MNEMONIC,
            process.env.MNEMONIC_1,
            process.env.MNEMONIC_2,
            process.env.MNEMONIC_3
        ].filter(Boolean);
        
        if (mnemonics.length === 0) {
            throw new Error('No mnemonics found in .env file');
        }
        
        // Get funding private keys (dev wallet keys for funding)
        const fundingKeys = [
            process.env.PRIVATE_KEY,
            process.env.PRIVATE_KEY_1,
            process.env.PRIVATE_KEY_2,
            process.env.PRIVATE_KEY_3
        ].filter(Boolean);
        
        // Load contracts
        this.loadContracts();
        
        // Initialize dual wallets with funding capability
        for (let i = 0; i < mnemonics.length; i++) {
            const wallet = new DualWallet(i, mnemonics[i], this.evmProvider, this.cosmosRpcUrl, fundingKeys);
            await wallet.initialize();
            this.wallets.push(wallet);
        }
        
        console.log(`Initialized ${this.wallets.length} dual-chain wallets with funding support`);
    }
    
    loadContracts() {
        if (process.env.TEST_ERC20_CONTRACT) {
            this.contracts.erc20 = process.env.TEST_ERC20_CONTRACT;
        }
        if (process.env.TEST_STORAGE_CONTRACT) {
            this.contracts.storage = process.env.TEST_STORAGE_CONTRACT;
        }
        if (process.env.TEST_COUNTER_CONTRACT) {
            this.contracts.counter = process.env.TEST_COUNTER_CONTRACT;
        }
        
        console.log('Loaded contracts:', this.contracts);
    }
    
    async runMixedSpam(duration, tps) {
        console.log(`\\nStarting dual-chain mixed spam: ${tps} TPS for ${duration}s`);
        console.log('Transaction types: EVM transfers, EVM contracts, Cosmos sends');
        
        this.stats.startTime = Date.now();
        this.resetStats();
        
        const interval = 1000 / tps;
        const endTime = Date.now() + (duration * 1000);
        
        while (Date.now() < endTime) {
            const wallet = this.getRandomWallet();
            const otherWallets = this.wallets.filter(w => w !== wallet);
            
            const result = await wallet.performRandomTransaction(otherWallets, this.contracts);
            this.recordTransaction(result);
            
            await this.sleep(interval);
        }
        
        this.stats.endTime = Date.now();
        this.printStats();
    }
    
    async runSequentialSpam(duration, tps) {
        console.log(`\\nStarting dual-chain sequential spam: ${tps} TPS for ${duration}s`);
        console.log('Pattern: EVM -> Cosmos -> EVM -> Cosmos from same accounts');
        
        this.stats.startTime = Date.now();
        this.resetStats();
        
        const interval = 1000 / tps;
        const endTime = Date.now() + (duration * 1000);
        
        let txCount = 0;
        
        while (Date.now() < endTime) {
            const wallet = this.getRandomWallet();
            const targetWallet = this.getRandomWallet();
            
            if (wallet === targetWallet) continue;
            
            let result;
            
            // Alternate between EVM and Cosmos transactions
            if (txCount % 2 === 0) {
                // EVM transaction
                if (Math.random() > 0.5 && this.contracts.counter) {
                    const data = wallet.generateCounterIncrementData(Math.floor(Math.random() * 5) + 1);
                    result = await wallet.sendEvmContractCall(this.contracts.counter, data);
                } else {
                    const amount = ethers.parseEther((Math.random() * 0.001).toFixed(6));
                    result = await wallet.sendEvmTransfer(targetWallet.evmAddress, amount);
                }
            } else {
                // Cosmos transaction
                const amount = Math.floor(Math.random() * 1000000) + 100000;
                result = await wallet.sendCosmosBankSend(targetWallet.cosmosAddress, amount);
            }
            
            this.recordTransaction(result);
            txCount++;
            
            await this.sleep(interval);
        }
        
        this.stats.endTime = Date.now();
        this.printStats();
    }
    
    async runBurstSpam(duration, tps) {
        console.log(`\\nStarting dual-chain burst spam: ${tps} TPS for ${duration}s`);
        console.log('Pattern: Random bursts of same-account EVM+Cosmos transaction pairs');
        
        this.stats.startTime = Date.now();
        this.resetStats();
        
        const baseInterval = 1000 / tps;
        const endTime = Date.now() + (duration * 1000);
        
        while (Date.now() < endTime) {
            const wallet = this.getRandomWallet();
            const targetWallet = this.getRandomWallet();
            
            if (wallet === targetWallet) continue;
            
            // Send a burst: EVM tx followed immediately by Cosmos tx from same account
            const ethAmount = ethers.parseEther((Math.random() * 0.001).toFixed(6));
            const cosmosAmount = Math.floor(Math.random() * 1000000) + 100000;
            
            // EVM transaction
            const evmResult = await wallet.sendEvmTransfer(targetWallet.evmAddress, ethAmount);
            this.recordTransaction(evmResult);
            
            // Immediate Cosmos transaction from same account
            await this.sleep(50); // Small delay to avoid nonce conflicts
            const cosmosResult = await wallet.sendCosmosBankSend(targetWallet.cosmosAddress, cosmosAmount);
            this.recordTransaction(cosmosResult);
            
            await this.sleep(baseInterval * 2); // Account for 2 transactions
        }
        
        this.stats.endTime = Date.now();
        this.printStats();
    }
    
    getRandomWallet() {
        return this.wallets[Math.floor(Math.random() * this.wallets.length)];
    }
    
    recordTransaction(result) {
        this.stats.totalTxs++;
        this.stats.transactions.push({
            ...result,
            timestamp: Date.now()
        });
        
        if (result.success) {
            this.stats.successfulTxs++;
            if (result.type.startsWith('evm')) {
                this.stats.evmSuccessful++;
            } else if (result.type.startsWith('cosmos')) {
                this.stats.cosmosSuccessful++;
            }
        } else {
            this.stats.failedTxs++;
        }
        
        if (result.type.startsWith('evm')) {
            this.stats.evmTxs++;
        } else if (result.type.startsWith('cosmos')) {
            this.stats.cosmosTxs++;
        }
    }
    
    resetStats() {
        this.stats.totalTxs = 0;
        this.stats.successfulTxs = 0;
        this.stats.failedTxs = 0;
        this.stats.evmTxs = 0;
        this.stats.cosmosTxs = 0;
        this.stats.evmSuccessful = 0;
        this.stats.cosmosSuccessful = 0;
        this.stats.transactions = [];
    }
    
    printStats() {
        const duration = (this.stats.endTime - this.stats.startTime) / 1000;
        const tps = this.stats.totalTxs / duration;
        const successRate = (this.stats.successfulTxs / this.stats.totalTxs) * 100;
        const evmSuccessRate = this.stats.evmTxs > 0 ? (this.stats.evmSuccessful / this.stats.evmTxs) * 100 : 0;
        const cosmosSuccessRate = this.stats.cosmosTxs > 0 ? (this.stats.cosmosSuccessful / this.stats.cosmosTxs) * 100 : 0;
        
        console.log('\\n=== Dual-Chain Spam Statistics ===');
        console.log(`Duration: ${duration.toFixed(2)}s`);
        console.log(`Total transactions: ${this.stats.totalTxs}`);
        console.log(`  EVM: ${this.stats.evmTxs} (${this.stats.evmSuccessful} successful)`);
        console.log(`  Cosmos: ${this.stats.cosmosTxs} (${this.stats.cosmosSuccessful} successful)`);
        console.log(`Success rate: ${successRate.toFixed(2)}%`);
        console.log(`  EVM success rate: ${evmSuccessRate.toFixed(2)}%`);
        console.log(`  Cosmos success rate: ${cosmosSuccessRate.toFixed(2)}%`);
        console.log(`Average TPS: ${tps.toFixed(2)}`);
        
        // Save results
        const filename = `dual-spam-results-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        fs.writeFileSync(filename, JSON.stringify({
            summary: {
                duration,
                totalTransactions: this.stats.totalTxs,
                evmTransactions: this.stats.evmTxs,
                cosmosTransactions: this.stats.cosmosTxs,
                successRate,
                evmSuccessRate,
                cosmosSuccessRate,
                averageTps: tps
            },
            transactions: this.stats.transactions
        }, null, 2));
        
        console.log(`\\nDetailed results saved to ${filename}`);
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// CLI interface
async function main() {
    const args = process.argv.slice(2);
    const mode = args.find(arg => ['mixed', 'sequential', 'burst'].includes(arg)) || 'mixed';
    const duration = parseInt(args.find(arg => arg.startsWith('--duration='))?.split('=')[1]) || 30;
    const tps = parseInt(args.find(arg => arg.startsWith('--tps='))?.split('=')[1]) || 5;
    
    console.log(' Dual-Chain Transaction Spammer');
    console.log('==================================');
    console.log(`Mode: ${mode}`);
    console.log(`Duration: ${duration}s`);
    console.log(`Target TPS: ${tps}`);
    
    const spammer = new DualChainSpammer();
    await spammer.initialize();
    
    switch (mode) {
        case 'mixed':
            await spammer.runMixedSpam(duration, tps);
            break;
        case 'sequential':
            await spammer.runSequentialSpam(duration, tps);
            break;
        case 'burst':
            await spammer.runBurstSpam(duration, tps);
            break;
        default:
            console.error('Unknown mode. Use: mixed, sequential, or burst');
            process.exit(1);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export default DualChainSpammer;