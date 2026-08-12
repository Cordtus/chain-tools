import { ethers } from 'ethers';
import { StargateClient, SigningStargateClient } from '@cosmjs/stargate';
import { DirectSecp256k1Wallet, makeAuthInfoBytes, makeSignDoc } from '@cosmjs/proto-signing';
import { coins } from '@cosmjs/stargate';
import { bech32 } from 'bech32';
import { TxRaw, SignDoc, TxBody } from "cosmjs-types/cosmos/tx/v1beta1/tx.js";
import { Any } from "cosmjs-types/google/protobuf/any.js";
import { MsgSend } from "cosmjs-types/cosmos/bank/v1beta1/tx.js";
import Long from "long";
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { toBase64 } from '@cosmjs/encoding';
import { mnemonicToSeedSync, validateMnemonic } from 'bip39';
import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const bip32 = BIP32Factory(ecc);

// Complete SecureKeyManager implementation (copied from faucet)
class SecureKeyManager {
    constructor() {
        this._keys = new Map();
        this._addressCache = null;
        this._initialized = false;
    }

    async initialize(mnemonic) {
        return this.initializeWithPath(mnemonic, "m/44'/60'/0'/0/0");
    }
    
    async initializeWithPath(mnemonic, derivationPath) {
        if (this._initialized) return;

        if (!mnemonic) {
            throw new Error('Mnemonic required for wallet operations.');
        }

        if (!validateMnemonic(mnemonic)) {
            throw new Error('Invalid mnemonic phrase provided');
        }

        const seed = mnemonicToSeedSync(mnemonic);
        const root = bip32.fromSeed(seed);
        const node = root.derivePath(derivationPath);

        if (!node.privateKey) {
            throw new Error('Failed to derive private key from mnemonic');
        }

        const privateKeyBytes = node.privateKey;
        const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, false);
        const publicKeyBytesCompressed = secp256k1.getPublicKey(privateKeyBytes, true);

        const evmAddress = this._deriveEvmAddress(publicKeyBytes);
        const cosmosAddress = this._deriveCosmosAddress(evmAddress);

        this._addressCache = {
            evm: {
                address: evmAddress,
                publicKey: '0x' + Buffer.from(publicKeyBytesCompressed).toString('hex')
            },
            cosmos: {
                address: cosmosAddress,
                publicKey: Buffer.from(publicKeyBytesCompressed).toString('hex')
            }
        };

        this._keys.set('privateKey', privateKeyBytes);
        this._keys.set('publicKey', publicKeyBytesCompressed);
        
        this._initialized = true;
    }

    _deriveEvmAddress(publicKeyBytes) {
        // Use uncompressed public key (65 bytes), remove first byte (0x04 prefix)
        const publicKeyWithoutPrefix = publicKeyBytes.slice(1);
        const addressBytes = keccak_256(publicKeyWithoutPrefix).slice(-20);
        return '0x' + Buffer.from(addressBytes).toString('hex');
    }

    _deriveCosmosAddress(evmAddressHex) {
        // For eth_secp256k1, Cosmos address uses the same bytes as EVM address
        // Just encode the EVM address bytes in bech32 format (NO ripemd160)
        const addressBytes = Buffer.from(evmAddressHex.replace('0x', ''), 'hex');
        const words = bech32.toWords(addressBytes);
        return bech32.encode('cosmos', words);
    }

    getPrivateKeyHex() {
        this._ensureInitialized();
        const privateKey = this._keys.get('privateKey');
        return '0x' + Buffer.from(privateKey).toString('hex');
    }

    getPrivateKeyBytes() {
        this._ensureInitialized();
        return this._keys.get('privateKey');
    }

    getPublicKeyBytes() {
        this._ensureInitialized();
        return this._keys.get('publicKey');
    }

    getEvmAddress() {
        this._ensureInitialized();
        return this._addressCache.evm.address;
    }

    getCosmosAddress() {
        this._ensureInitialized();
        return this._addressCache.cosmos.address;
    }

    _ensureInitialized() {
        if (!this._initialized) {
            throw new Error('SecureKeyManager not initialized. Call initialize() first.');
        }
    }
}

class AdvancedTransactionSpammer {
    constructor() {
        this.evmRpcUrl = process.env.RPC_URL || 'http://localhost:8545';
        this.cosmosRpcUrl = process.env.COSMOS_RPC_URL || 'http://localhost:26657';
        this.evmProvider = new ethers.JsonRpcProvider(this.evmRpcUrl);
        this.chainId = 262144; // EVM chain ID
        this.cosmosChainId = '9001'; // Cosmos chain ID
        
        this.evmWallets = [];
        this.cosmosWallets = [];
        this.contracts = this.loadContracts();
        
        // Block-aware transaction tracking
        this.currentBlock = 0;
        this.walletBlockState = new Map(); // walletIndex -> { lastTxBlock, lastTxType }
        
        // Sequence locks for thread-safe nonce management
        this.walletLocks = new Map(); // walletIndex -> lock status
        
        // Advanced tracking
        this.pendingTransactions = new Map(); // txHash -> txInfo
        this.nonceGaps = new Map(); // wallet -> gapped nonces
        this.replacementCandidates = new Map(); // txHash -> original tx
        
        this.stats = {
            evmStats: {
                total: 0,
                successful: 0,
                replaced: 0,
                gapped: 0,
                failed: 0
            },
            cosmosStats: {
                total: 0,
                successful: 0,
                failed: 0
            },
            startTime: null,
            endTime: null
        };
        
        console.log('Initialized Advanced Transaction Spammer (Fixed)');
    }
    
    // Update current block number
    async updateCurrentBlock() {
        try {
            const block = await this.evmProvider.getBlock('latest');
            this.currentBlock = block.number;
        } catch (error) {
            console.error('Failed to get current block:', error.message);
        }
    }
    
    // Check if wallet can send transaction type in current block
    canWalletSendTx(walletIndex, txType) {
        const state = this.walletBlockState.get(walletIndex);
        if (!state) {
            return true; // First transaction for this wallet
        }
        
        // Cannot send tx in same block as last transaction
        if (state.lastTxBlock >= this.currentBlock) {
            return false;
        }
        
        return true;
    }
    
    // Record wallet transaction
    recordWalletTx(walletIndex, txType) {
        this.walletBlockState.set(walletIndex, {
            lastTxBlock: this.currentBlock,
            lastTxType: txType
        });
    }
    
    loadContracts() {
        return {
            erc20: process.env.TEST_ERC20_CONTRACT,
            storage: process.env.TEST_STORAGE_CONTRACT,
            counter: process.env.TEST_COUNTER_CONTRACT
        };
    }
    
