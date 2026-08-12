import { ethers } from 'ethers';
import fs from 'fs';
import dotenv from 'dotenv';
import MetricsAnalyzer from '../lib/metrics-analyzer.js';

dotenv.config();

class EVMSpammer {
    constructor() {
        if (!process.env.RPC_URL) {
            throw new Error('RPC_URL must be set in .env');
        }
        if (!process.env.EVM_CHAIN_ID) {
            throw new Error('EVM_CHAIN_ID must be set in .env');
        }

        this.rpcUrl = process.env.RPC_URL;
        this.provider = new ethers.JsonRpcProvider(this.rpcUrl);
        this.chainId = Number(process.env.EVM_CHAIN_ID);
        
        this.wallets = this.loadWallets();
        this.contracts = this.loadContracts();
        
        this.stats = {
            totalTxs: 0,
            successfulTxs: 0,
            failedTxs: 0,
            startTime: null,
            endTime: null
        };
        
        this.metricsAnalyzer = new MetricsAnalyzer();
        
        console.log(`Initialized EVM Spammer with ${this.wallets.length} wallets`);
    }
    
    loadWallets() {
        const wallets = [];
        
        for (let i = 0; i <= 3; i++) {
            const keyName = i === 0 ? 'PRIVATE_KEY' : `PRIVATE_KEY_${i}`;
            const privateKey = process.env[keyName];
            
            if (privateKey) {
                const wallet = new ethers.Wallet(privateKey, this.provider);
                wallets.push({
                    index: i,
                    wallet,
                    address: wallet.address,
                    nonce: null
                });
                console.log(`Loaded wallet ${i}: ${wallet.address}`);
            }
        }
        
        if (wallets.length === 0) {
            throw new Error('No wallets found in .env file');
        }
        
        return wallets;
    }
    
    loadContracts() {
        const contracts = {};
        
        if (process.env.TEST_ERC20_CONTRACT) {
            contracts.erc20 = process.env.TEST_ERC20_CONTRACT;
        }
        if (process.env.TEST_STORAGE_CONTRACT) {
            contracts.storage = process.env.TEST_STORAGE_CONTRACT;
        }
        if (process.env.TEST_COUNTER_CONTRACT) {
            contracts.counter = process.env.TEST_COUNTER_CONTRACT;
        }
        
        console.log('Loaded contracts:', contracts);
        return contracts;
    }

    async validateContractsOnChain() {
        const entries = Object.entries(this.contracts);
        if (entries.length === 0) {
            return;
        }

        console.log('Validating deployed contracts on current chain...');

        const validated = {};

        for (const [name, address] of entries) {
            if (!address) {
                continue;
            }
            try {
                const code = await this.provider.getCode(address);
                if (code && code !== '0x') {
                    validated[name] = address;
                    console.log(`  ${name}: code found at ${address}`);
                } else {
                    console.warn(`  ${name}: no code at ${address}; this contract type will be skipped`);
                }
            } catch (error) {
                console.warn(`  ${name}: failed to read code at ${address}: ${error.message}`);
            }
        }

        this.contracts = validated;
        console.log('Active contract types after validation:', Object.keys(this.contracts));
    }
    
    async initializeWalletNonces() {
        console.log('Initializing wallet nonces...');
        
        for (const walletInfo of this.wallets) {
            try {
                walletInfo.nonce = await this.provider.getTransactionCount(walletInfo.address, 'pending');
                console.log(`Wallet ${walletInfo.index} (${walletInfo.address}): nonce ${walletInfo.nonce}`);
            } catch (error) {
                console.error(`Failed to get nonce for wallet ${walletInfo.index}: ${error.message}`);
                walletInfo.nonce = 0; // Fallback nonce
            }
        }
    }
    
    getRandomWallet() {
        return this.wallets[Math.floor(Math.random() * this.wallets.length)];
    }
    
    getRandomAmount() {
        // Keep EVM value transfers very small to avoid draining limited balances
        return ethers.parseEther((Math.random() * 0.0001).toFixed(8));
    }

    getGasPrice(feeData) {
        if (feeData && feeData.gasPrice) {
            return feeData.gasPrice;
        }
        const fallbackGwei = process.env.EVM_GAS_PRICE_GWEI || '1';
        try {
            return ethers.parseUnits(fallbackGwei, 'gwei');
        } catch {
            return ethers.parseUnits('1', 'gwei');
        }
    }

    async resyncNonce(walletInfo) {
        try {
            const onChainNonce = await this.provider.getTransactionCount(walletInfo.address, 'pending');
            walletInfo.nonce = onChainNonce;
            console.log(`Resynced nonce for ${walletInfo.address} to ${onChainNonce}`);
        } catch (error) {
            console.error(`Failed to resync nonce for ${walletInfo.address}: ${error.message}`);
        }
    }
    
