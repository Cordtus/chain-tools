import { ethers } from 'ethers';
import { bech32 } from 'bech32';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { toBase64 } from '@cosmjs/encoding';
import { makeAuthInfoBytes, makeSignDoc } from "@cosmjs/proto-signing";
import { TxRaw, SignDoc, TxBody } from "cosmjs-types/cosmos/tx/v1beta1/tx.js";
import { Any } from "cosmjs-types/google/protobuf/any.js";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx.js";
import Long from "long";

dotenv.config();

class TestTransactionGenerator {
    constructor() {
        this.rpcUrl = process.env.COSMOS_RPC_URL || 'http://localhost:26657';
        this.restUrl = process.env.COSMOS_REST_URL || 'http://localhost:1317';
        this.chainId = '9001';
        this.wallets = [];
        this.txHashes = [];
        this.successCount = 0;
        this.failureCount = 0;
    }

    // Convert EVM address to cosmos bech32 address
    deriveCosmosAddress(evmAddress) {
        const addressBytes = Buffer.from(evmAddress.replace('0x', ''), 'hex');
        const words = bech32.toWords(addressBytes);
        return bech32.encode('cosmos', words);
    }

    async initializeWallets() {
        console.log('Initializing wallets...\n');

        const privateKeys = [
            process.env.PRIVATE_KEY,
            process.env.PRIVATE_KEY_1
        ].filter(Boolean);

        if (privateKeys.length < 2) {
            throw new Error('Need at least 2 private keys in .env file');
        }

        for (let i = 0; i < privateKeys.length; i++) {
            const evmWallet = new ethers.Wallet(privateKeys[i]);
            const evmAddress = evmWallet.address;
            const cosmosAddress = this.deriveCosmosAddress(evmAddress);
            const privateKeyBytes = Buffer.from(privateKeys[i].replace('0x', ''), 'hex');
            const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, true);

            this.wallets.push({
                index: i,
                evmAddress: evmAddress,
                cosmosAddress: cosmosAddress,
                privateKeyBytes: privateKeyBytes,
                publicKeyBytes: Buffer.from(publicKeyBytes),
            });

            console.log(`Wallet ${i}:`);
            console.log(`  Cosmos: ${cosmosAddress}`);
            console.log(`  EVM: ${evmAddress}`);

            // Get account info
            try {
                const accountInfo = await this.getAccountInfo(cosmosAddress);
                console.log(`  Account: ${accountInfo.accountNumber}, Sequence: ${accountInfo.sequence}`);
                this.wallets[i].accountNumber = accountInfo.accountNumber;
                this.wallets[i].sequence = accountInfo.sequence;
            } catch (error) {
                console.log(`  Warning: Could not fetch account info: ${error.message}`);
            }
            console.log();
        }
    }

    async getAccountInfo(address) {
        const response = await fetch(`${this.restUrl}/cosmos/auth/v1beta1/accounts/${address}`);
        if (!response.ok) {
            throw new Error(`Failed to get account: ${response.statusText}`);
        }
        const data = await response.json();
        return {
            accountNumber: data.account.account_number,
            sequence: data.account.sequence
        };
    }

    async createAndSignTransaction(fromWallet, toAddress, amount) {
        // Create MsgSend
        const msgSend = MsgSend.fromPartial({
            fromAddress: fromWallet.cosmosAddress,
            toAddress: toAddress,
            amount: [{ denom: 'aevmos', amount: amount.toString() }]
        });

        const msgAny = Any.fromPartial({
            typeUrl: '/cosmos.bank.v1beta1.MsgSend',
            value: MsgSend.encode(msgSend).finish()
        });

        // Create TxBody
        const txBody = TxBody.fromPartial({
            messages: [msgAny],
            memo: `Test transaction ${Date.now()}`
        });

        const txBodyBytes = TxBody.encode(txBody).finish();

        // Create AuthInfo
        const pubkeyAny = Any.fromPartial({
            typeUrl: '/ethermint.crypto.v1.ethsecp256k1.PubKey',
            value: Uint8Array.from([0x0a, fromWallet.publicKeyBytes.length, ...fromWallet.publicKeyBytes])
        });

        const authInfo = makeAuthInfoBytes(
            [{ pubkey: pubkeyAny, sequence: Long.fromString(fromWallet.sequence.toString()) }],
            [{ denom: 'aevmos', amount: '20000000000000000' }],
            300000,
            undefined,
            undefined,
            undefined
        );

        // Create SignDoc
        const signDoc = makeSignDoc(
            txBodyBytes,
            authInfo,
            this.chainId,
            parseInt(fromWallet.accountNumber)
        );

        const signDocBytes = SignDoc.encode(signDoc).finish();
        const messageHash = keccak_256(signDocBytes);
        const signature = secp256k1.sign(messageHash, fromWallet.privateKeyBytes);
        const signatureBytes = signature.toCompactRawBytes();

        // Create TxRaw
        const txRaw = TxRaw.fromPartial({
            bodyBytes: txBodyBytes,
            authInfoBytes: authInfo,
            signatures: [signatureBytes]
        });

        const txBytes = TxRaw.encode(txRaw).finish();
        return toBase64(txBytes);
    }

    async broadcastTransaction(txBase64) {
        const response = await fetch(`${this.rpcUrl}/broadcast_tx_sync`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                jsonrpc: '2.0',
                id: 1,
                method: 'broadcast_tx_sync',
                params: { tx: txBase64 }
            })
        });

        const data = await response.json();
        return data.result;
    }

    async sendTransaction(fromIndex, toIndex, amount) {
        const fromWallet = this.wallets[fromIndex];
        const toWallet = this.wallets[toIndex];

        try {
            // Create and sign transaction
            const txBase64 = await this.createAndSignTransaction(
                fromWallet,
                toWallet.cosmosAddress,
                amount
            );

            // Broadcast transaction
            const result = await this.broadcastTransaction(txBase64);

            if (result.code === 0) {
                this.successCount++;
                this.txHashes.push(result.hash);
                console.log(`✓ TX ${this.successCount}: ${fromWallet.cosmosAddress.slice(0, 12)}... → ${toWallet.cosmosAddress.slice(0, 12)}... (${amount} aevmos)`);
                console.log(`  Hash: ${result.hash}`);

                // Increment sequence for next tx
                fromWallet.sequence = (parseInt(fromWallet.sequence) + 1).toString();
                return true;
            } else {
                this.failureCount++;
                console.log(`✗ TX failed: ${result.log || result.raw_log}`);
                return false;
            }
        } catch (error) {
            this.failureCount++;
            console.log(`✗ TX error: ${error.message}`);
            return false;
        }
    }

    async generateTestTransactions(count = 15) {
        console.log(`\nGenerating ${count} test transactions...\n`);

        const startTime = Date.now();

        for (let i = 0; i < count; i++) {
            // Alternate between wallets
            const fromIndex = i % 2;
            const toIndex = (i + 1) % 2;

            // Random amount between 100000 and 500000 aevmos
            const amount = Math.floor(Math.random() * 400000) + 100000;

            await this.sendTransaction(fromIndex, toIndex, amount);

            // Small delay between transactions
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        const endTime = Date.now();
        const duration = (endTime - startTime) / 1000;

        console.log('\n' + '='.repeat(60));
        console.log('Transaction Generation Complete');
        console.log('='.repeat(60));
        console.log(`Total Transactions: ${this.successCount + this.failureCount}`);
        console.log(`Successful: ${this.successCount}`);
        console.log(`Failed: ${this.failureCount}`);
        console.log(`Success Rate: ${((this.successCount / (this.successCount + this.failureCount)) * 100).toFixed(2)}%`);
        console.log(`Duration: ${duration.toFixed(2)}s`);
        console.log(`Average TPS: ${(this.successCount / duration).toFixed(2)}`);
        console.log('='.repeat(60));

        if (this.txHashes.length > 0) {
            console.log('\nTransaction Hashes:');
            this.txHashes.forEach((hash, idx) => {
                console.log(`  ${idx + 1}. ${hash}`);
            });
        }
    }
}

// Main execution
async function main() {
    const generator = new TestTransactionGenerator();

    try {
        await generator.initializeWallets();

        // Generate 15 test transactions
        const txCount = process.argv[2] ? parseInt(process.argv[2]) : 15;
        await generator.generateTestTransactions(txCount);

    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

main();