    async initializeWallets(numWallets = 20) {
        console.log(`Initializing ${numWallets} EVM and Cosmos wallet pairs...`);
        
        // Generate additional wallets by deriving from base mnemonics
        const baseMnemonics = [
            process.env.MNEMONIC,
            process.env.MNEMONIC_1,
            process.env.MNEMONIC_2,
            process.env.MNEMONIC_3
        ].filter(Boolean);
        
        const privateKeys = [];
        const mnemonics = [];
        
        // Generate wallets by varying the derivation path
        for (let i = 0; i < numWallets; i++) {
            const baseMnemonic = baseMnemonics[i % baseMnemonics.length];
            const derivationPath = `m/44'/60'/0'/0/${i}`;
            
            try {
                const seed = mnemonicToSeedSync(baseMnemonic);
                const root = bip32.fromSeed(seed);
                const node = root.derivePath(derivationPath);
                
                if (node.privateKey) {
                    const privateKeyHex = '0x' + Buffer.from(node.privateKey).toString('hex');
                    privateKeys.push(privateKeyHex);
                    mnemonics.push(baseMnemonic + ':' + i); // Encode derivation index
                }
            } catch (error) {
                console.error(`Failed to derive wallet ${i}:`, error.message);
            }
        }
        
        console.log(`Generated ${privateKeys.length} wallet keys`);
        
        // Use dev0 wallet for funding (has plenty of funds and matches our env)
        this.mainEvmWallet = new ethers.Wallet(privateKeys[0], this.evmProvider);
        
        // Create Cosmos wallet with proper address derivation (EVM->bech32 direct conversion)
        const mainPrivateKeyBytes = Buffer.from(privateKeys[0].replace('0x', ''), 'hex');
        this.mainCosmosWallet = await DirectSecp256k1Wallet.fromKey(mainPrivateKeyBytes, 'cosmos');
        
        // Convert EVM address directly to cosmos bech32 (no ripemd160)
        const mainEvmAddress = this.mainEvmWallet.address;
        const mainAddressBytes = Buffer.from(mainEvmAddress.replace('0x', ''), 'hex');
        const mainWords = bech32.toWords(mainAddressBytes);
        const actualCosmosAddress = bech32.encode('cosmos', mainWords);
        
        this.mainCosmosClient = await SigningStargateClient.connectWithSigner(
            this.cosmosRpcUrl,
            this.mainCosmosWallet,
            { gasPrice: { denom: 'atest', amount: '25000000000' } }
        );
        
        console.log(`Main EVM wallet (dev0): ${this.mainEvmWallet.address}`);
        console.log(`Main Cosmos wallet (dev0): ${actualCosmosAddress}`);
        
        // Initialize EVM wallets (independent nonce tracking)
        for (let i = 0; i < privateKeys.length; i++) {
            const evmWallet = new ethers.Wallet(privateKeys[i], this.evmProvider);
            const currentNonce = await this.evmProvider.getTransactionCount(evmWallet.address, 'pending');
            
            this.evmWallets.push({
                index: i,
                wallet: evmWallet,
                address: evmWallet.address,
                baseNonce: currentNonce,
                currentSequence: currentNonce, // Use sequence instead of nonce for unified tracking
                privateKey: privateKeys[i],
                pendingTxs: new Map(), // sequence -> txHash
                lastReplacement: 0
            });
            
            console.log(`EVM Wallet ${i}: ${evmWallet.address} (base nonce: ${currentNonce})`);
        }
        
        // Initialize Cosmos wallets using exact faucet SecureKeyManager approach
        for (let i = 0; i < privateKeys.length; i++) {
            try {
                // Extract base mnemonic and derivation index
                const mnemonicInfo = mnemonics[i].split(':');
                const baseMnemonic = mnemonicInfo[0];
                const derivationIndex = parseInt(mnemonicInfo[1] || '0');
                
                // Create a SecureKeyManager for each wallet with specific derivation
                const keyManager = new SecureKeyManager();
                await keyManager.initializeWithPath(baseMnemonic, `m/44'/60'/0'/0/${derivationIndex}`);
                
                this.cosmosWallets.push({
                    index: i,
                    keyManager: keyManager,
                    address: keyManager.getCosmosAddress(),
                    evmAddress: keyManager.getEvmAddress()
                });
                
                console.log(`Cosmos Wallet ${i}: ${keyManager.getCosmosAddress()} (EVM: ${keyManager.getEvmAddress()})`);
                
                try {
                    // Check balance using REST API
                    const restEndpoint = process.env.COSMOS_REST_URL || 'http://localhost:1317';
                    const balanceResponse = await fetch(`${restEndpoint}/cosmos/bank/v1beta1/balances/${keyManager.getCosmosAddress()}`);
                    if (balanceResponse.ok) {
                        const balanceData = await balanceResponse.json();
                        const atestBalance = balanceData.balances?.find(b => b.denom === 'atest');
                        console.log(`  Balance: ${atestBalance?.amount || '0'} atest`);
                    } else {
                        console.log(`  Balance: 0 atest`);
                    }
                } catch (balanceError) {
                    console.log(`  Balance check failed: ${balanceError.message}`);
                }
                
            } catch (error) {
                console.error(`Failed to initialize Cosmos wallet ${i}:`, error.message);
            }
        }
        
        console.log(`Initialized ${this.evmWallets.length} EVM + ${this.cosmosWallets.length} Cosmos wallets`);
        
        // Fund all wallets from main wallet
        await this.fundWallets();
    }

    async refreshNonces() {
        console.log('Refreshing nonces for all wallets...');
        
        // Refresh EVM sequences (shared with Cosmos)
        for (const wallet of this.evmWallets) {
            const currentSequence = await this.evmProvider.getTransactionCount(wallet.address, 'pending');
            wallet.baseNonce = currentSequence;
            wallet.currentSequence = currentSequence;
            wallet.pendingTxs.clear(); // Clear stale pending tx tracking
            console.log(`EVM Wallet ${wallet.index}: Updated sequence to ${currentSequence}`);
        }
        
        console.log('Cosmos sequences are managed automatically by SigningStargateClient');
        
        // Clear any stuck transactions
        await this.inspectAndClearMempool();
    }
    
    // Thread-safe sequence management
    async acquireWalletLock(walletIndex) {
        while (this.walletLocks.get(walletIndex)) {
            await this.sleep(1); // Wait 1ms
        }
        this.walletLocks.set(walletIndex, true);
    }
    
    releaseWalletLock(walletIndex) {
        this.walletLocks.set(walletIndex, false);
    }
    
    // Improved EVM transaction with thread-safe sequence management
    async sendAdvancedEvmTransaction(wallet, options = {}) {
        await this.acquireWalletLock(wallet.index);
        
        try {
            const {
                createGap = false,
                gapSize = 5,
                replaceExisting = false,
                feeBump = 2.5,
                transactionType = 'contract'
            } = options;
            
            let nonce;
            let feeConfig = {};
            
            // Get current fee data and determine if EIP-1559 is supported
            const feeData = await this.evmProvider.getFeeData();
            const isEIP1559 = feeData.maxFeePerGas && feeData.maxPriorityFeePerGas;
            
            if (createGap) {
                // Create intentional sequence gap
                nonce = wallet.currentSequence + gapSize;
                console.log(`  Creating nonce gap: using ${nonce} (current: ${wallet.currentSequence})`);
                this.stats.evmStats.gapped++;
            } else if (replaceExisting) {
                // Replace pending transaction with much higher fee
                const pendingSequences = Array.from(wallet.pendingTxs.keys()).sort((a, b) => a - b);
                if (pendingSequences.length > 0 && Date.now() - wallet.lastReplacement > 5000) {
                    nonce = pendingSequences[0]; // Replace oldest transaction
                    wallet.lastReplacement = Date.now();
                    
                    // Get the original transaction info for fee calculation
                    const originalTxHash = wallet.pendingTxs.get(nonce);
                    const originalTxInfo = this.pendingTransactions.get(originalTxHash);
                    
                    if (isEIP1559) {
                        // EIP-1559 replacement requires significant fee increase
                        const baseFeeMultiplier = Math.max(feeBump, 1.125); // Minimum 12.5% increase
                        const priorityMultiplier = Math.max(feeBump, 1.5); // Higher priority fee increase
                        
                        feeConfig = {
                            maxFeePerGas: feeData.maxFeePerGas * BigInt(Math.floor(baseFeeMultiplier * 100)) / BigInt(100),
                            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * BigInt(Math.floor(priorityMultiplier * 100)) / BigInt(100),
                            type: 2 // EIP-1559
                        };
                    } else {
                        // Legacy gas price replacement - need at least 10% increase
                        const gasMultiplier = Math.max(feeBump, 1.1);
                        feeConfig = {
                            gasPrice: feeData.gasPrice * BigInt(Math.floor(gasMultiplier * 100)) / BigInt(100),
                            type: 0 // Legacy
                        };
                    }
                    
                    console.log(`  Replacing tx at nonce ${nonce} with ${feeBump}x fees (${isEIP1559 ? 'EIP-1559' : 'Legacy'})`);
                    this.stats.evmStats.replaced++;
                } else {
                    nonce = wallet.currentSequence;
                    wallet.currentSequence++;
                }
            } else {
                // Get current nonce from blockchain (most reliable)
                nonce = await this.evmProvider.getTransactionCount(wallet.address, 'pending');
            }
            
            // Set fee configuration if not already set for replacement
            if (Object.keys(feeConfig).length === 0) {
                if (isEIP1559) {
                    feeConfig = {
                        maxFeePerGas: feeData.maxFeePerGas || BigInt(10000000000), // 10 gwei minimum
                        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || BigInt(1000000000), // 1 gwei minimum
                        type: 2 // EIP-1559
                    };
                } else {
                    // Chain has 0 base fee, so use minimum gas price
                    feeConfig = {
                        gasPrice: feeData.gasPrice || BigInt(1000000000), // 1 gwei minimum instead of 0
                        type: 0 // Legacy
                    };
                }
            }
            
            let tx;
            
            if (transactionType === 'eth_transfer') {
                const toWallet = this.getRandomEvmWallet();
                if (wallet === toWallet) return null;
                
                const amount = ethers.parseEther((Math.random() * 0.001).toFixed(6));
                tx = {
                    to: toWallet.address,
                    value: amount,
                    gasLimit: 21000,
                    nonce: nonce,
                    chainId: this.chainId,
                    ...feeConfig
                };
            } else {
                // Contract interaction
                const contractAddress = this.contracts.counter;
                if (!contractAddress) {
                    console.error('No counter contract available');
                    return null;
                }
                
                const iface = new ethers.Interface(["function incrementBy(uint256 amount)"]);
                const data = iface.encodeFunctionData("incrementBy", [Math.floor(Math.random() * 5) + 1]);
                
                tx = {
                    to: contractAddress,
                    data: data,
                    gasLimit: 100000,
                    nonce: nonce,
                    chainId: this.chainId,
                    ...feeConfig
                };
            }
            
            const signedTx = await wallet.wallet.signTransaction(tx);
            const txResponse = await this.evmProvider.broadcastTransaction(signedTx);
            
            // No need to manually track sequences - blockchain handles it
            
            // Update tracking - remove old tx if replacing
            if (replaceExisting && wallet.pendingTxs.has(nonce)) {
                const oldTxHash = wallet.pendingTxs.get(nonce);
                this.pendingTransactions.delete(oldTxHash);
            }
            
            // Track new pending transaction
            wallet.pendingTxs.set(nonce, txResponse.hash);
            this.pendingTransactions.set(txResponse.hash, {
                wallet: wallet,
                nonce: nonce,
                type: transactionType,
                timestamp: Date.now(),
                gasPrice: feeConfig.gasPrice?.toString() || feeConfig.maxFeePerGas?.toString(),
                maxPriorityFeePerGas: feeConfig.maxPriorityFeePerGas?.toString(),
                isEIP1559: isEIP1559
            });
            
            const gapInfo = createGap ? ` (gap: +${gapSize})` : '';
            const replaceInfo = replaceExisting ? ` (replaced)` : '';
            const feeInfo = isEIP1559 ? ` [EIP-1559: ${ethers.formatUnits(feeConfig.maxPriorityFeePerGas, 'gwei')} gwei priority]` : ` [Legacy: ${ethers.formatUnits(feeConfig.gasPrice, 'gwei')} gwei]`;
            console.log(`EVM ${transactionType}: ${wallet.address} - ${txResponse.hash} (nonce: ${nonce})${gapInfo}${replaceInfo}${feeInfo}`);
            
            this.stats.evmStats.total++;
            this.stats.evmStats.successful++;
            return txResponse;
            
        } catch (error) {
            console.error(`Advanced EVM tx failed: ${error.message}`);
            this.stats.evmStats.total++;
            this.stats.evmStats.failed++;
            return null;
        } finally {
            this.releaseWalletLock(wallet.index);
        }
    }
    