    async sendEthTransfer(walletInfo, toAddress, amount) {
        try {
            const feeData = await this.provider.getFeeData();
            const gasPrice = this.getGasPrice(feeData);
            
            // Use sequential nonce management with on-chain resync on errors
            const nonce = walletInfo.nonce;
            
            const estimatedGasLimit = 21000n;

            // Ensure the wallet has enough native balance to pay gas
            const balance = await this.provider.getBalance(walletInfo.address);
            const required = gasPrice * estimatedGasLimit;
            if (balance < required) {
                console.warn(
                    `Skipping ETH transfer from ${walletInfo.address}: ` +
                    `insufficient funds for gas (balance=${balance.toString()}, required=${required.toString()})`
                );
                return null;
            }

            const tx = {
                to: toAddress,
                value: amount,
                gasLimit: estimatedGasLimit,
                gasPrice,
                nonce: nonce,
                chainId: this.chainId
            };
            
            const signedTx = await walletInfo.wallet.signTransaction(tx);
            const txResponse = await this.provider.broadcastTransaction(signedTx);

            // Only advance nonce after a successful broadcast
            walletInfo.nonce = nonce + 1;
            
            console.log(`ETH transfer: ${walletInfo.address} -> ${toAddress} (${ethers.formatEther(amount)} ETH) - ${txResponse.hash}`);
            
            this.stats.successfulTxs++;
            this.metricsAnalyzer.recordTransaction(txResponse.hash, true);
            return txResponse;
        } catch (error) {
            console.error(`ETH transfer failed: ${error.message}`);
            this.stats.failedTxs++;
            this.metricsAnalyzer.recordTransaction(null, false, error);

            // Handle common nonce and fee errors by resyncing from chain
            const msg = error.message || '';
            if (
                msg.includes('nonce too low') ||
                msg.includes('replacement transaction underpriced') ||
                msg.includes('transaction nonce is too low') ||
                msg.includes('already known')
            ) {
                await this.resyncNonce(walletInfo);
            }
            return null;
        }
    }
    
    async sendContractCall(walletInfo, contractAddress, data, gasLimit = 100000) {
        try {
            const feeData = await this.provider.getFeeData();
            const gasPrice = this.getGasPrice(feeData);
            
            // Use sequential nonce management with on-chain resync on errors
            const nonce = walletInfo.nonce;
            
            const gasLimitBigInt = BigInt(gasLimit);

            // Ensure the wallet has enough native balance to pay gas
            const balance = await this.provider.getBalance(walletInfo.address);
            const required = gasPrice * gasLimitBigInt;
            if (balance < required) {
                console.warn(
                    `Skipping contract call from ${walletInfo.address}: ` +
                    `insufficient funds for gas (balance=${balance.toString()}, required=${required.toString()})`
                );
                return null;
            }

            const tx = {
                to: contractAddress,
                data: data,
                gasLimit: gasLimitBigInt,
                gasPrice,
                nonce: nonce,
                chainId: this.chainId
            };
            
            const signedTx = await walletInfo.wallet.signTransaction(tx);
            const txResponse = await this.provider.broadcastTransaction(signedTx);

            // Only advance nonce after a successful broadcast
            walletInfo.nonce = nonce + 1;
            
            console.log(`Contract call: ${walletInfo.address} -> ${contractAddress} - ${txResponse.hash}`);
            
            this.stats.successfulTxs++;
            this.metricsAnalyzer.recordTransaction(txResponse.hash, true);
            return txResponse;
        } catch (error) {
            console.error(`Contract call failed: ${error.message}`);
            this.stats.failedTxs++;
            this.metricsAnalyzer.recordTransaction(null, false, error);

            const msg = error.message || '';
            if (
                msg.includes('nonce too low') ||
                msg.includes('replacement transaction underpriced') ||
                msg.includes('transaction nonce is too low') ||
                msg.includes('already known')
            ) {
                await this.resyncNonce(walletInfo);
            }
            return null;
        }
    }
    
    generateERC20TransferData(toAddress, amount) {
        const iface = new ethers.Interface([
            "function transfer(address to, uint256 amount) returns (bool)"
        ]);
        return iface.encodeFunctionData("transfer", [toAddress, amount]);
    }
    
    generateERC20MintData(toAddress, amount) {
        const iface = new ethers.Interface([
            "function mint(address to, uint256 amount)"
        ]);
        return iface.encodeFunctionData("mint", [toAddress, amount]);
    }
    
    generateCounterIncrementData(amount = 1) {
        const iface = new ethers.Interface([
            "function incrementBy(uint256 amount)"
        ]);
        return iface.encodeFunctionData("incrementBy", [amount]);
    }
    
