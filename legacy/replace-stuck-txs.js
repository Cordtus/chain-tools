#!/usr/bin/env node
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

class StuckTransactionReplacer {
    constructor() {
        this.evmRpcUrl = process.env.RPC_URL || 'http://localhost:8545';
        this.provider = new ethers.JsonRpcProvider(this.evmRpcUrl);
        this.chainId = 262144;
        
        // Fee configuration
        this.baseGasPrice = ethers.parseUnits('2', 'gwei');  // 2 gwei base
        this.priorityFee = ethers.parseUnits('0.5', 'gwei'); // 0.5 gwei tip
        this.maxFeePerGas = this.baseGasPrice + this.priorityFee; // 2.5 gwei total
        
        this.stats = {
            analyzed: 0,
            attempted: 0,
            successful: 0,
            failed: 0,
            errors: []
        };
    }

    async getAllQueuedTransactions() {
        try {
            console.log(' Fetching all queued transactions from mempool...');
            
            const txpoolContent = await this.provider.send('txpool_content', []);
            const queuedTxs = txpoolContent.result?.queued || {};
            
            console.log(`Found queued transactions for ${Object.keys(queuedTxs).length} addresses`);
            
            let allStuckTxs = [];
            for (const [address, nonceTxs] of Object.entries(queuedTxs)) {
                console.log(`  ${address}: ${Object.keys(nonceTxs).length} transactions`);
                
                for (const [nonce, tx] of Object.entries(nonceTxs)) {
                    allStuckTxs.push({
                        address: address.toLowerCase(),
                        nonce: parseInt(nonce),
                        originalHash: tx.hash,
                        to: tx.to,
                        value: tx.value || '0x0',
                        data: tx.input || '0x',
                        gasLimit: tx.gas,
                        originalGasPrice: tx.gasPrice || '0x0',
                        type: tx.type || '0x0'
                    });
                }
            }
            
            // Sort by address, then by nonce
            allStuckTxs.sort((a, b) => {
                if (a.address !== b.address) return a.address.localeCompare(b.address);
                return a.nonce - b.nonce;
            });
            
            this.stats.analyzed = allStuckTxs.length;
            console.log(`\n Total stuck transactions found: ${allStuckTxs.length}\n`);
            
            return allStuckTxs;
        } catch (error) {
            console.error(' Error fetching queued transactions:', error.message);
            return [];
        }
    }

    async loadWallets() {
        const privateKeys = [
            process.env.PRIVATE_KEY,
            process.env.PRIVATE_KEY_1, 
            process.env.PRIVATE_KEY_2,
            process.env.PRIVATE_KEY_3
        ].filter(Boolean);
        
        const wallets = {};
        for (const key of privateKeys) {
            try {
                const wallet = new ethers.Wallet(key, this.provider);
                wallets[wallet.address.toLowerCase()] = wallet;
                console.log(` Loaded wallet: ${wallet.address}`);
            } catch (error) {
                console.error(` Failed to load wallet: ${error.message}`);
            }
        }
        
        console.log(`\n Loaded ${Object.keys(wallets).length} wallets\n`);
        return wallets;
    }

    async replaceTransaction(stuckTx, wallet) {
        try {
            console.log(` Replacing transaction:`);
            console.log(`  Original Hash: ${stuckTx.originalHash}`);
            console.log(`  Nonce: ${stuckTx.nonce}`);
            console.log(`  From: ${stuckTx.address}`);
            console.log(`  To: ${stuckTx.to || 'Contract Creation'}`);
            console.log(`  Value: ${ethers.formatEther(stuckTx.value || '0')} ETH`);
            console.log(`  Original Gas Price: ${ethers.formatUnits(stuckTx.originalGasPrice || '0', 'gwei')} gwei`);
            console.log(`  New Max Fee: ${ethers.formatUnits(this.maxFeePerGas, 'gwei')} gwei`);
            console.log(`  Priority Fee: ${ethers.formatUnits(this.priorityFee, 'gwei')} gwei`);

            // Create replacement transaction with EIP-1559 fees
            const replacementTx = {
                to: stuckTx.to || null, // null for contract creation
                value: stuckTx.value,
                data: stuckTx.data,
                gasLimit: stuckTx.gasLimit,
                nonce: stuckTx.nonce,
                chainId: this.chainId,
                type: 2, // EIP-1559 transaction type
                maxFeePerGas: this.maxFeePerGas,
                maxPriorityFeePerGas: this.priorityFee
            };

            // Sign and send the replacement transaction
            const signedTx = await wallet.signTransaction(replacementTx);
            const txResponse = await this.provider.broadcastTransaction(signedTx);
            
            console.log(`   Replacement Transaction Hash: ${txResponse.hash}`);
            console.log('');
            
            this.stats.successful++;
            return txResponse;
            
        } catch (error) {
            console.log(`   Replacement Failed: ${error.message}`);
            console.log('');
            
            this.stats.failed++;
            this.stats.errors.push({
                originalHash: stuckTx.originalHash,
                nonce: stuckTx.nonce,
                error: error.message
            });
            
            return null;
        }
    }