    // Thread-safe Cosmos transaction with proper sequence management
    async sendCosmosTransaction(wallet) {
        // Find the corresponding EVM wallet (same index) for sequence management
        const correspondingEvmWallet = this.evmWallets[wallet.index];
        if (!correspondingEvmWallet) {
            console.error(`No corresponding EVM wallet found for Cosmos wallet ${wallet.index}`);
            return null;
        }
        
        await this.acquireWalletLock(wallet.index);
        
        try {
            const toWallet = this.getRandomCosmosWallet();
            if (wallet === toWallet) return null;
            
            const amount = Math.floor(Math.random() * 1000000) + 100000;
            const nativeTokens = [{ denom: 'atest', amount: amount.toString() }];
            
            // Get current sequence from blockchain (most reliable)
            const currentSequence = await this.evmProvider.getTransactionCount(correspondingEvmWallet.address, 'pending');
            
            // Get account info for account number (sequence will be overridden)
            const accountInfo = await this.getAccountInfo(wallet.address);
            accountInfo.sequence = currentSequence; // Use blockchain sequence
            
            // Use exact faucet sendCosmosTx implementation with tracked sequence
            const result = await this.sendCosmosTxWithAccountInfo(wallet, toWallet.address, nativeTokens, accountInfo);
            
            if (result && result.code === 0) {
                console.log(`Cosmos send: ${wallet.address} -> ${toWallet.address} (${amount}atest) - ${result.transactionHash}`);
                this.stats.cosmosStats.total++;
                this.stats.cosmosStats.successful++;
                return result;
            } else {
                console.error(`Cosmos send failed:`, result?.raw_log || 'Unknown error');
                this.stats.cosmosStats.total++;
                this.stats.cosmosStats.failed++;
                return null;
            }
            
        } catch (error) {
            console.error(`Cosmos send error: ${error.message}`);
            this.stats.cosmosStats.total++;
            this.stats.cosmosStats.failed++;
            return null;
        } finally {
            this.releaseWalletLock(wallet.index);
        }
    }
    
    // Get account info for Cosmos address
    async getAccountInfo(address) {
        try {
            const restEndpoint = process.env.COSMOS_REST_URL || 'http://localhost:1317';
            const response = await fetch(`${restEndpoint}/cosmos/auth/v1beta1/accounts/${address}`);
            
            if (!response.ok) {
                if (response.status === 404) {
                    // Account doesn't exist yet, return defaults
                    return { accountNumber: 0, sequence: 0 };
                }
                throw new Error(`Failed to get account info: ${response.statusText}`);
            }
            
            const data = await response.json();
            if (data.account && data.account['@type']) {
                // Handle different account types - look for account_number and sequence
                const account = data.account;
                return {
                    accountNumber: parseInt(account.account_number || account.base_account?.account_number || '0'),
                    sequence: parseInt(account.sequence || account.base_account?.sequence || '0')
                };
            }
            
            return { accountNumber: 0, sequence: 0 };
        } catch (error) {
            console.error('Error getting account info:', error.message);
            return { accountNumber: 0, sequence: 0 };
        }
    }
    
