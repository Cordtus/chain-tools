#!/usr/bin/env node
import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

class NonceRangeReplacer {
    constructor() {
        this.evmRpcUrl = process.env.RPC_URL || 'http://localhost:8545';
        this.provider = new ethers.JsonRpcProvider(this.evmRpcUrl);
        this.chainId = 262144;
        
        // Fee configuration - using positive values
        this.baseGasPrice = ethers.parseUnits('1', 'gwei');    // 1 gwei base
        this.priorityFee = ethers.parseUnits('0.1', 'gwei');   // 0.1 gwei tip  
        this.maxFeePerGas = ethers.parseUnits('1.2', 'gwei');  // 1.2 gwei max
        
        this.stats = {
            attempted: 0,
            successful: 0,
            failed: 0,
            errors: []
        };
    }

    async loadWallets() {
        const privateKeys = [
            process.env.PRIVATE_KEY,
            process.env.PRIVATE_KEY_1, 
            process.env.PRIVATE_KEY_2,
            process.env.PRIVATE_KEY_3
        ].filter(Boolean);
        
        const wallets = [];
        for (const key of privateKeys) {
            try {
                const wallet = new ethers.Wallet(key, this.provider);
                const currentNonce = await this.provider.getTransactionCount(wallet.address, 'latest');
                const pendingNonce = await this.provider.getTransactionCount(wallet.address, 'pending');
                
                wallets.push({
                    wallet: wallet,
                    address: wallet.address,
                    latestNonce: currentNonce,
                    pendingNonce: pendingNonce,
                    stuckRange: pendingNonce - currentNonce
                });
                
                console.log(` ${wallet.address}:`);
                console.log(`   Latest nonce: ${currentNonce}`);
                console.log(`   Pending nonce: ${pendingNonce}`);
                console.log(`   Stuck txs: ${pendingNonce - currentNonce}`);
                
            } catch (error) {
                console.error(` Failed to load wallet: ${error.message}`);
            }
        }
        
        return wallets;
    }

    async createReplacementTransaction(wallet, nonce, originalTx = null) {
        try {
            // Create a simple ETH transfer as replacement (minimal gas usage)
            const toAddress = wallet.address; // Send to self to minimize complexity
            const value = ethers.parseUnits('0.000001', 'ether'); // Tiny amount
            
            const tx = {
                to: toAddress,
                value: value,
                gasLimit: 21000, // Standard ETH transfer gas limit
                nonce: nonce,
                chainId: this.chainId,
                type: 2, // EIP-1559 transaction
                maxFeePerGas: this.maxFeePerGas,
                maxPriorityFeePerGas: this.priorityFee
            };

            const signedTx = await wallet.wallet.signTransaction(tx);
            const txResponse = await this.provider.broadcastTransaction(signedTx);
            
            console.log(`   Replaced nonce ${nonce}: ${txResponse.hash}`);
            this.stats.successful++;
            
            return txResponse;
            
        } catch (error) {
            console.log(`   Failed nonce ${nonce}: ${error.message}`);
            this.stats.failed++;
            this.stats.errors.push({ nonce, error: error.message });
            return null;
        }
    }

    async replaceStuckTransactionsForWallet(walletInfo) {
        const { wallet, address, latestNonce, pendingNonce, stuckRange } = walletInfo;
        
        if (stuckRange <= 0) {
            console.log(` ${address}: No stuck transactions\n`);
            return;
        }
        
        console.log(` Replacing ${stuckRange} stuck transactions for ${address}:`);
        console.log('─'.repeat(60));
        
        // Replace each stuck nonce with a proper fee transaction
        for (let nonce = latestNonce; nonce < pendingNonce; nonce++) {
            this.stats.attempted++;
            await this.createReplacementTransaction(walletInfo, nonce);
            
            // Small delay between replacements
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        
        console.log('─'.repeat(60));
        console.log('');
    }

    async run() {
        console.log(' Nonce Range Transaction Replacement Tool\n');
        console.log('This tool replaces stuck zero-fee transactions with proper fee transactions');
        console.log('using the same nonces but with adequate gas prices and priority fees.\n');
        
        console.log(`Fee Configuration:`);
        console.log(`  Base Gas Price: ${ethers.formatUnits(this.baseGasPrice, 'gwei')} gwei`);
        console.log(`  Priority Fee: ${ethers.formatUnits(this.priorityFee, 'gwei')} gwei`);
        console.log(`  Max Fee Per Gas: ${ethers.formatUnits(this.maxFeePerGas, 'gwei')} gwei\n`);
        
        // Load all wallets and analyze stuck ranges
        const wallets = await this.loadWallets();
        console.log('');
        
        if (wallets.length === 0) {
            console.error(' No wallets available for replacement');
            return;
        }
        
        // Replace stuck transactions for each wallet
        for (const walletInfo of wallets) {
            await this.replaceStuckTransactionsForWallet(walletInfo);
        }
        
        this.printFinalResults();
    }
    
    printFinalResults() {
        console.log('='.repeat(60));
        console.log('           NONCE REPLACEMENT RESULTS');
        console.log('='.repeat(60));
        console.log(`Replacement Attempts: ${this.stats.attempted}`);
        console.log(`Successful: ${this.stats.successful}`);
        console.log(`Failed: ${this.stats.failed}`);
        
        if (this.stats.attempted > 0) {
            const successRate = (this.stats.successful / this.stats.attempted * 100).toFixed(2);
            console.log(`Success Rate: ${successRate}%`);
        }
        
        if (this.stats.errors.length > 0) {
            console.log(`\n Error Summary (first 5):`);
            for (const error of this.stats.errors.slice(0, 5)) {
                console.log(`  Nonce ${error.nonce}: ${error.error}`);
            }
            if (this.stats.errors.length > 5) {
                console.log(`  ... and ${this.stats.errors.length - 5} more errors`);
            }
        }
        
        console.log('\n Check mempool status after replacement:');
        console.log('  curl -X POST -H "Content-Type: application/json" \\');
        console.log('    --data \'{"jsonrpc":"2.0","method":"txpool_status","params":[],"id":1}\' \\');
        console.log('    http://localhost:8545');
        console.log('='.repeat(60));
    }
}

async function main() {
    const replacer = new NonceRangeReplacer();
    await replacer.run();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export default NonceRangeReplacer;