    async replaceAllStuckTransactions() {
        console.log(' Starting Stuck Transaction Replacement Process\n');
        console.log(`Configuration:`);
        console.log(`  Base Gas Price: ${ethers.formatUnits(this.baseGasPrice, 'gwei')} gwei`);
        console.log(`  Priority Fee: ${ethers.formatUnits(this.priorityFee, 'gwei')} gwei`);
        console.log(`  Max Fee Per Gas: ${ethers.formatUnits(this.maxFeePerGas, 'gwei')} gwei`);
        console.log(`  Chain ID: ${this.chainId}\n`);
        
        // Load wallets
        const wallets = await this.loadWallets();
        if (Object.keys(wallets).length === 0) {
            console.error(' No wallets loaded. Please check your private keys in .env');
            return;
        }
        
        // Get all stuck transactions
        const stuckTxs = await this.getAllQueuedTransactions();
        if (stuckTxs.length === 0) {
            console.log(' No stuck transactions found in mempool');
            return;
        }
        
        // Group transactions by wallet
        const walletGroups = {};
        for (const tx of stuckTxs) {
            if (!walletGroups[tx.address]) {
                walletGroups[tx.address] = [];
            }
            walletGroups[tx.address].push(tx);
        }
        
        console.log(' Transaction Summary by Wallet:');
        for (const [address, txs] of Object.entries(walletGroups)) {
            const wallet = wallets[address];
            const status = wallet ? ' Have Wallet' : ' No Wallet';
            console.log(`  ${address}: ${txs.length} transactions [${status}]`);
        }
        console.log('');
        
        // Replace transactions wallet by wallet
        for (const [address, txs] of Object.entries(walletGroups)) {
            const wallet = wallets[address];
            if (!wallet) {
                console.log(`  Skipping ${txs.length} transactions for ${address} (no wallet available)`);
                continue;
            }
            
            console.log(` Processing ${txs.length} stuck transactions for ${address}:`);
            console.log('─'.repeat(80));
            
            // Sort by nonce to process in order
            txs.sort((a, b) => a.nonce - b.nonce);
            
            for (const tx of txs) {
                this.stats.attempted++;
                await this.replaceTransaction(tx, wallet);
                
                // Small delay between replacements to avoid overwhelming the node
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            
            console.log('─'.repeat(80));
            console.log('');
        }
        
        this.printResults();
    }
    
    printResults() {
        console.log('\n' + '='.repeat(60));
        console.log('           STUCK TRANSACTION REPLACEMENT RESULTS');
        console.log('='.repeat(60));
        console.log(`Transactions Analyzed: ${this.stats.analyzed}`);
        console.log(`Replacement Attempts: ${this.stats.attempted}`);
        console.log(`Successful Replacements: ${this.stats.successful}`);
        console.log(`Failed Replacements: ${this.stats.failed}`);
        
        if (this.stats.attempted > 0) {
            const successRate = (this.stats.successful / this.stats.attempted * 100).toFixed(2);
            console.log(`Success Rate: ${successRate}%`);
        }
        
        if (this.stats.errors.length > 0) {
            console.log(`\nError Summary:`);
            for (const error of this.stats.errors.slice(0, 5)) { // Show first 5 errors
                console.log(`  Nonce ${error.nonce}: ${error.error}`);
            }
            if (this.stats.errors.length > 5) {
                console.log(`  ... and ${this.stats.errors.length - 5} more errors`);
            }
        }
        
        console.log('\n Next Steps:');
        console.log('  - Check mempool status: node mempool-dashboard-fixed.js');
        console.log('  - Monitor replacement transactions for inclusion in blocks');
        console.log('  - Original stuck transactions should be replaced automatically');
        console.log('='.repeat(60));
    }
}

async function main() {
    const replacer = new StuckTransactionReplacer();
    await replacer.replaceAllStuckTransactions();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export default StuckTransactionReplacer;