    // Exact faucet sendCosmosTx implementation with real-time account info
    async sendCosmosTxWithAccountInfo(wallet, recipientAddress, nativeTokens, accountInfo) {
        try {
            const fromAddress = wallet.address;
            
            // Build amount array for native tokens
            // Sort by denom alphabetically as required by Cosmos
            const amounts = nativeTokens.map(token => ({
                denom: token.denom,
                amount: token.amount
            })).sort((a, b) => a.denom.localeCompare(b.denom));
            
            // Create the transaction with the real-time account info
            const { txBody, authInfo, signDoc } = await this.createCosmosTransaction(
                wallet,
                fromAddress,
                recipientAddress,
                amounts,
                accountInfo.sequence, // Use real-time sequence
                accountInfo.accountNumber, // Use real-time account number
                this.cosmosChainId
            );
            
            // Sign the transaction manually using eth_secp256k1
            const privateKeyBytes = wallet.keyManager.getPrivateKeyBytes();
            
            // IMPORTANT: Based on the Go code, eth_secp256k1 uses Keccak256, not SHA256!
            const signBytes = SignDoc.encode(signDoc).finish();
            const hashedMessage = Buffer.from(keccak_256(signBytes));
            
            // Sign with secp256k1 - exact faucet implementation with v1.9.2
            const signatureResult = secp256k1.sign(hashedMessage, privateKeyBytes);
            
            // In @noble/curves v1.9.2, sign() returns object with r,s properties (like the faucet)
            const signatureBytes = Buffer.concat([
                Buffer.from(signatureResult.r.toString(16).padStart(64, '0'), 'hex'),
                Buffer.from(signatureResult.s.toString(16).padStart(64, '0'), 'hex')
            ]);
            
            // Construct the transaction
            const txRaw = TxRaw.fromPartial({
                bodyBytes: TxBody.encode(txBody).finish(),
                authInfoBytes: authInfo,
                signatures: [signatureBytes],
            });
            
            // Encode transaction
            const txBytes = TxRaw.encode(txRaw).finish();
            const txBase64 = toBase64(txBytes);
            
            // Broadcast transaction
            const restEndpoint = process.env.COSMOS_REST_URL || 'http://localhost:1317';
            const broadcastUrl = `${restEndpoint}/cosmos/tx/v1beta1/txs`;
            
            const broadcastResponse = await fetch(broadcastUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    tx_bytes: txBase64,
                    mode: 'BROADCAST_MODE_SYNC'
                })
            });
            
            if (!broadcastResponse.ok) {
                const errorData = await broadcastResponse.json();
                throw new Error(`Broadcast failed: ${JSON.stringify(errorData)}`);
            }
            
            const broadcastResult = await broadcastResponse.json();
            
            if (broadcastResult.tx_response && broadcastResult.tx_response.code !== 0) {
                const error = new Error(`Transaction failed: ${broadcastResult.tx_response.raw_log || broadcastResult.tx_response.log}`);
                error.raw_log = broadcastResult.tx_response.raw_log;
                throw error;
            }
            
            return {
                transactionHash: broadcastResult.tx_response?.txhash,
                code: broadcastResult.tx_response?.code || 0,
                raw_log: broadcastResult.tx_response?.raw_log
            };
            
        } catch (error) {
            throw error;
        }
    }
    
    // Create Cosmos transaction (exact faucet implementation)
    async createCosmosTransaction(wallet, fromAddress, toAddress, amounts, sequence, accountNumber, chainId) {
        try {
            const messages = [];
            
            // Create a single MsgSend with all amounts
            const msg = {
                typeUrl: "/cosmos.bank.v1beta1.MsgSend",
                value: MsgSend.fromPartial({
                    fromAddress: fromAddress,
                    toAddress: toAddress,
                    amount: amounts
                })
            };
            messages.push(msg);
            
            // Create the transaction body
            const txBody = TxBody.fromPartial({
                messages: messages.map(msg => Any.fromPartial({
                    typeUrl: msg.typeUrl,
                    value: MsgSend.encode(msg.value).finish()
                })),
                memo: ""
            });
            
            // Calculate reasonable gas price: target ~0.1atest total fee (much less than 0.95)
            const gasLimit = Long.fromString('100000'); // Standard gas limit for bank sends
            const targetTotalFee = '100000000000000000'; // 0.1 atest total fee (10x less than required error)
            const gasPrice = Math.floor(parseInt(targetTotalFee) / 100000); // gasPrice = totalFee / gasLimit
            const feeAmount = [{ denom: 'atest', amount: gasPrice.toString() }];
            
            // Get pubkey from keyManager (exact faucet approach)
            const pubkeyBytes = wallet.keyManager.getPublicKeyBytes();
            
            // Create a simple protobuf encoding for PubKey { key: bytes }
            // Field 1 (key) with wire type 2 (length-delimited)
            const fieldTag = (1 << 3) | 2; // field 1, wire type 2
            const pubkeyProto = Buffer.concat([
                Buffer.from([fieldTag]), // field tag
                Buffer.from([pubkeyBytes.length]), // length of key
                pubkeyBytes // the actual key bytes
            ]);
            
            const pubkey = Any.fromPartial({
                typeUrl: "/cosmos.evm.crypto.v1.ethsecp256k1.PubKey",
                value: pubkeyProto
            });
            
            const authInfo = makeAuthInfoBytes(
                [{ pubkey, sequence: Long.fromNumber(sequence) }],
                feeAmount,
                gasLimit,
                undefined,
                undefined
            );
            
            // Create sign doc
            const signDoc = makeSignDoc(
                TxBody.encode(txBody).finish(),
                authInfo,
                chainId,
                Long.fromNumber(accountNumber)
            );
            
            return { txBody, authInfo, signDoc };
        } catch (error) {
            console.error('Error creating Cosmos transaction:', error);
            throw error;
        }
    }
    
    getRandomEvmWallet() {
        return this.evmWallets[Math.floor(Math.random() * this.evmWallets.length)];
    }
    
    getRandomCosmosWallet() {
        return this.cosmosWallets[Math.floor(Math.random() * this.cosmosWallets.length)];
    }
    
    // Fill nonce gaps by sending transactions with missing nonces
    async fillNonceGaps() {
        console.log('\n🔧 Filling nonce gaps...');
        
        for (const wallet of this.evmWallets) {
            const pendingNonces = Array.from(wallet.pendingTxs.keys()).sort((a, b) => a - b);
            
            // Find gaps in pending nonces
            for (let nonce = wallet.baseNonce; nonce < wallet.currentNonce; nonce++) {
                if (!pendingNonces.includes(nonce)) {
                    console.log(`  Filling gap at nonce ${nonce} for ${wallet.address}`);
                    
                    // Send a simple transaction to fill the gap
                    try {
                        const feeData = await this.evmProvider.getFeeData();
                        const tx = {
                            to: wallet.address, // Self-send to fill gap
                            value: ethers.parseEther("0"),
                            gasLimit: 21000,
                            gasPrice: feeData.gasPrice,
                            nonce: nonce,
                            chainId: this.chainId
                        };
                        
                        const signedTx = await wallet.wallet.signTransaction(tx);
                        const txResponse = await this.evmProvider.broadcastTransaction(signedTx);
                        
                        wallet.pendingTxs.set(nonce, txResponse.hash);
                        console.log(`    Filled gap with tx: ${txResponse.hash}`);
                    } catch (error) {
                        console.error(`    Failed to fill gap at nonce ${nonce}: ${error.message}`);
                    }
                }
            }
        }
    }
    
    // Replace stuck transactions with higher fees
    async replaceStuckTransactions() {
        console.log('\n⚡ Replacing stuck transactions...');
        
        const now = Date.now();
        const stuckThreshold = 20000; // 20 seconds - more aggressive
        
        for (const [txHash, txInfo] of this.pendingTransactions.entries()) {
            if (now - txInfo.timestamp > stuckThreshold && now - txInfo.wallet.lastReplacement > 10000) {
                console.log(`  Replacing stuck tx: ${txHash} (age: ${(now - txInfo.timestamp)/1000}s)`);
                
                // Check if transaction is still pending (not mined)
                try {
                    const receipt = await this.evmProvider.getTransactionReceipt(txHash);
                    if (receipt) {
                        // Transaction was mined, clean up tracking
                        this.pendingTransactions.delete(txHash);
                        txInfo.wallet.pendingTxs.delete(txInfo.nonce);
                        console.log(`    Transaction ${txHash} was already mined, cleaned up`);
                        continue;
                    }
                } catch (error) {
                    // Transaction receipt not found, still pending
                }
                
                // Calculate escalating fee bump based on age
                const ageSeconds = (now - txInfo.timestamp) / 1000;
                const feeBump = Math.min(5.0, 2.5 + (ageSeconds / 30)); // Scale from 2.5x to 5x over time
                
                await this.sendAdvancedEvmTransaction(txInfo.wallet, {
                    replaceExisting: true,
                    feeBump: feeBump, // Escalating fee bump based on age
                    transactionType: txInfo.type
                });
            }
        }
    }
    
    // Clean up confirmed transactions from tracking
    async cleanupConfirmedTransactions() {
        console.log('\n🧹 Cleaning up confirmed transactions...');
        
        const toDelete = [];
        
        for (const [txHash, txInfo] of this.pendingTransactions.entries()) {
            try {
                const receipt = await this.evmProvider.getTransactionReceipt(txHash);
                if (receipt) {
                    // Transaction confirmed, clean up
                    toDelete.push({ txHash, txInfo });
                }
            } catch (error) {
                // Still pending or failed lookup
            }
        }
        
        // Clean up confirmed transactions
        for (const { txHash, txInfo } of toDelete) {
            this.pendingTransactions.delete(txHash);
            txInfo.wallet.pendingTxs.delete(txInfo.nonce);
            console.log(`  Cleaned up confirmed tx: ${txHash} (nonce: ${txInfo.nonce})`);
        }
        
        console.log(`  Cleaned up ${toDelete.length} confirmed transactions`);
    }
    
    async runAdvancedTest(duration, evmTps, cosmosTps, numWallets = 20) {
        await this.initializeWallets(numWallets);
        await this.refreshNonces();
        
        this.stats.startTime = Date.now();
        const endTime = Date.now() + (duration * 1000);
        
        console.log(`\n🚀 Starting Advanced Dual-Chain Test:`);
        console.log(`Duration: ${duration}s`);
        console.log(`EVM TPS: ${evmTps} (with gaps & replacements)`);
        console.log(`Cosmos TPS: ${cosmosTps}`);
        console.log(`Features: Nonce gaps, transaction replacement, advanced monitoring\n`);
        
        // High-throughput parallel transaction sending
        const evmTxsPerSecond = evmTps;
        const cosmosTxsPerSecond = cosmosTps;
        
        // Create pools of available wallets for concurrent sending
        let availableEvmWallets = [...this.evmWallets];
        let availableCosmosWallets = [...this.cosmosWallets];
        
        const evmTxPromises = [];
        const cosmosTxPromises = [];
        
        // Update block number periodically
        let lastBlockUpdate = 0;
        
        // Start concurrent transaction sending loops
        const evmSendingLoop = async () => {
            while (Date.now() < endTime) {
                const now = Date.now();
                
                // Update current block
                if (now - lastBlockUpdate >= 1000) {
                    await this.updateCurrentBlock();
                    lastBlockUpdate = now;
                }
                
                // Send multiple EVM transactions concurrently - scale with wallet count
                const evmBatchSize = Math.min(50, Math.floor(evmTxsPerSecond / 5)); // Send up to 50 txs per batch, 5 times per second
                const evmBatch = [];
                
                for (let i = 0; i < evmBatchSize && availableEvmWallets.length > 0; i++) {
                    const walletIndex = Math.floor(Math.random() * availableEvmWallets.length);
                    const wallet = availableEvmWallets[walletIndex];
                    
                    if (this.canWalletSendTx(wallet.index, 'evm')) {
                        // Remove from available pool temporarily
                        availableEvmWallets.splice(walletIndex, 1);
                        
                        const transactionType = Math.random() > 0.3 ? 'contract' : 'eth_transfer';
                        
                        const txPromise = this.sendAdvancedEvmTransaction(wallet, {
                            createGap: false, // Skip gaps for performance
                            transactionType: transactionType
                        }).then(result => {
                            if (result) {
                                this.recordWalletTx(wallet.index, 'evm');
                            }
                            // Return wallet to available pool
                            availableEvmWallets.push(wallet);
                            return result;
                        }).catch(error => {
                            // Return wallet to pool even on error
                            availableEvmWallets.push(wallet);
                            throw error;
                        });
                        
                        evmBatch.push(txPromise);
                    }
                }
                
                // Send batch concurrently
                if (evmBatch.length > 0) {
                    await Promise.allSettled(evmBatch);
                }
                
                // Rate limiting - faster for high throughput
                await this.sleep(200); // 200ms = 5 batches per second
            }
        };
        
        const cosmosSendingLoop = async () => {
            while (Date.now() < endTime) {
                // Send multiple Cosmos transactions concurrently - scale with wallet count  
                const cosmosBatchSize = Math.min(25, Math.floor(cosmosTxsPerSecond / 4)); // Send up to 25 txs per batch, 4 times per second
                const cosmosBatch = [];
                
                for (let i = 0; i < cosmosBatchSize && availableCosmosWallets.length > 0; i++) {
                    const walletIndex = Math.floor(Math.random() * availableCosmosWallets.length);
                    const wallet = availableCosmosWallets[walletIndex];
                    
                    if (this.canWalletSendTx(wallet.index, 'cosmos')) {
                        // Remove from available pool temporarily
                        availableCosmosWallets.splice(walletIndex, 1);
                        
                        const txPromise = this.sendCosmosTransaction(wallet).then(result => {
                            if (result && result.code === 0) {
                                this.recordWalletTx(wallet.index, 'cosmos');
                            }
                            // Return wallet to available pool
                            availableCosmosWallets.push(wallet);
                            return result;
                        }).catch(error => {
                            // Return wallet to pool even on error
                            availableCosmosWallets.push(wallet);
                            throw error;
                        });
                        
                        cosmosBatch.push(txPromise);
                    }
                }
                
                // Send batch concurrently
                if (cosmosBatch.length > 0) {
                    await Promise.allSettled(cosmosBatch);
                }
                
                // Rate limiting - faster for high throughput
                await this.sleep(250); // 250ms = 4 batches per second
            }
        };
        
        // Add mempool monitoring and cleaning during the test
        const mempoolCleaningLoop = async () => {
            while (Date.now() < endTime) {
                // Monitor and clear mempool every 10 seconds
                await this.sleep(10000);
                
                try {
                    const txpoolStatus = await this.evmProvider.send('txpool_status', []);
                    const queuedCount = parseInt(txpoolStatus.queued || '0x0', 16);
                    
                    if (queuedCount > 200) { // Higher threshold to avoid constant clearing
                        console.log(`\\n\u26a0\ufe0f  Mempool overloaded: ${queuedCount} queued transactions - gentle clearing...`);
                        await this.gentleMempoolCleanup(); // Use gentler approach
                    }
                } catch (error) {
                    // Ignore mempool check errors during high load
                }
            }
        };
        
        // Run all loops concurrently
        await Promise.all([
            evmSendingLoop(),
            cosmosSendingLoop(),
            mempoolCleaningLoop()
        ]);
        
        // Final mempool cleanup after test
        console.log('\\n\ud83e\uddfd Final mempool cleanup...');
        await this.gentleMempoolCleanup();
        
        this.stats.endTime = Date.now();
        this.generateAdvancedReport();
    }
    
    generateAdvancedReport() {
        const duration = (this.stats.endTime - this.stats.startTime) / 1000;
        
        console.log('\n' + '='.repeat(70));
        console.log('              ADVANCED DUAL-CHAIN TEST RESULTS (FIXED)');
        console.log('='.repeat(70));
        console.log(`Test Duration: ${duration.toFixed(2)}s`);
        
        console.log('\n--- EVM ADVANCED METRICS ---');
        console.log(`Total EVM Transactions: ${this.stats.evmStats.total}`);
        console.log(`  Successful: ${this.stats.evmStats.successful}`);
        console.log(`  Failed: ${this.stats.evmStats.failed}`);
        console.log(`  Replaced (fee bumped): ${this.stats.evmStats.replaced}`);
        console.log(`  Nonce Gapped: ${this.stats.evmStats.gapped}`);
        console.log(`EVM Success Rate: ${this.stats.evmStats.total > 0 ? ((this.stats.evmStats.successful / this.stats.evmStats.total) * 100).toFixed(2) : 0}%`);
        console.log(`EVM TPS: ${(this.stats.evmStats.total / duration).toFixed(2)}`);
        
        console.log('\n--- COSMOS METRICS ---');
        console.log(`Total Cosmos Transactions: ${this.stats.cosmosStats.total}`);
        console.log(`  Successful: ${this.stats.cosmosStats.successful}`);
        console.log(`  Failed: ${this.stats.cosmosStats.failed}`);
        console.log(`Cosmos Success Rate: ${this.stats.cosmosStats.total > 0 ? ((this.stats.cosmosStats.successful / this.stats.cosmosStats.total) * 100).toFixed(2) : 0}%`);
        console.log(`Cosmos TPS: ${(this.stats.cosmosStats.total / duration).toFixed(2)}`);
        
        console.log('\n--- ADVANCED FEATURES SUMMARY ---');
        console.log(`✅ Nonce Gap Creation: ${this.stats.evmStats.gapped} transactions`);
        console.log(`⚡ Transaction Replacement: ${this.stats.evmStats.replaced} transactions`);
        console.log(`🔗 Dual-Chain Coordination: Independent EVM/Cosmos operation`);
        
        const totalTxs = this.stats.evmStats.total + this.stats.cosmosStats.total;
        const totalSuccessful = this.stats.evmStats.successful + this.stats.cosmosStats.successful;
        
        console.log('\n--- COMBINED PERFORMANCE ---');
        console.log(`Total Combined Transactions: ${totalTxs}`);
        console.log(`Combined Success Rate: ${totalTxs > 0 ? ((totalSuccessful / totalTxs) * 100).toFixed(2) : 0}%`);
        console.log(`Combined TPS: ${(totalTxs / duration).toFixed(2)}`);
        
        console.log('='.repeat(70));
    }
    
    // Fund all wallets from main wallet to ensure they have balance and are "known" to chain
    async fundWallets() {
        console.log('\n💰 Funding wallets from main wallet...');
        
        // Fund EVM wallets SEQUENTIALLY to avoid nonce conflicts
        const evmFundingAmount = ethers.parseEther('0.1');
        let mainWalletNonce = await this.evmProvider.getTransactionCount(this.mainEvmWallet.address, 'pending');
        
        console.log(`Sequential funding starting from nonce ${mainWalletNonce}...`);
        
        for (let i = 1; i < this.evmWallets.length; i++) { // Skip index 0 (main wallet)
            const wallet = this.evmWallets[i];
            
            try {
                const balance = await this.evmProvider.getBalance(wallet.address);
                if (balance < ethers.parseEther('0.05')) {
                    console.log(`Funding EVM wallet ${i}: ${wallet.address.slice(0,10)}... (nonce: ${mainWalletNonce})`);
                    
                    const tx = {
                        to: wallet.address,
                        value: evmFundingAmount,
                        gasLimit: 21000,
                        nonce: mainWalletNonce, // Explicit nonce management
                        gasPrice: BigInt(1000000000) // 1 gwei
                    };
                    
                    const txResponse = await this.mainEvmWallet.sendTransaction(tx);
                    console.log(`  ✅ Funded with tx: ${txResponse.hash.slice(0,10)}...`);
                    
                    mainWalletNonce++; // Increment for next transaction
                    await this.sleep(100); // Small delay to avoid overwhelming
                }
            } catch (error) {
                console.error(`Failed to fund EVM wallet ${i}: ${error.message}`);
                // Don't increment nonce on failure
            }
        }
        
        // Check main Cosmos wallet balance using REST API
        let mainWalletHasFunds = false;
        // Derive the main cosmos address from the first EVM wallet
        const mainEvmAddr = this.evmWallets[0].address;
        const mainCosmosAddrBytes = Buffer.from(mainEvmAddr.replace('0x', ''), 'hex');
        const mainCosmosWords = bech32.toWords(mainCosmosAddrBytes);
        const actualMainCosmosAddress = bech32.encode('cosmos', mainCosmosWords);
        
        try {
            const restEndpoint = process.env.COSMOS_REST_URL || 'http://localhost:1317';
            const balanceResponse = await fetch(`${restEndpoint}/cosmos/bank/v1beta1/balances/${actualMainCosmosAddress}`);
            if (balanceResponse.ok) {
                const balanceData = await balanceResponse.json();
                const atestBalance = balanceData.balances?.find(b => b.denom === 'atest');
                const balance = parseInt(atestBalance?.amount || '0');
                console.log(`Main Cosmos wallet balance: ${balance} atest`);
                mainWalletHasFunds = balance >= 1000000000;
                
                if (!mainWalletHasFunds) {
                    console.log('⚠️  Main Cosmos wallet has insufficient funds for testing!');
                    console.log('Please fund the main wallet with tokens before running the spammer.');
                    console.log(`Main Cosmos address: ${actualMainCosmosAddress}`);
                }
            } else {
                console.log('⚠️  Could not check main Cosmos wallet balance');
            }
        } catch (error) {
            console.log('⚠️  Main Cosmos wallet access error:', error.message);
            console.log('This is normal for new chains. Cosmos funding will be skipped.');
        }
        
        // Fund Cosmos wallets (only if main wallet has funds)
        const cosmosFundingAmount = '1000000000'; // 1000 atest
        if (mainWalletHasFunds) {
            for (let i = 1; i < this.cosmosWallets.length; i++) { // Skip index 0 (main wallet)
                const wallet = this.cosmosWallets[i];
                try {
                    // Check wallet balance using REST API
                    const restEndpoint = process.env.COSMOS_REST_URL || 'http://localhost:1317';
                    const balanceResponse = await fetch(`${restEndpoint}/cosmos/bank/v1beta1/balances/${wallet.address}`);
                    let needsFunding = true;
                    
                    if (balanceResponse.ok) {
                        const balanceData = await balanceResponse.json();
                        const atestBalance = balanceData.balances?.find(b => b.denom === 'atest');
                        const balance = parseInt(atestBalance?.amount || '0');
                        needsFunding = balance < 100000000; // Fund if balance < 100 atest
                    }
                    
                    if (needsFunding) {
                        console.log(`Funding Cosmos wallet ${i}: ${wallet.address}`);
                        
                        // Use the main cosmos wallet (first one should match)
                        const mainWallet = this.cosmosWallets[0];
                        
                        // Send funding transaction using exact faucet approach
                        const result = await this.sendCosmosTx(
                            mainWallet,
                            wallet.address,
                            [{ denom: 'atest', amount: cosmosFundingAmount }]
                        );
                        
                        if (result && result.code === 0) {
                            console.log(`  ✅ Funded with tx: ${result.transactionHash}`);
                        } else {
                            console.log(`  ❌ Funding failed: ${result?.raw_log || 'Unknown error'}`);
                        }
                    }
                } catch (error) {
                    console.error(`Failed to fund Cosmos wallet ${i}: ${error.message}`);
                }
            }
        } else {
            console.log('Skipping Cosmos wallet funding - insufficient main wallet balance');
        }
        
        console.log('💰 Wallet funding complete!');
    }
    
    // Advanced mempool inspection and clearing
    async inspectAndClearMempool() {
        console.log('\\n\ud83d\udd0d Inspecting mempool for stuck transactions...');
        
        try {
            // Get comprehensive mempool status
            const txpoolStatus = await this.evmProvider.send('txpool_status', []);
            const pendingCount = parseInt(txpoolStatus.pending || '0x0', 16);
            const queuedCount = parseInt(txpoolStatus.queued || '0x0', 16);
            
            console.log(`Mempool status: ${pendingCount} pending, ${queuedCount} queued`);
            
            if (queuedCount > 10) {
                console.log(`\u26a0\ufe0f  High queued transaction count (${queuedCount}) - investigating...`);
                
                // Get detailed mempool content
                try {
                    const txpoolContent = await this.evmProvider.send('txpool_content', []);
                    
                    // Analyze queued transactions
                    const queuedTxs = txpoolContent.queued || {};
                    const walletIssues = new Map();
                    
                    for (const [address, nonceTxs] of Object.entries(queuedTxs)) {
                        const nonces = Object.keys(nonceTxs).map(n => parseInt(n)).sort((a, b) => a - b);
                        const latest = await this.evmProvider.getTransactionCount(address, 'latest');
                        
                        walletIssues.set(address, {
                            queuedNonces: nonces,
                            latestNonce: latest,
                            firstQueued: nonces[0],
                            gapSize: nonces[0] - latest,
                            queuedCount: nonces.length
                        });
                        
                        console.log(`${address}: gap of ${nonces[0] - latest}, ${nonces.length} queued (${nonces[0]} to ${nonces[nonces.length-1]})`);
                    }
                    
                    // Clear gaps for wallets with highest impact
                    const sortedIssues = Array.from(walletIssues.entries())
                        .sort(([,a], [,b]) => b.queuedCount - a.queuedCount)
                        .slice(0, 20); // Focus on top 20 problematic wallets
                    
                    console.log(`\\n\ud83e\udd16 Clearing gaps for top ${sortedIssues.length} problematic wallets...`);
                    
                    // Clear gaps in parallel for faster processing
                    const clearingPromises = sortedIssues.map(([address, issue]) => 
                        this.clearWalletGaps(address, issue)
                    );
                    
                    await Promise.allSettled(clearingPromises);
                    
                } catch (contentError) {
                    console.log(`Could not get mempool content: ${contentError.message}`);
                    // Fallback to individual wallet clearing
                    await this.fallbackClearStuckTransactions();
                }
            } else {
                // Normal clearing for individual wallets
                await this.fallbackClearStuckTransactions();
            }
            
        } catch (error) {
            console.error('Mempool inspection failed:', error.message);
            await this.fallbackClearStuckTransactions();
        }
        
        console.log('\ud83d\udd0d Mempool inspection and clearing complete!');
    }
    
    // Fast mempool cleanup that handles both gaps and low fees
    async gentleMempoolCleanup() {
        try {
            console.log('\n\ud83d\udd25 Running fast mempool cleanup...');
            
            const txpoolStatus = await this.evmProvider.send('txpool_status', []);
            const queuedCount = parseInt(txpoolStatus.queued || '0x0', 16);
            
            console.log(`Pre-cleanup: ${queuedCount} queued transactions`);
            
            if (queuedCount < 10) {
                console.log('Mempool healthy - no cleanup needed');
                return;
            }
            
            // Get our wallet addresses
            const ourWalletAddresses = new Set(this.evmWallets.map(w => w.address.toLowerCase()));
            const ourIssues = [];
            
            // Get detailed content to analyze both gaps and low fees
            const txpoolContent = await this.evmProvider.send('txpool_content', []);
            const queuedContent = txpoolContent.queued || {};
            
            for (const [address, nonceTxs] of Object.entries(queuedContent)) {
                if (ourWalletAddresses.has(address.toLowerCase())) {
                    const nonces = Object.keys(nonceTxs).map(n => parseInt(n)).sort((a, b) => a - b);
                    const latest = await this.evmProvider.getTransactionCount(address, 'latest');
                    const gapSize = nonces.length > 0 ? nonces[0] - latest : 0;
                    
                    // Check for low fee transactions too
                    const lowFeeTxs = [];
                    for (const [nonce, txData] of Object.entries(nonceTxs)) {
                        const gasPrice = BigInt(txData.gasPrice || '0x0');
                        if (gasPrice <= BigInt(1000000000)) { // <= 1 gwei is too low
                            lowFeeTxs.push({
                                nonce: parseInt(nonce),
                                gasPrice: gasPrice,
                                txData: txData
                            });
                        }
                    }
                    
                    if (gapSize > 0 || lowFeeTxs.length > 0) {
                        ourIssues.push({
                            address,
                            nonces,
                            latest,
                            gapSize,
                            lowFeeTxs,
                            priority: gapSize * 10 + lowFeeTxs.length // Prioritize gaps, then low fees
                        });
                    }
                }
            }
            
            if (ourIssues.length === 0) {
                console.log('No issues in our wallets to clear');
                return;
            }
            
            // Sort by priority (gaps first, then volume)
            ourIssues.sort((a, b) => b.priority - a.priority);
            
            console.log(`Found ${ourIssues.length} wallets to clear - processing fast...`);
            
            // Clear issues in parallel for speed
            const clearingPromises = ourIssues.slice(0, 10).map(issue => 
                this.fastClearWallet(issue)
            );
            
            await Promise.allSettled(clearingPromises);
            console.log('\ud83d\udd25 Fast cleanup complete');
            
        } catch (error) {
            console.error('Fast mempool cleanup failed:', error.message);
        }
    }
    
    // Fast clear wallet - handles both nonce gaps and low-fee transactions
    async fastClearWallet(issue) {
        try {
            const wallet = this.evmWallets.find(w => w.address.toLowerCase() === issue.address.toLowerCase());
            if (!wallet) return;
            
            console.log(`\ud83d\udd25 Fast clearing ${issue.address.slice(0,10)}: ${issue.gapSize} gaps, ${issue.lowFeeTxs.length} low-fee txs`);
            
            const feeData = await this.evmProvider.getFeeData();
            const network = await this.evmProvider.getNetwork();
            const baseGasPrice = feeData.gasPrice || BigInt(1000000000);
            const fastGasPrice = baseGasPrice * BigInt(50); // 50x for fast clearing
            
            const clearingPromises = [];
            
            // 1. Fill nonce gaps first (highest priority)
            for (let nonce = issue.latest; nonce < (issue.nonces.length > 0 ? issue.nonces[0] : issue.latest); nonce++) {
                const gapPromise = (async () => {
                    try {
                        const clearTx = {
                            to: issue.address,
                            value: 0,
                            gasLimit: 21000,
                            gasPrice: fastGasPrice,
                            nonce: nonce,
                            chainId: Number(network.chainId)
                        };
                        
                        const signedTx = await wallet.wallet.signTransaction(clearTx);
                        const txResponse = await this.evmProvider.broadcastTransaction(signedTx);
                        console.log(`    \u2705 Gap ${nonce}: ${txResponse.hash.slice(0,8)}...`);
                    } catch (error) {
                        console.log(`    \u274c Gap ${nonce}: ${error.message}`);
                    }
                })();
                
                clearingPromises.push(gapPromise);
            }
            
            // 2. Replace low-fee transactions with same parameters but higher fees
            for (const lowFeeTx of issue.lowFeeTxs.slice(0, 5)) { // Limit to first 5 low-fee txs
                const replacePromise = (async () => {
                    try {
                        const replaceTx = {
                            to: lowFeeTx.txData.to || issue.address,
                            value: BigInt(lowFeeTx.txData.value || '0x0'),
                            gasLimit: parseInt(lowFeeTx.txData.gas || '0x5208', 16),
                            gasPrice: fastGasPrice, // Much higher fee
                            nonce: lowFeeTx.nonce,
                            chainId: Number(network.chainId)
                        };
                        
                        const signedTx = await wallet.wallet.signTransaction(replaceTx);
                        const txResponse = await this.evmProvider.broadcastTransaction(signedTx);
                        console.log(`    \u26a1 Replace ${lowFeeTx.nonce}: ${txResponse.hash.slice(0,8)}... (${ethers.formatUnits(fastGasPrice, 'gwei')} gwei)`);
                    } catch (error) {
                        console.log(`    \u274c Replace ${lowFeeTx.nonce}: ${error.message}`);
                    }
                })();
                
                clearingPromises.push(replacePromise);
            }
            
            // Execute all clearing operations in parallel for speed
            await Promise.allSettled(clearingPromises);
            
        } catch (error) {
            console.error(`Failed to fast clear ${issue.address}:`, error.message);
        }
    }
    
    // Automated intelligent mempool cleanup
    async automatedMempoolCleanup() {
        try {
            console.log('\n\ud83e\udd16 Running automated mempool cleanup...');
            
            // Get comprehensive mempool analysis
            const txpoolStatus = await this.evmProvider.send('txpool_status', []);
            const pendingCount = parseInt(txpoolStatus.pending || '0x0', 16);
            const queuedCount = parseInt(txpoolStatus.queued || '0x0', 16);
            
            console.log(`Pre-cleanup: ${pendingCount} pending, ${queuedCount} queued`);
            
            if (queuedCount === 0) {
                console.log('No queued transactions to clear');
                return;
            }
            
            // Get complete transaction details using txpool_content for full analysis
            const txpoolContent = await this.evmProvider.send('txpool_content', []);
            const queuedContent = txpoolContent.queued || {};
            
            // Analyze each wallet's complete transaction profile
            const walletAnalysis = new Map();
            
            for (const [address, nonceTxs] of Object.entries(queuedContent)) {
                const nonces = Object.keys(nonceTxs).map(n => parseInt(n)).sort((a, b) => a - b);
                const latest = await this.evmProvider.getTransactionCount(address, 'latest');
                const pending = await this.evmProvider.getTransactionCount(address, 'pending');
                
                // Use txpool_content to get full transaction details instead of parsing summaries
                const txDetails = [];
                
                // Get complete transaction data for this address
                try {
                    const contentFrom = await this.evmProvider.send('txpool_contentFrom', [address]);
                    const queuedDetails = contentFrom.queued || {};
                    
                    for (const [nonce, txData] of Object.entries(queuedDetails)) {
                        txDetails.push({
                            nonce: parseInt(nonce),
                            to: txData.to,
                            value: BigInt(txData.value || '0x0'),
                            gas: parseInt(txData.gas || '0x5208', 16),
                            gasPrice: BigInt(txData.gasPrice || '0x0'),
                            hash: txData.hash
                        });
                    }
                } catch (contentError) {
                    console.log(`Could not get detailed content for ${address}: ${contentError.message}`);
                    // Use placeholder data
                    for (const nonce of nonces) {
                        txDetails.push({
                            nonce: nonce,
                            gasPrice: BigInt(1) // Very low gas price
                        });
                    }
                }
                
                // Determine issue type and clearing strategy
                let issueType = 'unknown';
                let gapSize = nonces.length > 0 ? nonces[0] - latest : 0;
                let priority = 0;
                let clearingStrategy = 'gap_fill';
                
                if (gapSize > 0) {
                    issueType = 'nonce_gap';
                    priority = gapSize * nonces.length;
                    clearingStrategy = 'gap_fill';
                } else if (nonces.length > 10) {
                    issueType = 'high_volume';
                    priority = nonces.length;
                    clearingStrategy = 'fee_replacement';
                } else {
                    // Check if fees are too low - most transactions in the example have 0-1 wei gas price
                    const maxGasPrice = txDetails.reduce((max, tx) => tx.gasPrice > max ? tx.gasPrice : max, BigInt(0));
                    const minGasPrice = txDetails.reduce((min, tx) => tx.gasPrice < min ? tx.gasPrice : min, BigInt('999999999999'));
                    
                    if (maxGasPrice <= BigInt(1000000000)) { // Less than 1 gwei
                        issueType = 'low_fee';
                        priority = nonces.length * 5; // High priority for low fee issues
                        clearingStrategy = 'fee_replacement';
                    } else {
                        issueType = 'unknown';
                        priority = nonces.length;
                        clearingStrategy = 'fee_replacement';
                    }
                }
                
                walletAnalysis.set(address, {
                    queuedNonces: nonces,
                    latestNonce: latest,
                    pendingNonce: pending,
                    firstQueued: nonces[0],
                    lastQueued: nonces[nonces.length - 1],
                    gapSize: gapSize,
                    queuedCount: nonces.length,
                    issueType: issueType,
                    priority: priority,
                    clearingStrategy: clearingStrategy,
                    txDetails: txDetails,
                    lowestGasPrice: txDetails.length > 0 ? txDetails.reduce((min, tx) => {
                        const price = tx.maxFeePerGas || tx.gasPrice || BigInt(0);
                        return price < min ? price : min;
                    }, BigInt('999999999999999999')) : BigInt(0),
                    highestGasPrice: txDetails.length > 0 ? txDetails.reduce((max, tx) => {
                        const price = tx.maxFeePerGas || tx.gasPrice || BigInt(0);
                        return price > max ? price : max;
                    }, BigInt(0)) : BigInt(0)
                });
            }
            
            // Filter to only our controlled wallets
            const ourWalletAddresses = new Set(this.evmWallets.map(w => w.address.toLowerCase()));
            const controllableIssues = Array.from(walletAnalysis.entries())
                .filter(([address, ]) => ourWalletAddresses.has(address.toLowerCase()))
                .sort(([,a], [,b]) => b.priority - a.priority);
            
            console.log(`Total stuck wallets: ${walletAnalysis.size}, Our controllable wallets: ${controllableIssues.length}`);
            
            if (controllableIssues.length === 0) {
                console.log('No stuck transactions from our controlled wallets - all external wallets');
                return;
            }
            
            console.log(`Clearing ${controllableIssues.length} of our wallets with stuck transactions:`);
            for (const [address, analysis] of controllableIssues.slice(0, 5)) {
                console.log(`  ${address.slice(0,10)}: ${analysis.issueType}, gap=${analysis.gapSize}, queued=${analysis.queuedCount}`);
            }
            
            // Clear our wallet issues in parallel batches
            const batchSize = 5;
            for (let i = 0; i < controllableIssues.length; i += batchSize) {
                const batch = controllableIssues.slice(i, i + batchSize);
                console.log(`\\n\ud83d\udd27 Clearing batch ${Math.floor(i/batchSize) + 1}: ${batch.length} wallets`);
                
                const clearingPromises = batch.map(([address, analysis]) => 
                    this.clearWalletByAnalysis(address, analysis)
                );
                
                await Promise.allSettled(clearingPromises);
                await this.sleep(1000); // Brief pause between batches
            }
            
            // Verify cleanup effectiveness
            await this.sleep(5000);
            const postStatus = await this.evmProvider.send('txpool_status', []);
            const postQueued = parseInt(postStatus.queued || '0x0', 16);
            const cleared = queuedCount - postQueued;
            
            console.log(`\ud83c\udf89 Cleanup complete: cleared ${cleared}/${queuedCount} queued transactions (${postQueued} remaining)`);
            
        } catch (error) {
            console.error('Automated mempool cleanup failed:', error.message);
        }
    }
    
    // Clear wallet based on analysis
    async clearWalletByAnalysis(address, analysis) {
        try {
            const wallet = this.evmWallets.find(w => w.address.toLowerCase() === address.toLowerCase());
            if (!wallet) {
                console.log(`  Wallet ${address.slice(0,10)} not in our pool - external wallet`);
                return;
            }
            
            const feeData = await this.evmProvider.getFeeData();
            const network = await this.evmProvider.getNetwork();
            const baseGasPrice = feeData.gasPrice || BigInt(1000000000);
            
            if (analysis.issueType === 'nonce_gap') {
                // Fill nonce gaps with high-priority clearing transactions
                console.log(`  \ud83d\udd27 Filling ${analysis.gapSize} gaps for ${address.slice(0,10)}...`);
                
                for (let nonce = analysis.latestNonce; nonce < analysis.firstQueued; nonce++) {
                    try {
                        const clearTx = {
                            to: address,
                            value: 0,
                            gasLimit: 21000,
                            gasPrice: baseGasPrice * BigInt(1000), // 1000x for emergency clearing
                            nonce: nonce,
                            chainId: Number(network.chainId)
                        };
                        
                        const signedTx = await wallet.wallet.signTransaction(clearTx);
                        const txResponse = await this.evmProvider.broadcastTransaction(signedTx);
                        console.log(`    \u2705 Gap ${nonce}: ${txResponse.hash.slice(0,8)}...`);
                        
                        await this.sleep(50); // Fast gap filling
                    } catch (error) {
                        console.log(`    \u274c Gap ${nonce}: ${error.message}`);
                    }
                }
            } else if (analysis.issueType === 'low_fee' || analysis.issueType === 'high_volume') {
                // Get detailed transaction info using contentFrom for precise replacement
                try {
                    const contentFrom = await this.evmProvider.send('txpool_contentFrom', [address]);
                    const queuedDetails = contentFrom.queued || {};
                    
                    console.log(`  \u26a1 Fee-bumping ${Object.keys(queuedDetails).length} queued txs for ${address.slice(0,10)}...`);
                    
                    // Replace each transaction with much higher fees using exact same parameters
                    for (const [nonceStr, txData] of Object.entries(queuedDetails)) {
                        const nonce = parseInt(nonceStr);
                        try {
                            // Calculate much higher gas price for replacement
                            const originalGasPrice = BigInt(txData.gasPrice || '0x1');
                            const newGasPrice = originalGasPrice < BigInt(1000000000) ? 
                                BigInt(50000000000) : // 50 gwei for very low fee txs
                                originalGasPrice * BigInt(200); // 200x original for others
                            
                            const replacementTx = {
                                to: txData.to || address, // Use original target or self-send
                                value: BigInt(txData.value || '0x0'), // Keep original value
                                gasLimit: parseInt(txData.gas || '0x5208', 16), // Keep original gas limit
                                gasPrice: newGasPrice,
                                nonce: nonce,
                                chainId: Number(network.chainId)
                            };
                            
                            const signedTx = await wallet.wallet.signTransaction(replacementTx);
                            const txResponse = await this.evmProvider.broadcastTransaction(signedTx);
                            console.log(`    \u26a1 Replaced ${nonce}: ${txResponse.hash.slice(0,8)}... (${ethers.formatUnits(newGasPrice, 'gwei')} gwei)`);
                            
                            await this.sleep(50);
                        } catch (error) {
                            console.log(`    \u274c Replace ${nonce}: ${error.message}`);
                        }
                    }
                } catch (error) {
                    console.log(`    \u274c Could not get detailed tx info: ${error.message}`);
                }
            }
            
        } catch (error) {
            console.error(`Failed to clear ${address}: ${error.message}`);
        }
    }
    
    // Clear gaps for a specific wallet
    async clearWalletGaps(address, issue) {
        try {
            console.log(`\ud83d\udd27 Clearing ${issue.gapSize} gaps for ${address.slice(0,10)}...`);
            
            // Find the wallet object
            const wallet = this.evmWallets.find(w => w.address.toLowerCase() === address.toLowerCase());
            if (!wallet) {
                console.log(`  Wallet not found in our pool, skipping`);
                return;
            }
            
            const feeData = await this.evmProvider.getFeeData();
            const network = await this.evmProvider.getNetwork();
            
            // Fill gaps with high-fee transactions
            for (let nonce = issue.latestNonce; nonce < issue.firstQueued; nonce++) {
                try {
                    const baseGasPrice = feeData.gasPrice || BigInt(1000000000);
                    const clearTx = {
                        to: address, // Send to self
                        value: 0,
                        gasLimit: 21000,
                        gasPrice: baseGasPrice * BigInt(500), // 500x gas for urgent clearing
                        nonce: nonce,
                        chainId: Number(network.chainId)
                    };
                    
                    const signedTx = await wallet.wallet.signTransaction(clearTx);
                    const txResponse = await this.evmProvider.broadcastTransaction(signedTx);
                    console.log(`    \u2705 Filled gap at nonce ${nonce}: ${txResponse.hash.slice(0,10)}...`);
                    
                    await this.sleep(100); // Fast clearing
                } catch (error) {
                    console.log(`    \u274c Failed to fill nonce ${nonce}: ${error.message}`);
                }
            }
            
        } catch (error) {
            console.error(`Failed to clear gaps for ${address}: ${error.message}`);
        }
    }
    
    // Fallback clearing method (original logic)
    async fallbackClearStuckTransactions() {
        console.log('\\n\ud83e\uddf9 Running fallback stuck transaction clearing...');
        
        for (const wallet of this.evmWallets.slice(0, 10)) { // Only clear top 10 wallets in fallback
            try {
                const latest = await this.evmProvider.getTransactionCount(wallet.address, 'latest');
                const pending = await this.evmProvider.getTransactionCount(wallet.address, 'pending');
                
                if (pending > latest) {
                    console.log(`Clearing ${pending - latest} stuck txs for ${wallet.address.slice(0,10)}...`);
                    
                    const feeData = await this.evmProvider.getFeeData();
                    const network = await this.evmProvider.getNetwork();
                    
                    for (let nonce = latest; nonce < pending; nonce++) {
                        try {
                            const baseGasPrice = feeData.gasPrice || BigInt(1000000000);
                            const clearTx = {
                                to: wallet.address,
                                value: 0,
                                gasLimit: 21000,
                                gasPrice: baseGasPrice * BigInt(200), // 200x gas for clearing
                                nonce: nonce,
                                chainId: Number(network.chainId)
                            };
                            
                            const signedTx = await wallet.wallet.signTransaction(clearTx);
                            const txResponse = await this.evmProvider.broadcastTransaction(signedTx);
                            console.log(`    \u2705 Cleared nonce ${nonce}: ${txResponse.hash.slice(0,10)}...`);
                            
                            await this.sleep(200);
                        } catch (error) {
                            console.log(`    \u274c Failed to clear nonce ${nonce}: ${error.message}`);
                        }
                    }
                    
                    // Update wallet state
                    wallet.currentSequence = pending;
                    wallet.baseNonce = latest;
                    wallet.pendingTxs.clear();
                }
            } catch (error) {
                console.error(`Failed to clear stuck txs for wallet ${wallet.index}: ${error.message}`);
            }
        }
    }
    
    // Clear stuck transactions using nonce gap filling logic
    async clearStuckTransactions() {
        console.log('\n🧹 Clearing stuck transactions...');
        
        for (const wallet of this.evmWallets) {
            try {
                const latest = await this.evmProvider.getTransactionCount(wallet.address, 'latest');
                const pending = await this.evmProvider.getTransactionCount(wallet.address, 'pending');
                
                if (pending > latest) {
                    console.log(`Clearing ${pending - latest} stuck txs for ${wallet.address}`);
                    
                    // Use high fees to ensure fast processing
                    const feeData = await this.evmProvider.getFeeData();
                    const network = await this.evmProvider.getNetwork();
                    
                    for (let nonce = latest; nonce < pending; nonce++) {
                        try {
                            // Use legacy transaction format with very high gas price for guaranteed clearing
                            const baseGasPrice = feeData.gasPrice || BigInt(1000000000); // 1 gwei minimum
                            const clearTx = {
                                to: wallet.address, // Send to self
                                value: 0,
                                gasLimit: 21000,
                                gasPrice: baseGasPrice * BigInt(20), // 20x base gas price for clearing
                                nonce: nonce,
                                chainId: Number(network.chainId)
                            };
                            
                            const signedTx = await wallet.wallet.signTransaction(clearTx);
                            const txResponse = await this.evmProvider.broadcastTransaction(signedTx);
                            console.log(`  ✅ Cleared nonce ${nonce}: ${txResponse.hash}`);
                            
                            await this.sleep(1000); // Longer delay between clears
                        } catch (error) {
                            console.log(`  ⚠️  Failed to clear nonce ${nonce}: ${error.message}`);
                            // Try with even higher gas price
                            try {
                                const highGasPrice = (feeData.gasPrice || BigInt(1000000000)) * BigInt(50); // 50x gas
                                const clearTx = {
                                    to: wallet.address,
                                    value: 0,
                                    gasLimit: 21000,
                                    gasPrice: highGasPrice,
                                    nonce: nonce,
                                    chainId: Number(network.chainId)
                                };
                                const signedTx = await wallet.wallet.signTransaction(clearTx);
                                const txResponse = await this.evmProvider.broadcastTransaction(signedTx);
                                console.log(`  ✅ Cleared nonce ${nonce} with high gas: ${txResponse.hash}`);
                            } catch (retryError) {
                                console.log(`  ❌ Failed to clear nonce ${nonce} even with high gas: ${retryError.message}`);
                            }
                        }
                    }
                    
                    // Wait for clears to process and check multiple times
                    let cleared = false;
                    for (let attempt = 0; attempt < 10; attempt++) {
                        await this.sleep(2000);
                        const newLatest = await this.evmProvider.getTransactionCount(wallet.address, 'latest');
                        const newPending = await this.evmProvider.getTransactionCount(wallet.address, 'pending');
                        
                        console.log(`  Check ${attempt + 1}: latest=${newLatest}, pending=${newPending}, original_pending=${pending}`);
                        
                        if (newLatest >= pending) {
                            // All stuck transactions have been cleared
                            wallet.currentNonce = newPending;
                            wallet.baseNonce = newLatest;
                            wallet.pendingTxs.clear();
                            console.log(`  ✅ Successfully cleared all stuck transactions for ${wallet.address}`);
                            cleared = true;
                            break;
                        }
                    }
                    
                    if (!cleared) {
                        console.log(`  ⚠️  Some transactions may still be stuck for ${wallet.address}`);
                        // Still update to current state
                        const finalPending = await this.evmProvider.getTransactionCount(wallet.address, 'pending');
                        wallet.currentNonce = finalPending;
                        wallet.baseNonce = await this.evmProvider.getTransactionCount(wallet.address, 'latest');
                        wallet.pendingTxs.clear();
                    }
                }
            } catch (error) {
                console.error(`Failed to clear stuck txs for wallet ${wallet.index}: ${error.message}`);
            }
        }
        
        console.log('🧹 Stuck transaction clearing complete!');
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

export default AdvancedTransactionSpammer;

// CLI interface
async function main() {
    const args = process.argv.slice(2);
    const duration = parseInt(args[0]) || 180;
    const evmTps = parseInt(args[1]) || 5;
    const cosmosTps = parseInt(args[2]) || 3;
    const numWallets = parseInt(args[3]) || 20;
    
    console.log('🔧 Advanced Transaction Spammer (Fixed Version)');
    console.log('Key improvements:');
    console.log('  - Independent EVM/Cosmos sequence management');
    console.log('  - Better fee replacement strategy');
    console.log('  - Standard cosmjs for Cosmos transactions');
    console.log('  - Improved nonce gap handling');
    console.log('  - Rate limiting and error recovery\n');
    
    const spammer = new AdvancedTransactionSpammer();
    await spammer.runAdvancedTest(duration, evmTps, cosmosTps, numWallets);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}