import { ethers } from 'ethers';
import { bech32 } from 'bech32';
import dotenv from 'dotenv';
import fetch from 'node-fetch';

// Cosmos signing imports (from faucet)
import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { toBase64 } from '@cosmjs/encoding';
import { makeAuthInfoBytes, makeSignDoc } from "@cosmjs/proto-signing";
import { TxRaw, SignDoc, TxBody } from "cosmjs-types/cosmos/tx/v1beta1/tx.js";
import { Any } from "cosmjs-types/google/protobuf/any.js";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx.js";
import Long from "long";

dotenv.config();

class UnifiedDualSpammer {
    constructor() {
        this.evmRpcUrl = process.env.RPC_URL || 'http://localhost:8545';
        this.cosmosRestUrl = process.env.COSMOS_REST_URL || 'http://localhost:1317';
        this.evmProvider = new ethers.JsonRpcProvider(this.evmRpcUrl);
        this.chainId = 262144; // EVM chain ID
        this.cosmosChainId = '9001'; // Cosmos chain ID
        
        this.wallets = [];
        this.contracts = this.loadContracts();
        
        this.stats = {
            totalTxs: 0,
            evmTxs: 0,
            cosmosTxs: 0,
            successfulTxs: 0,
            failedTxs: 0,
            startTime: null,
            endTime: null
        };
        
        console.log('Initialized Unified Dual Spammer');
    }
    
    loadContracts() {
        return {
            erc20: process.env.TEST_ERC20_CONTRACT,
            storage: process.env.TEST_STORAGE_CONTRACT,
            counter: process.env.TEST_COUNTER_CONTRACT
        };
    }
    
    deriveCosmosAddress(evmAddress) {
        const addressBytes = Buffer.from(evmAddress.replace('0x', ''), 'hex');
        const words = bech32.toWords(addressBytes);
        return bech32.encode('cosmos', words);
    }
    
    async initializeWallets() {
        console.log('Initializing unified wallets with shared sequence tracking...');
        
        const privateKeys = [
            process.env.PRIVATE_KEY,
            process.env.PRIVATE_KEY_1, 
            process.env.PRIVATE_KEY_2,
            process.env.PRIVATE_KEY_3
        ].filter(Boolean);
        
        for (let i = 0; i < privateKeys.length; i++) {
            try {
                // Create EVM wallet
                const evmWallet = new ethers.Wallet(privateKeys[i], this.evmProvider);
                const evmAddress = evmWallet.address;
                
                // Derive cosmos address
                const cosmosAddress = this.deriveCosmosAddress(evmAddress);
                
                // Get current sequence from network (shared between EVM and Cosmos)
                const currentSequence = await this.evmProvider.getTransactionCount(evmAddress, 'pending');
                
                // Prepare crypto materials
                const privateKeyBytes = Buffer.from(privateKeys[i].replace('0x', ''), 'hex');
                const publicKeyBytes = Buffer.from(secp256k1.getPublicKey(privateKeyBytes, true));
                
                this.wallets.push({
                    index: i,
                    evmWallet: evmWallet,
                    evmAddress: evmAddress,
                    cosmosAddress: cosmosAddress,
                    privateKeyBytes: privateKeyBytes,
                    publicKeyBytes: publicKeyBytes,
                    sequence: currentSequence, // Shared sequence for both EVM and Cosmos
                    privateKeyHex: privateKeys[i]
                });
                
                console.log(`Wallet ${i}: EVM(${evmAddress})  Cosmos(${cosmosAddress}) - Sequence: ${currentSequence}`);
                
            } catch (error) {
                console.error(`Failed to initialize wallet ${i}:`, error.message);
            }
        }
        
        console.log(`Initialized ${this.wallets.length} unified wallets`);
    }
    
