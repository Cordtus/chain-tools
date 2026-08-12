#!/usr/bin/env node
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

class TransactionReplacer {
    constructor() {
        this.evmRpcUrl = process.env.RPC_URL || 'http://localhost:8545';
        this.provider = new ethers.JsonRpcProvider(this.evmRpcUrl);
        this.chainId = 262144;
        
        this.stats = {
            attempted: 0,
            successful: 0,
            failed: 0
        };
    }

    async getStuckTransactions() {
        try {
            const txpoolContent = await this.provider.send('txpool_content', []);
            const queuedTxs = txpoolContent.result?.queued || {};
            
            console.log(`Found queued transactions for ${Object.keys(queuedTxs).length} addresses`);
            
            let stuckTxs = [];
            for (const [address, nonceTxs] of Object.entries(queuedTxs)) {
                for (const [nonce, tx] of Object.entries(nonceTxs)) {
                    stuckTxs.push({
                        address: address,
                        nonce: parseInt(nonce),
                        hash: tx.hash,
                        to: tx.to,
                        value: tx.value,
                        data: tx.input,
                        gasLimit: tx.gas,
                        gasPrice: tx.gasPrice,
                        type: tx.type
                    });
                }
            }
            
            // Sort by address and nonce
            stuckTxs.sort((a, b) => {
                if (a.address !== b.address) return a.address.localeCompare(b.address);
                return a.nonce - b.nonce;
            });
            
            return stuckTxs;
        } catch (error) {
            console.error('Error fetching stuck transactions:', error.message);
            return [];
        }
    }

    async replaceTransaction(stuckTx, wallet) {
        try {
            // Get current fee data
            const feeData = await this.provider.getFeeData();
            
            // Use higher gas price and priority fee
            const baseGasPrice = feeData.gasPrice || ethers.parseUnits('1', 'gwei');
            const newGasPrice = baseGasPrice * 2n; // Double the base gas price
            const priorityFee = ethers.parseUnits('0.1', 'gwei'); // Add priority fee
            
            console.log(`Replacing tx ${stuckTx.hash} (nonce: ${stuckTx.nonce})`);
            console.log(`  Old gas price: ${stuckTx.gasPrice} (${ethers.formatUnits(stuckTx.gasPrice || '0', 'gwei')} gwei)`);
            console.log(`  New gas price: ${newGasPrice} (${ethers.formatUnits(newGasPrice, 'gwei')} gwei)`);
            
            // Create replacement transaction with higher fees
            const tx = {
                to: stuckTx.to,
                value: stuckTx.value,
                data: stuckTx.data,
                gasLimit: stuckTx.gasLimit,
                nonce: stuckTx.nonce,
                chainId: this.chainId,
                type: 2, // EIP-1559 transaction
                maxFeePerGas: newGasPrice,
                maxPriorityFeePerGas: priorityFee
            };

            const signedTx = await wallet.signTransaction(tx);
            const txResponse = await this.provider.broadcastTransaction(signedTx);
            
            console.log(` Replacement successful: ${txResponse.hash}`);
            this.stats.successful++;
            
            return txResponse;
        } catch (error) {
            console.error(` Replacement failed: ${error.message}`);
            this.stats.failed++;
            return null;
        }
    }

    async replaceAllStuckTransactions() {
        console.log(' Analyzing stuck transactions in mempool...\n');
        
        const stuckTxs = await this.getStuckTransactions();
        
        if (stuckTxs.length === 0) {
            console.log('No stuck transactions found in mempool');
            return;
        }
        
        console.log(`Found ${stuckTxs.length} stuck transactions\n`);
        
        // Group by wallet address
        const walletGroups = {};
        for (const tx of stuckTxs) {
            if (!walletGroups[tx.address]) {
                walletGroups[tx.address] = [];
            }
            walletGroups[tx.address].push(tx);
        }
        
        // Load wallets
        const privateKeys = [
            process.env.PRIVATE_KEY,
            process.env.PRIVATE_KEY_1, 
            process.env.PRIVATE_KEY_2,
            process.env.PRIVATE_KEY_3
        ].filter(Boolean);
        
        const wallets = {};
        for (const key of privateKeys) {
            const wallet = new ethers.Wallet(key, this.provider);
            wallets[wallet.address.toLowerCase()] = wallet;
        }
        
        console.log(`Loaded ${Object.keys(wallets).length} wallets\n`);
        
        // Replace transactions
        for (const [address, txs] of Object.entries(walletGroups)) {
            const wallet = wallets[address.toLowerCase()];
            if (!wallet) {
                console.log(`  No wallet found for address ${address} (${txs.length} stuck txs)`);
                continue;
            }
            
            console.log(` Processing ${txs.length} stuck transactions for ${address}:`);
            
            // Process in nonce order (lowest first)
            txs.sort((a, b) => a.nonce - b.nonce);
            
            for (const tx of txs) {
                this.stats.attempted++;
                await this.replaceTransaction(tx, wallet);
                
                // Small delay between replacements
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            
            console.log(''); // Empty line between wallets
        }
        
        this.printResults();
    }
    
    printResults() {
        console.log('\n' + '='.repeat(50));
        console.log('         TRANSACTION REPLACEMENT RESULTS');
        console.log('='.repeat(50));
        console.log(`Attempted: ${this.stats.attempted}`);
        console.log(`Successful: ${this.stats.successful}`);
        console.log(`Failed: ${this.stats.failed}`);
        console.log(`Success Rate: ${((this.stats.successful / this.stats.attempted) * 100).toFixed(2)}%`);
        console.log('='.repeat(50));
    }
}

async function main() {
    const replacer = new TransactionReplacer();
    await replacer.replaceAllStuckTransactions();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export default TransactionReplacer;