    generateStorageData(value) {
        const iface = new ethers.Interface([
            "function storeValue(uint256 value)"
        ]);
        return iface.encodeFunctionData("storeValue", [value]);
    }
    
    generateHeavyComputationData(iterations) {
        const iface = new ethers.Interface([
            "function heavyComputation(uint256 iterations) returns (uint256)"
        ]);
        return iface.encodeFunctionData("heavyComputation", [iterations]);
    }
    
    async spamEthTransfers(duration, tps) {
        console.log(`\nStarting ETH transfer spam: ${tps} TPS for ${duration}s`);
        
        const interval = 1000 / tps;
        const endTime = Date.now() + (duration * 1000);
        
        while (Date.now() < endTime) {
            const fromWallet = this.getRandomWallet();
            const toWallet = this.getRandomWallet();
            
            if (fromWallet !== toWallet) {
                const amount = this.getRandomAmount();
                await this.sendEthTransfer(fromWallet, toWallet.address, amount);
            }
            
            await this.sleep(interval);
        }
    }
    
    async spamContractCalls(duration, tps, contractType) {
        console.log(`\nStarting ${contractType} contract spam: ${tps} TPS for ${duration}s`);
        
        const contractAddress = this.contracts[contractType];
        if (!contractAddress) {
            console.error(`Contract ${contractType} not found in loaded contracts`);
            console.error('Available contracts:', Object.keys(this.contracts));
            return;
        }
        
        console.log(`Using ${contractType} contract at: ${contractAddress}`);
        
        const interval = 1000 / tps;
        const endTime = Date.now() + (duration * 1000);
        
        while (Date.now() < endTime) {
            const wallet = this.getRandomWallet();
            let data;
            let gasLimit = 100000;
            
            switch (contractType) {
                case 'erc20':
                    const targetWallet = this.getRandomWallet();
                    // Keep ERC20 amounts small (1–10 tokens) to avoid draining supply
                    const erc20Amount = ethers.parseUnits((Math.floor(Math.random() * 10) + 1).toString(), 18);
                    
                    // Always mint for reliability; transfers from unfunded wallets tend to revert
                    data = this.generateERC20MintData(targetWallet.address, erc20Amount);
                    break;
                    
                case 'counter':
                    const incrementAmount = Math.floor(Math.random() * 10) + 1;
                    data = this.generateCounterIncrementData(incrementAmount);
                    break;
                    
                case 'storage':
                    if (Math.random() > 0.7) {
                        const iterations = Math.floor(Math.random() * 500) + 100;
                        data = this.generateHeavyComputationData(iterations);
                        gasLimit = 500000;
                    } else {
                        const value = Math.floor(Math.random() * 1000000);
                        data = this.generateStorageData(value);
                    }
                    break;
                    
                default:
                    continue;
            }
            
            await this.sendContractCall(wallet, contractAddress, data, gasLimit);
            await this.sleep(interval);
        }
    }
    
    async mixedSpam(duration, tps) {
        console.log(`\nStarting mixed transaction spam: ${tps} TPS for ${duration}s`);
        
        const interval = 1000 / tps;
        const endTime = Date.now() + (duration * 1000);
        
        const operations = [
            { type: 'eth_transfer', weight: 30 },
            { type: 'erc20', weight: 25 },
            { type: 'counter', weight: 25 },
            { type: 'storage', weight: 20 }
        ];
        
        while (Date.now() < endTime) {
            const rand = Math.random() * 100;
            let cumWeight = 0;
            let selectedOp = operations[0];
            
            for (const op of operations) {
                cumWeight += op.weight;
                if (rand <= cumWeight) {
                    selectedOp = op;
                    break;
                }
            }
            
            const wallet = this.getRandomWallet();
            
            if (selectedOp.type === 'eth_transfer') {
                const toWallet = this.getRandomWallet();
                if (wallet !== toWallet) {
                    const amount = this.getRandomAmount();
                    await this.sendEthTransfer(wallet, toWallet.address, amount);
                }
            } else {
                await this.performContractOperation(wallet, selectedOp.type);
            }
            
            await this.sleep(interval);
        }
    }
    
    async performContractOperation(wallet, contractType) {
        const contractAddress = this.contracts[contractType];
        if (!contractAddress) return;
        
        let data, gasLimit = 100000;
        
        switch (contractType) {
            case 'erc20':
                const targetWallet = this.getRandomWallet();
                // Small mints (1–10 tokens)
                const erc20Amount = ethers.parseUnits((Math.floor(Math.random() * 10) + 1).toString(), 18);
                data = this.generateERC20MintData(targetWallet.address, erc20Amount);
                break;
                
            case 'counter':
                const incrementAmount = Math.floor(Math.random() * 5) + 1;
                data = this.generateCounterIncrementData(incrementAmount);
                break;
                
            case 'storage':
                if (Math.random() > 0.8) {
                    const iterations = Math.floor(Math.random() * 300) + 50;
                    data = this.generateHeavyComputationData(iterations);
                    gasLimit = 300000;
                } else {
                    const value = Math.floor(Math.random() * 1000000);
                    data = this.generateStorageData(value);
                }
                break;
        }
        
        if (data) {
            await this.sendContractCall(wallet, contractAddress, data, gasLimit);
        }
    }
    