    async sendEvmTransaction(wallet, type) {
        try {
            const feeData = await this.evmProvider.getFeeData();
            let tx;
            
            if (type === 'eth_transfer') {
                const toWallet = this.getRandomWallet();
                if (wallet === toWallet) return null;
                
                const amount = ethers.parseEther((Math.random() * 0.001).toFixed(6));
                tx = {
                    to: toWallet.evmAddress,
                    value: amount,
                    gasLimit: 21000,
                    gasPrice: feeData.gasPrice,
                    nonce: wallet.sequence,
                    chainId: this.chainId
                };
            } else {
                // Contract call
                const contractAddress = this.contracts.counter;
                const iface = new ethers.Interface(["function incrementBy(uint256 amount)"]);
                const data = iface.encodeFunctionData("incrementBy", [Math.floor(Math.random() * 5) + 1]);
                
                tx = {
                    to: contractAddress,
                    data: data,
                    gasLimit: 100000,
                    gasPrice: feeData.gasPrice,
                    nonce: wallet.sequence,
                    chainId: this.chainId
                };
            }
            
            wallet.sequence++; // Increment shared sequence
            
            const signedTx = await wallet.evmWallet.signTransaction(tx);
            const txResponse = await this.evmProvider.broadcastTransaction(signedTx);
            
            console.log(`EVM ${type}: ${wallet.evmAddress} - ${txResponse.hash} (seq: ${wallet.sequence - 1})`);
            
            this.stats.evmTxs++;
            this.stats.successfulTxs++;
            return txResponse;
            
        } catch (error) {
            console.error(`EVM ${type} failed: ${error.message}`);
            this.stats.failedTxs++;
            return null;
        }
    }
    
    async sendCosmosTransaction(wallet) {
        try {
            const toWallet = this.getRandomWallet();
            if (wallet === toWallet) return null;
            
            const amount = Math.floor(Math.random() * 1000000) + 100000;
            
            // Get account info
            const accountInfo = await this.getAccountInfo(wallet.cosmosAddress);
            
            // Use our tracked sequence instead of network sequence
            const sequence = wallet.sequence;
            wallet.sequence++; // Increment shared sequence
            
            // Create transaction (exact faucet logic)
            const messages = [{
                typeUrl: "/cosmos.bank.v1beta1.MsgSend",
                value: MsgSend.fromPartial({
                    fromAddress: wallet.cosmosAddress,
                    toAddress: toWallet.cosmosAddress,
                    amount: [{ denom: 'atest', amount: amount.toString() }]
                })
            }];
            
            const txBody = TxBody.fromPartial({
                messages: messages.map(msg => Any.fromPartial({
                    typeUrl: msg.typeUrl,
                    value: MsgSend.encode(msg.value).finish()
                })),
                memo: ""
            });
            
            // Create auth info with eth_secp256k1 pubkey
            const pubkeyBytes = wallet.publicKeyBytes;
            const fieldTag = (1 << 3) | 2;
            const pubkeyProto = Buffer.concat([
                Buffer.from([fieldTag]),
                Buffer.from([pubkeyBytes.length]),
                pubkeyBytes
            ]);
            
            const pubkey = Any.fromPartial({
                typeUrl: "/cosmos.evm.crypto.v1.ethsecp256k1.PubKey",
                value: pubkeyProto
            });
            
            const authInfo = makeAuthInfoBytes(
                [{ pubkey, sequence: Long.fromNumber(sequence) }],
                [{ denom: 'atest', amount: '5000' }],
                Long.fromString('200000'),
                undefined,
                undefined,
            );
            
            const signDoc = makeSignDoc(
                TxBody.encode(txBody).finish(),
                authInfo,
                this.cosmosChainId,
                Long.fromNumber(accountInfo.accountNumber)
            );
            
            // Sign with eth_secp256k1
            const signBytes = SignDoc.encode(signDoc).finish();
            const hashedMessage = Buffer.from(keccak_256(signBytes));
            const signature = secp256k1.sign(hashedMessage, wallet.privateKeyBytes);
            
            // Extract r and s (compatible with both noble versions)
            let rHex, sHex;
            if (signature.r && signature.s) {
                rHex = signature.r.toString(16).padStart(64, '0');
                sHex = signature.s.toString(16).padStart(64, '0');
            } else {
                const rawBytes = signature.toCompactRawBytes();
                rHex = Buffer.from(rawBytes.slice(0, 32)).toString('hex');
                sHex = Buffer.from(rawBytes.slice(32, 64)).toString('hex');
            }
            
            const signatureBytes = Buffer.concat([
                Buffer.from(rHex, 'hex'),
                Buffer.from(sHex, 'hex')
            ]);
            
            // Construct and broadcast
            const txRaw = TxRaw.fromPartial({
                bodyBytes: TxBody.encode(txBody).finish(),
                authInfoBytes: authInfo,
                signatures: [signatureBytes],
            });
            
            const txBytes = TxRaw.encode(txRaw).finish();
            const txBase64 = toBase64(txBytes);
            
            const broadcastResponse = await fetch(`${this.cosmosRestUrl}/cosmos/tx/v1beta1/txs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tx_bytes: txBase64,
                    mode: 'BROADCAST_MODE_SYNC'
                })
            });
            
            const result = await broadcastResponse.json();
            
            if (result.tx_response && result.tx_response.code === 0) {
                console.log(`Cosmos send: ${wallet.cosmosAddress} -> ${toWallet.cosmosAddress} (${amount}atest) - ${result.tx_response.txhash} (seq: ${sequence})`);
                this.stats.cosmosTxs++;
                this.stats.successfulTxs++;
                return result;
            } else {
                console.error(`Cosmos send failed: ${result.tx_response?.raw_log || 'Unknown error'}`);
                this.stats.failedTxs++;
                return null;
            }
            
        } catch (error) {
            console.error(`Cosmos send error: ${error.message}`);
            this.stats.failedTxs++;
            return null;
        }
    }
    
    async getAccountInfo(address) {
        try {
            const response = await fetch(`${this.cosmosRestUrl}/cosmos/auth/v1beta1/accounts/${address}`);
            if (!response.ok) {
                return { accountNumber: 0, sequence: 0 };
            }
            
            const data = await response.json();
            if (data.account?.['@type']?.includes('EthAccount')) {
                return {
                    accountNumber: parseInt(data.account.base_account?.account_number || '0'),
                    sequence: parseInt(data.account.base_account?.sequence || '0')
                };
            }
            return { accountNumber: 0, sequence: 0 };
        } catch (error) {
            return { accountNumber: 0, sequence: 0 };
        }
    }
    
    getRandomWallet() {
        return this.wallets[Math.floor(Math.random() * this.wallets.length)];
    }
    
    async runDualSpam(duration, evmTps, cosmosTps) {
        await this.initializeWallets();
        
        this.stats.startTime = Date.now();
        const endTime = Date.now() + (duration * 1000);
        
        console.log(`\nStarting unified dual-chain spam:`);
        console.log(`EVM: ${evmTps} TPS, Cosmos: ${cosmosTps} TPS for ${duration}s`);
        console.log(`Total target: ${evmTps + cosmosTps} TPS with shared sequence tracking\n`);
        
        // Calculate intervals
        const evmInterval = 1000 / evmTps;
        const cosmosInterval = 1000 / cosmosTps;
        
        let lastEvmTx = 0;
        let lastCosmosTx = 0;
        
        while (Date.now() < endTime) {
            const now = Date.now();
            const wallet = this.getRandomWallet();
            
            // Send EVM transaction if interval elapsed
            if (now - lastEvmTx >= evmInterval) {
                const txType = Math.random() > 0.3 ? 'contract' : 'eth_transfer';
                await this.sendEvmTransaction(wallet, txType);
                lastEvmTx = now;
            }
            
            // Send Cosmos transaction if interval elapsed
            if (now - lastCosmosTx >= cosmosInterval) {
                await this.sendCosmosTransaction(wallet);
                lastCosmosTx = now;
            }
            
            // Small delay to prevent overwhelming
            await this.sleep(50);
        }
        
        this.stats.endTime = Date.now();
        this.stats.totalTxs = this.stats.evmTxs + this.stats.cosmosTxs;
        
        this.printResults();
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    printResults() {
        const duration = (this.stats.endTime - this.stats.startTime) / 1000;
        const totalTps = this.stats.totalTxs / duration;
        
        console.log('\n' + '='.repeat(60));
        console.log('           UNIFIED DUAL-CHAIN RESULTS');
        console.log('='.repeat(60));
        console.log(`Duration: ${duration.toFixed(2)}s`);
        console.log(`Total Transactions: ${this.stats.totalTxs}`);
        console.log(`  EVM Transactions: ${this.stats.evmTxs}`);
        console.log(`  Cosmos Transactions: ${this.stats.cosmosTxs}`);
        console.log(`Successful: ${this.stats.successfulTxs}`);
        console.log(`Failed: ${this.stats.failedTxs}`);
        console.log(`Success Rate: ${((this.stats.successfulTxs / this.stats.totalTxs) * 100).toFixed(2)}%`);
        console.log(`Average TPS: ${totalTps.toFixed(2)}`);
        console.log(`  EVM TPS: ${(this.stats.evmTxs / duration).toFixed(2)}`);
        console.log(`  Cosmos TPS: ${(this.stats.cosmosTxs / duration).toFixed(2)}`);
        console.log('='.repeat(60));
    }
}

async function main() {
    const args = process.argv.slice(2);
    const duration = parseInt(args[0]) || 120;
    const evmTps = parseInt(args[1]) || 6;
    const cosmosTps = parseInt(args[2]) || 3;
    
    const spammer = new UnifiedDualSpammer();
    await spammer.runDualSpam(duration, evmTps, cosmosTps);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export default UnifiedDualSpammer;