    async concurrentSpam(duration, tpsPerWallet) {
        console.log(`\nStarting concurrent spam: ${tpsPerWallet} TPS per wallet (${this.wallets.length} wallets)`);
        
        const promises = this.wallets.map(async (wallet, index) => {
            const interval = 1000 / tpsPerWallet;
            const endTime = Date.now() + (duration * 1000);
            
            while (Date.now() < endTime) {
                await this.performContractOperation(wallet, 'counter');
                await this.sleep(interval + (index * 50)); // Slight offset per wallet
            }
        });
        
        await Promise.all(promises);
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    printStats() {
        const duration = this.stats.endTime - this.stats.startTime;
        const tps = this.stats.totalTxs / (duration / 1000);
        
        console.log('\n=== EVM Spam Statistics ===');
        console.log(`Duration: ${duration / 1000}s`);
        console.log(`Total transactions: ${this.stats.totalTxs}`);
        console.log(`Successful: ${this.stats.successfulTxs}`);
        console.log(`Failed: ${this.stats.failedTxs}`);
        console.log(`Success rate: ${((this.stats.successfulTxs / this.stats.totalTxs) * 100).toFixed(2)}%`);
        console.log(`Average TPS: ${tps.toFixed(2)}`);
    }
    
    async generateMetricsReport() {
        console.log('\n' + '='.repeat(50));
        console.log('Generating comprehensive metrics report...');
        
        try {
            // Update analyzer with our stats
            this.metricsAnalyzer.metrics.totalTransactions = this.stats.totalTxs;
            this.metricsAnalyzer.metrics.successfulTransactions = this.stats.successfulTxs;
            this.metricsAnalyzer.metrics.failedTransactions = this.stats.failedTxs;
            this.metricsAnalyzer.metrics.startTime = this.stats.startTime;
            this.metricsAnalyzer.metrics.endTime = this.stats.endTime;
            
            // Analyze blocks and generate report
            await this.metricsAnalyzer.analyzeBlocks();
            this.metricsAnalyzer.generateReport();
            
            // Save detailed report
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            this.metricsAnalyzer.saveDetailedReport(`detailed-metrics-${timestamp}.json`);
            
        } catch (error) {
            console.error('Failed to generate metrics report:', error.message);
        }
    }
    
    async run(mode = 'mixed', duration = 60, tps = 10) {
        await this.initializeWalletNonces();
        await this.validateContractsOnChain();
        await this.metricsAnalyzer.initialize();
        
        // Start mempool monitoring
        const stopMempool = await this.metricsAnalyzer.startMempoolMonitoring(3000);
        
        this.stats.startTime = Date.now();
        this.stats.totalTxs = 0;
        this.stats.successfulTxs = 0;
        this.stats.failedTxs = 0;
        
        const originalTotalTxs = this.stats.totalTxs;
        
        switch (mode) {
            case 'eth':
                await this.spamEthTransfers(duration, tps);
                break;
            case 'erc20':
                await this.spamContractCalls(duration, tps, 'erc20');
                break;
            case 'counter':
                await this.spamContractCalls(duration, tps, 'counter');
                break;
            case 'storage':
                await this.spamContractCalls(duration, tps, 'storage');
                break;
            case 'mixed':
                await this.mixedSpam(duration, tps);
                break;
            case 'concurrent':
                await this.concurrentSpam(duration, tps);
                break;
            default:
                console.error('Unknown mode:', mode);
                return;
        }
        
        this.stats.endTime = Date.now();
        this.stats.totalTxs = this.stats.successfulTxs + this.stats.failedTxs;
        
        // Stop mempool monitoring
        if (stopMempool) stopMempool();
        
        this.printStats();
        
        // Generate comprehensive metrics report
        await this.generateMetricsReport();
    }
}

async function main() {
    const args = process.argv.slice(2);
    const mode = args[0] || 'mixed';
    const duration = parseInt(args[1]) || 60;
    const tps = parseInt(args[2]) || 10;
    
    console.log(`Starting EVM spam test:`);
    console.log(`Mode: ${mode}`);
    console.log(`Duration: ${duration}s`);
    console.log(`TPS: ${tps}`);
    
    const spammer = new EVMSpammer();
    await spammer.run(mode, duration, tps);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export default EVMSpammer;
