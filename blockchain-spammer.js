/**
 * Unified Blockchain Spammer
 *
 * Merges all spammer scripts (evm-spam, cosmos-spam, transaction-spammer,
 * dual-spam, dual-wallet, unified-dual-spam, multi-chain-diverse-spam; archived
 * in legacy/) into a single entry point with an interactive setup wizard, JSON
 * key file support, integrated contract deployment, and auto-launch of the
 * existing tools/mempool-dashboard.js.
 *
 * Usage:
 *   node blockchain-spammer.js                   # Interactive wizard
 *   node blockchain-spammer.js --help             # Print usage
 *   node blockchain-spammer.js --chains=evm ...   # Non-interactive CLI
 */

import { ethers } from 'ethers';
import { StargateClient, SigningStargateClient, coins } from '@cosmjs/stargate';
import { DirectSecp256k1Wallet, makeAuthInfoBytes, makeSignDoc } from '@cosmjs/proto-signing';
import { Tendermint34Client } from '@cosmjs/tendermint-rpc';
import { bech32 } from 'bech32';
import { TxRaw, SignDoc, TxBody } from 'cosmjs-types/cosmos/tx/v1beta1/tx.js';
import { Any } from 'cosmjs-types/google/protobuf/any.js';
import { MsgSend } from 'cosmjs-types/cosmos/bank/v1beta1/tx.js';
import Long from 'long';
import { keccak_256 } from '@noble/hashes/sha3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { toBase64 } from '@cosmjs/encoding';
import { mnemonicToSeedSync, validateMnemonic } from 'bip39';
import { BIP32Factory } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import readline from 'readline';
import solc from 'solc';
import dotenv from 'dotenv';
import MetricsAnalyzer from './lib/metrics-analyzer.js';

dotenv.config();

const bip32 = BIP32Factory(ecc);

// ---------------------------------------------------------------------------
// SecureKeyManager - BIP32 key derivation, EVM + Cosmos address generation
// ---------------------------------------------------------------------------
class SecureKeyManager {
    constructor() {
        this._keys = new Map();
        this._addressCache = null;
        this._initialized = false;
    }

    /**
     * Initialize from mnemonic using default ETH derivation path.
     * @param {string} mnemonic - BIP39 mnemonic phrase
     */
    async initialize(mnemonic) {
        return this.initializeWithPath(mnemonic, "m/44'/60'/0'/0/0");
    }

    /**
     * Initialize from mnemonic using an explicit derivation path.
     * @param {string} mnemonic - BIP39 mnemonic phrase
     * @param {string} derivationPath - BIP32 derivation path
     */
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

        this._addressCache = {
            evm: {
                address: evmAddress,
                publicKey: '0x' + Buffer.from(publicKeyBytesCompressed).toString('hex'),
            },
            cosmos: {
                publicKey: Buffer.from(publicKeyBytesCompressed).toString('hex'),
            },
        };

        this._keys.set('privateKey', privateKeyBytes);
        this._keys.set('publicKey', publicKeyBytesCompressed);
        this._initialized = true;
    }

    /**
     * Initialize directly from a raw hex private key (no mnemonic).
     * @param {string} privateKeyHex - Hex-encoded private key (with or without 0x prefix)
     */
    initializeFromPrivateKey(privateKeyHex) {
        if (this._initialized) return;

        const hex = privateKeyHex.replace(/^0x/, '');
        const privateKeyBytes = Buffer.from(hex, 'hex');
        const publicKeyBytes = secp256k1.getPublicKey(privateKeyBytes, false);
        const publicKeyBytesCompressed = secp256k1.getPublicKey(privateKeyBytes, true);

        const evmAddress = this._deriveEvmAddress(publicKeyBytes);

        this._addressCache = {
            evm: {
                address: evmAddress,
                publicKey: '0x' + Buffer.from(publicKeyBytesCompressed).toString('hex'),
            },
            cosmos: {
                publicKey: Buffer.from(publicKeyBytesCompressed).toString('hex'),
            },
        };

        this._keys.set('privateKey', privateKeyBytes);
        this._keys.set('publicKey', publicKeyBytesCompressed);
        this._initialized = true;
    }

    /** @private */
    _deriveEvmAddress(publicKeyBytes) {
        const publicKeyWithoutPrefix = publicKeyBytes.slice(1);
        const addressBytes = keccak_256(publicKeyWithoutPrefix).slice(-20);
        return '0x' + Buffer.from(addressBytes).toString('hex');
    }

    /**
     * Derive a Cosmos bech32 address from an EVM hex address.
     * For eth_secp256k1, the Cosmos address is the EVM address bytes
     * bech32-encoded (NO ripemd160 hashing).
     * @param {string} evmAddressHex
     * @param {string} prefix - bech32 prefix
     * @returns {string}
     */
    static deriveCosmosAddress(evmAddressHex, prefix) {
        const addressBytes = Buffer.from(evmAddressHex.replace('0x', ''), 'hex');
        const words = bech32.toWords(addressBytes);
        return bech32.encode(prefix, words);
    }

    getPrivateKeyHex() {
        this._ensureInitialized();
        return '0x' + Buffer.from(this._keys.get('privateKey')).toString('hex');
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

    getCosmosAddress(prefix) {
        this._ensureInitialized();
        return SecureKeyManager.deriveCosmosAddress(this._addressCache.evm.address, prefix);
    }

    /** @private */
    _ensureInitialized() {
        if (!this._initialized) {
            throw new Error('SecureKeyManager not initialized. Call initialize() first.');
        }
    }
}

// ---------------------------------------------------------------------------
// KeyLoader - load keys from .env, JSON file, or interactive entry
// ---------------------------------------------------------------------------
class KeyLoader {
    /**
     * Load wallet private keys from the .env file.
     * Hydrates PRIVATE_KEY* from MNEMONIC* when needed (like multi-chain-diverse-spam).
     * @returns {{ privateKeys: string[], mnemonics: string[] }}
     */
    static loadFromEnv() {
        const privateKeyVars = ['PRIVATE_KEY', 'PRIVATE_KEY_1', 'PRIVATE_KEY_2', 'PRIVATE_KEY_3'];
        const mnemonicVars = ['MNEMONIC', 'MNEMONIC_1', 'MNEMONIC_2', 'MNEMONIC_3'];

        // Hydrate PRIVATE_KEY from MNEMONIC if missing
        for (let i = 0; i < privateKeyVars.length; i++) {
            const pkVar = privateKeyVars[i];
            const mnVar = mnemonicVars[i];
            if (process.env[mnVar] && !process.env[pkVar]) {
                try {
                    const wallet = ethers.Wallet.fromPhrase(process.env[mnVar]);
                    process.env[pkVar] = wallet.privateKey;
                    console.log(`Derived ${pkVar} from ${mnVar}`);
                } catch (err) {
                    console.error(`Failed to derive ${pkVar} from ${mnVar}: ${err.message}`);
                }
            }
        }

        const privateKeys = privateKeyVars.map((v) => process.env[v]).filter(Boolean);
        const mnemonics = mnemonicVars.map((v) => process.env[v]).filter(Boolean);

        return { privateKeys, mnemonics };
    }

    /**
     * Load wallet keys from a JSON file.
     * Schema: { keys: [{ privateKey, label }], mnemonics: [{ mnemonic, derivationPaths, label }] }
     * @param {string} filePath
     * @returns {{ privateKeys: string[], mnemonics: string[] }}
     */
    static loadFromJsonFile(filePath) {
        const absPath = path.resolve(filePath);
        if (!fs.existsSync(absPath)) {
            throw new Error(`Key file not found: ${absPath}`);
        }

        const data = JSON.parse(fs.readFileSync(absPath, 'utf8'));
        const privateKeys = [];
        const mnemonics = [];

        if (data.keys && Array.isArray(data.keys)) {
            for (const entry of data.keys) {
                if (entry.privateKey) {
                    privateKeys.push(entry.privateKey);
                    console.log(`Loaded key: ${entry.label || 'unlabeled'}`);
                }
            }
        }

        if (data.mnemonics && Array.isArray(data.mnemonics)) {
            for (const entry of data.mnemonics) {
                if (entry.mnemonic) {
                    mnemonics.push(entry.mnemonic);
                    const numPaths = entry.derivationPaths || 1;
                    // Expand mnemonic into N private keys via BIP32
                    for (let idx = 0; idx < numPaths; idx++) {
                        try {
                            const derivationPath = `m/44'/60'/0'/0/${idx}`;
                            const seed = mnemonicToSeedSync(entry.mnemonic);
                            const root = bip32.fromSeed(seed);
                            const node = root.derivePath(derivationPath);
                            if (node.privateKey) {
                                const hex = '0x' + Buffer.from(node.privateKey).toString('hex');
                                privateKeys.push(hex);
                                console.log(`Derived key ${idx} from mnemonic "${entry.label || 'unlabeled'}"`);
                            }
                        } catch (err) {
                            console.error(`Failed to derive path index ${idx}: ${err.message}`);
                        }
                    }
                }
            }
        }

        if (privateKeys.length === 0) {
            throw new Error('No usable keys found in JSON file');
        }

        return { privateKeys, mnemonics };
    }

    /**
     * Expand mnemonics from .env into multiple derived private keys.
     * @param {string[]} mnemonics
     * @param {number} walletsPerMnemonic
     * @returns {string[]} privateKeyHexes
     */
    static expandMnemonics(mnemonics, walletsPerMnemonic = 5) {
        const keys = [];
        for (const mnemonic of mnemonics) {
            for (let idx = 0; idx < walletsPerMnemonic; idx++) {
                try {
                    const derivationPath = `m/44'/60'/0'/0/${idx}`;
                    const seed = mnemonicToSeedSync(mnemonic);
                    const root = bip32.fromSeed(seed);
                    const node = root.derivePath(derivationPath);
                    if (node.privateKey) {
                        keys.push('0x' + Buffer.from(node.privateKey).toString('hex'));
                    }
                } catch (err) {
                    console.error(`Mnemonic derivation error at index ${idx}: ${err.message}`);
                }
            }
        }
        return keys;
    }

    /**
     * Interactive key entry via readline prompts.
     * @param {readline.Interface} rl
     * @returns {Promise<{ privateKeys: string[], mnemonics: string[] }>}
     */
    static async loadInteractive(rl) {
        const privateKeys = [];
        const mnemonics = [];

        const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

        console.log('\nEnter private keys (hex, one per line). Empty line to stop:');
        while (true) {
            const pk = (await ask('  Private key: ')).trim();
            if (!pk) break;
            privateKeys.push(pk.startsWith('0x') ? pk : '0x' + pk);
        }

        console.log('Enter mnemonics (one per line). Empty line to stop:');
        while (true) {
            const mn = (await ask('  Mnemonic: ')).trim();
            if (!mn) break;
            mnemonics.push(mn);

            const paths = parseInt((await ask('  Derivation paths to expand [1]: ')).trim() || '1', 10);
            const expanded = KeyLoader.expandMnemonics([mn], paths);
            privateKeys.push(...expanded);
            console.log(`  Expanded into ${expanded.length} key(s)`);
        }

        if (privateKeys.length === 0) {
            throw new Error('No keys entered');
        }

        return { privateKeys, mnemonics };
    }
}

// ---------------------------------------------------------------------------
// UnifiedWallet - single wallet holding EVM + Cosmos capabilities
// ---------------------------------------------------------------------------
class UnifiedWallet {
    /**
     * @param {object} opts
     * @param {number} opts.index
     * @param {string} opts.privateKeyHex
     * @param {ethers.JsonRpcProvider} opts.evmProvider
     * @param {string} opts.cosmosPrefix
     * @param {number} opts.evmChainId
     */
    constructor({ index, privateKeyHex, evmProvider, cosmosPrefix, evmChainId }) {
        this.index = index;
        this.privateKeyHex = privateKeyHex;
        this.evmProvider = evmProvider;
        this.cosmosPrefix = cosmosPrefix;
        this.evmChainId = evmChainId;

        // EVM
        this.evmWallet = new ethers.Wallet(privateKeyHex, evmProvider);
        this.evmAddress = this.evmWallet.address;

        // Cosmos
        const pkBytes = Buffer.from(privateKeyHex.replace('0x', ''), 'hex');
        this.privateKeyBytes = pkBytes;
        this.publicKeyBytes = Buffer.from(secp256k1.getPublicKey(pkBytes, true));
        this.cosmosAddress = SecureKeyManager.deriveCosmosAddress(this.evmAddress, cosmosPrefix);

        // Nonce / sequence
        this.nonce = null; // current EVM nonce
        this.pendingTxs = new Map(); // nonce -> txHash
        this.lastReplacement = 0;

        // Cosmos signing client (set during initialization)
        this.cosmosWallet = null; // DirectSecp256k1Wallet
        this.cosmosClient = null; // SigningStargateClient
    }
}

// ---------------------------------------------------------------------------
// WalletManager - create + manage a pool of UnifiedWallet instances
// ---------------------------------------------------------------------------
class WalletManager {
    /**
     * @param {object} opts
     * @param {string[]} opts.privateKeys
     * @param {ethers.JsonRpcProvider} opts.evmProvider
     * @param {string} opts.cosmosRpcUrl
     * @param {string} opts.cosmosPrefix
     * @param {string} opts.cosmosDenom
     * @param {number} opts.evmChainId
     */
    constructor({ privateKeys, evmProvider, cosmosRpcUrl, cosmosPrefix, cosmosDenom, evmChainId }) {
        this.evmProvider = evmProvider;
        this.cosmosRpcUrl = cosmosRpcUrl;
        this.cosmosPrefix = cosmosPrefix;
        this.cosmosDenom = cosmosDenom;
        this.evmChainId = evmChainId;
        this.privateKeys = privateKeys;
        /** @type {UnifiedWallet[]} */
        this.wallets = [];
    }

    /**
     * Create wallet objects and optionally connect Cosmos signing clients.
     * @param {{ initCosmos: boolean }} opts
     */
    async initialize({ initCosmos = false } = {}) {
        console.log(`Initializing ${this.privateKeys.length} wallets...`);

        for (let i = 0; i < this.privateKeys.length; i++) {
            const w = new UnifiedWallet({
                index: i,
                privateKeyHex: this.privateKeys[i],
                evmProvider: this.evmProvider,
                cosmosPrefix: this.cosmosPrefix,
                evmChainId: this.evmChainId,
            });

            if (initCosmos) {
                try {
                    w.cosmosWallet = await DirectSecp256k1Wallet.fromKey(w.privateKeyBytes, this.cosmosPrefix);
                    w.cosmosClient = await SigningStargateClient.connectWithSigner(this.cosmosRpcUrl, w.cosmosWallet, {
                        gasPrice: { denom: this.cosmosDenom, amount: '25000000000' },
                    });
                } catch (err) {
                    console.error(`Cosmos init failed for wallet ${i}: ${err.message}`);
                }
            }

            this.wallets.push(w);
            console.log(`  Wallet ${i}: EVM(${w.evmAddress})  Cosmos(${w.cosmosAddress})`);
        }

        console.log(`Initialized ${this.wallets.length} wallet(s)`);
    }

    /** Initialize EVM nonces for all wallets. */
    async initNonces() {
        for (const w of this.wallets) {
            try {
                w.nonce = await this.evmProvider.getTransactionCount(w.evmAddress, 'pending');
            } catch (err) {
                console.error(`Nonce init failed for wallet ${w.index}: ${err.message}`);
                w.nonce = 0;
            }
        }
    }

    /** Resync nonce for a specific wallet from the chain. */
    async resyncNonce(wallet) {
        try {
            wallet.nonce = await this.evmProvider.getTransactionCount(wallet.evmAddress, 'pending');
        } catch (err) {
            console.error(`Nonce resync failed: ${err.message}`);
        }
    }

    /**
     * Fund wallets below threshold from the richest wallet.
     * @param {{ evmThreshold: bigint, cosmosThreshold: number, cosmosFundAmount: string, evmFundAmount: bigint }} opts
     */
    async autoFundWallets({
        evmThreshold = ethers.parseEther('0.05'),
        cosmosThreshold = 100000000,
        cosmosFundAmount = '1000000000',
        evmFundAmount = ethers.parseEther('0.1'),
    } = {}) {
        if (this.wallets.length < 2) return;

        // Find richest EVM wallet
        let richest = this.wallets[0];
        let richestBal = 0n;
        for (const w of this.wallets) {
            try {
                const bal = await this.evmProvider.getBalance(w.evmAddress);
                if (bal > richestBal) {
                    richestBal = bal;
                    richest = w;
                }
            } catch { /* skip */ }
        }

        console.log(`Funding from wallet ${richest.index} (${richest.evmAddress})`);

        // Fund EVM
        let fundingNonce = await this.evmProvider.getTransactionCount(richest.evmAddress, 'pending');
        for (const w of this.wallets) {
            if (w === richest) continue;
            try {
                const bal = await this.evmProvider.getBalance(w.evmAddress);
                if (bal < evmThreshold) {
                    const tx = {
                        to: w.evmAddress,
                        value: evmFundAmount,
                        gasLimit: 21000,
                        nonce: fundingNonce,
                        gasPrice: BigInt(1000000000),
                    };
                    const resp = await richest.evmWallet.sendTransaction(tx);
                    console.log(`  EVM funded wallet ${w.index}: ${resp.hash}`);
                    fundingNonce++;
                    await sleep(100);
                }
            } catch (err) {
                console.error(`  EVM funding failed for wallet ${w.index}: ${err.message}`);
            }
        }

        // Fund Cosmos (if signing client available)
        if (!richest.cosmosClient) return;
        for (const w of this.wallets) {
            if (w === richest) continue;
            try {
                const bal = await richest.cosmosClient.getBalance(w.cosmosAddress, this.cosmosDenom);
                if (parseInt(bal.amount) < cosmosThreshold) {
                    const sendMsg = {
                        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
                        value: {
                            fromAddress: richest.cosmosAddress,
                            toAddress: w.cosmosAddress,
                            amount: coins(cosmosFundAmount, this.cosmosDenom),
                        },
                    };
                    const fee = { amount: coins(50000000000, this.cosmosDenom), gas: '200000' };
                    const result = await richest.cosmosClient.signAndBroadcast(richest.cosmosAddress, [sendMsg], fee);
                    if (result.code === 0) {
                        console.log(`  Cosmos funded wallet ${w.index}: ${result.transactionHash}`);
                    }
                }
            } catch (err) {
                console.error(`  Cosmos funding failed for wallet ${w.index}: ${err.message}`);
            }
        }
    }

    getRandomWallet() {
        return this.wallets[Math.floor(Math.random() * this.wallets.length)];
    }
}

// ---------------------------------------------------------------------------
// ContractDeployer - Solidity compilation + deployment via solc
// ---------------------------------------------------------------------------
class ContractDeployer {
    /**
     * @param {ethers.JsonRpcProvider} provider
     */
    constructor(provider) {
        this.provider = provider;
        this.contracts = {};
    }

    /** Load contract addresses from .env. */
    loadFromEnv() {
        if (process.env.TEST_ERC20_CONTRACT) this.contracts.erc20 = process.env.TEST_ERC20_CONTRACT;
        if (process.env.TEST_STORAGE_CONTRACT) this.contracts.storage = process.env.TEST_STORAGE_CONTRACT;
        if (process.env.TEST_COUNTER_CONTRACT) this.contracts.counter = process.env.TEST_COUNTER_CONTRACT;
        return this.contracts;
    }

    /** Validate that contract addresses actually have deployed code. */
    async validateContracts() {
        const entries = Object.entries(this.contracts);
        if (entries.length === 0) return;

        console.log('Validating deployed contracts on-chain...');
        const validated = {};
        for (const [name, address] of entries) {
            if (!address) continue;
            try {
                const code = await this.provider.getCode(address);
                if (code && code !== '0x') {
                    validated[name] = address;
                    console.log(`  ${name}: code found at ${address}`);
                } else {
                    console.warn(`  ${name}: no code at ${address}; skipped`);
                }
            } catch (err) {
                console.warn(`  ${name}: failed to read code: ${err.message}`);
            }
        }
        this.contracts = validated;
        console.log('Active contracts:', Object.keys(this.contracts));
    }

    /**
     * Compile a Solidity contract via solc.
     * @param {string} contractName - name without .sol extension
     * @returns {{ abi: any, bytecode: string }}
     */
    compileContract(contractName) {
        const contractPath = path.join('contracts', `${contractName}.sol`);
        if (!fs.existsSync(contractPath)) {
            throw new Error(`Contract file not found: ${contractPath}`);
        }

        console.log(`Compiling ${contractName}...`);
        const solidityCode = fs.readFileSync(contractPath, 'utf8');
        const input = {
            language: 'Solidity',
            sources: { [contractName]: { content: solidityCode } },
            settings: { outputSelection: { '*': { '*': ['*'] } } },
        };

        const output = JSON.parse(solc.compile(JSON.stringify(input)));
        if (output.errors) {
            for (const err of output.errors) {
                if (err.severity === 'error') throw new Error(`Compilation error: ${err.message}`);
                console.warn(`Warning: ${err.message}`);
            }
        }

        const contract = output.contracts[contractName][contractName];
        return { abi: contract.abi, bytecode: contract.evm.bytecode.object };
    }

    /**
     * Deploy all test contracts and persist addresses to .env + deployment.json.
     * @param {UnifiedWallet[]} wallets
     */
    async deployAll(wallets) {
        // Select deployer: highest balance
        let best = null;
        for (const w of wallets) {
            try {
                const bal = await this.provider.getBalance(w.evmAddress);
                if (!best || bal > best.balance) {
                    best = { wallet: w, balance: bal };
                }
            } catch { /* skip */ }
        }

        if (!best || best.balance === 0n) {
            console.error('No funded wallet available for deployment');
            return;
        }

        const deployer = best.wallet;
        console.log(`Deployer: wallet ${deployer.index} (${deployer.evmAddress})`);

        const deployed = {};

        try {
            const erc20 = await this._deploy(deployer, 'TestERC20', [1000000]);
            deployed.TestERC20 = erc20;
            this.contracts.erc20 = erc20;
        } catch (err) {
            console.error(`TestERC20 deployment failed: ${err.message}`);
        }

        try {
            const storage = await this._deploy(deployer, 'TestStorage');
            deployed.TestStorage = storage;
            this.contracts.storage = storage;
        } catch (err) {
            console.error(`TestStorage deployment failed: ${err.message}`);
        }

        try {
            const counter = await this._deploy(deployer, 'TestCounter');
            deployed.TestCounter = counter;
            this.contracts.counter = counter;
        } catch (err) {
            console.error(`TestCounter deployment failed: ${err.message}`);
        }

        // Persist to .env
        try {
            const envPath = '.env';
            if (fs.existsSync(envPath)) {
                let envContent = fs.readFileSync(envPath, 'utf8');
                if (deployed.TestERC20) envContent = envContent.replace(/TEST_ERC20_CONTRACT=.*/, `TEST_ERC20_CONTRACT=${deployed.TestERC20}`);
                if (deployed.TestStorage) envContent = envContent.replace(/TEST_STORAGE_CONTRACT=.*/, `TEST_STORAGE_CONTRACT=${deployed.TestStorage}`);
                if (deployed.TestCounter) envContent = envContent.replace(/TEST_COUNTER_CONTRACT=.*/, `TEST_COUNTER_CONTRACT=${deployed.TestCounter}`);
                fs.writeFileSync(envPath, envContent);
                console.log('.env updated with contract addresses');
            }
        } catch (err) {
            console.warn(`Could not update .env: ${err.message}`);
        }

        // Persist deployment info
        try {
            const info = {
                timestamp: new Date().toISOString(),
                network: {
                    rpcUrl: this.provider._getConnection?.().url ?? 'unknown',
                    chainId: (await this.provider.getNetwork()).chainId.toString(),
                },
                deployer: deployer.evmAddress,
                contracts: deployed,
            };
            fs.writeFileSync('deployment.json', JSON.stringify(info, null, 2));
            console.log('Deployment info saved to deployment.json');
        } catch (err) {
            console.warn(`Could not save deployment.json: ${err.message}`);
        }
    }

    /**
     * @private
     * @param {UnifiedWallet} deployer
     * @param {string} contractName
     * @param {any[]} constructorArgs
     * @returns {Promise<string>} deployed address
     */
    async _deploy(deployer, contractName, constructorArgs = []) {
        const { abi, bytecode } = this.compileContract(contractName);
        console.log(`Deploying ${contractName}...`);

        const factory = new ethers.ContractFactory(abi, bytecode, deployer.evmWallet);
        const contract = await factory.deploy(...constructorArgs);
        console.log(`  tx: ${contract.deploymentTransaction().hash}`);

        await contract.waitForDeployment();
        const address = await contract.getAddress();
        console.log(`  ${contractName} deployed at ${address}`);
        return address;
    }
}

// ---------------------------------------------------------------------------
// EvmTransactionEngine - All 6 EVM tx types, nonce mgmt, gas, locks
// ---------------------------------------------------------------------------
class EvmTransactionEngine {
    /**
     * @param {object} opts
     * @param {ethers.JsonRpcProvider} opts.provider
     * @param {number} opts.chainId
     * @param {object} opts.contracts
     * @param {StatsCollector} opts.stats
     * @param {WalletManager} opts.walletManager
     */
    constructor({ provider, chainId, contracts, stats, walletManager }) {
        this.provider = provider;
        this.chainId = chainId;
        this.contracts = contracts;
        this.stats = stats;
        this.walletManager = walletManager;
        this.walletLocks = new Map();

        // Block-aware tracking
        this.currentBlock = 0;
        this.walletBlockState = new Map();
    }

    async updateCurrentBlock() {
        try {
            const block = await this.provider.getBlock('latest');
            this.currentBlock = block.number;
        } catch { /* ignore */ }
    }

    canWalletSendTx(walletIndex) {
        const state = this.walletBlockState.get(walletIndex);
        if (!state) return true;
        return state.lastTxBlock < this.currentBlock;
    }

    recordWalletTx(walletIndex) {
        this.walletBlockState.set(walletIndex, { lastTxBlock: this.currentBlock });
    }

    async acquireWalletLock(walletIndex) {
        while (this.walletLocks.get(walletIndex)) {
            await sleep(1);
        }
        this.walletLocks.set(walletIndex, true);
    }

    releaseWalletLock(walletIndex) {
        this.walletLocks.set(walletIndex, false);
    }

    getGasPrice(feeData) {
        if (feeData && feeData.gasPrice) return feeData.gasPrice;
        const fallbackGwei = process.env.EVM_GAS_PRICE_GWEI || '1';
        try {
            return ethers.parseUnits(fallbackGwei, 'gwei');
        } catch {
            return ethers.parseUnits('1', 'gwei');
        }
    }

    // -- ABI data generators ------------------------------------------------

    generateERC20MintData(toAddress, amount) {
        const iface = new ethers.Interface(['function mint(address to, uint256 amount)']);
        return iface.encodeFunctionData('mint', [toAddress, amount]);
    }

    generateERC20TransferData(toAddress, amount) {
        const iface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
        return iface.encodeFunctionData('transfer', [toAddress, amount]);
    }

    generateCounterIncrementData(amount = 1) {
        const iface = new ethers.Interface(['function incrementBy(uint256 amount)']);
        return iface.encodeFunctionData('incrementBy', [amount]);
    }

    generateStorageData(value) {
        const iface = new ethers.Interface(['function storeValue(uint256 value)']);
        return iface.encodeFunctionData('storeValue', [value]);
    }

    generateHeavyComputationData(iterations) {
        const iface = new ethers.Interface(['function heavyComputation(uint256 iterations) returns (uint256)']);
        return iface.encodeFunctionData('heavyComputation', [iterations]);
    }

    // -- Simple send methods ------------------------------------------------

    /**
     * Send an ETH transfer.
     * @param {UnifiedWallet} wallet
     * @param {string} toAddress
     * @param {bigint} amount
     * @returns {Promise<object|null>}
     */
    async sendEthTransfer(wallet, toAddress, amount) {
        try {
            const feeData = await this.provider.getFeeData();
            const gasPrice = this.getGasPrice(feeData);
            const nonce = wallet.nonce;
            const gasLimit = 21000n;

            const balance = await this.provider.getBalance(wallet.evmAddress);
            if (balance < gasPrice * gasLimit) {
                return null; // insufficient for gas
            }

            const tx = {
                to: toAddress,
                value: amount,
                gasLimit,
                gasPrice,
                nonce,
                chainId: this.chainId,
            };

            const signedTx = await wallet.evmWallet.signTransaction(tx);
            const resp = await this.provider.broadcastTransaction(signedTx);
            wallet.nonce = nonce + 1;
            this.stats.recordEvm(true, resp.hash);
            return resp;
        } catch (err) {
            this.stats.recordEvm(false, null, err);
            await this._handleNonceError(wallet, err);
            return null;
        }
    }

    /**
     * Send a contract call.
     * @param {UnifiedWallet} wallet
     * @param {string} contractAddress
     * @param {string} data
     * @param {number} gasLimit
     * @returns {Promise<object|null>}
     */
    async sendContractCall(wallet, contractAddress, data, gasLimit = 100000) {
        try {
            const feeData = await this.provider.getFeeData();
            const gasPrice = this.getGasPrice(feeData);
            const nonce = wallet.nonce;
            const gasLimitBig = BigInt(gasLimit);

            const balance = await this.provider.getBalance(wallet.evmAddress);
            if (balance < gasPrice * gasLimitBig) {
                return null;
            }

            const tx = {
                to: contractAddress,
                data,
                gasLimit: gasLimitBig,
                gasPrice,
                nonce,
                chainId: this.chainId,
            };

            const signedTx = await wallet.evmWallet.signTransaction(tx);
            const resp = await this.provider.broadcastTransaction(signedTx);
            wallet.nonce = nonce + 1;
            this.stats.recordEvm(true, resp.hash);
            return resp;
        } catch (err) {
            this.stats.recordEvm(false, null, err);
            await this._handleNonceError(wallet, err);
            return null;
        }
    }

    /**
     * Advanced EVM transaction with lock, optional gap creation, and replacement.
     * Ported from AdvancedTransactionSpammer.sendAdvancedEvmTransaction.
     * @param {UnifiedWallet} wallet
     * @param {object} options
     */
    async sendAdvancedTransaction(wallet, options = {}) {
        await this.acquireWalletLock(wallet.index);
        try {
            const {
                createGap = false,
                gapSize = 5,
                replaceExisting = false,
                feeBump = 2.5,
                transactionType = 'contract',
            } = options;

            let nonce;
            let feeConfig = {};
            const feeData = await this.provider.getFeeData();
            const isEIP1559 = Boolean(feeData.maxFeePerGas && feeData.maxPriorityFeePerGas);

            if (createGap) {
                nonce = wallet.nonce + gapSize;
                this.stats.evmGapped++;
            } else if (replaceExisting) {
                const pendingSeqs = Array.from(wallet.pendingTxs.keys()).sort((a, b) => a - b);
                if (pendingSeqs.length > 0 && Date.now() - wallet.lastReplacement > 5000) {
                    nonce = pendingSeqs[0];
                    wallet.lastReplacement = Date.now();

                    if (isEIP1559) {
                        const baseMult = Math.max(feeBump, 1.125);
                        const prioMult = Math.max(feeBump, 1.5);
                        feeConfig = {
                            maxFeePerGas: feeData.maxFeePerGas * BigInt(Math.floor(baseMult * 100)) / 100n,
                            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas * BigInt(Math.floor(prioMult * 100)) / 100n,
                            type: 2,
                        };
                    } else {
                        const gasMult = Math.max(feeBump, 1.1);
                        feeConfig = {
                            gasPrice: feeData.gasPrice * BigInt(Math.floor(gasMult * 100)) / 100n,
                            type: 0,
                        };
                    }
                    this.stats.evmReplaced++;
                } else {
                    nonce = wallet.nonce;
                    wallet.nonce++;
                }
            } else {
                nonce = await this.provider.getTransactionCount(wallet.evmAddress, 'pending');
            }

            if (Object.keys(feeConfig).length === 0) {
                if (isEIP1559) {
                    feeConfig = {
                        maxFeePerGas: feeData.maxFeePerGas || 10000000000n,
                        maxPriorityFeePerGas: feeData.maxPriorityFeePerGas || 1000000000n,
                        type: 2,
                    };
                } else {
                    feeConfig = {
                        gasPrice: feeData.gasPrice || 1000000000n,
                        type: 0,
                    };
                }
            }

            let tx;
            if (transactionType === 'eth_transfer') {
                const to = this.walletManager.getRandomWallet();
                if (to === wallet) return null;
                tx = {
                    to: to.evmAddress,
                    value: ethers.parseEther((Math.random() * 0.001).toFixed(6)),
                    gasLimit: 21000,
                    nonce,
                    chainId: this.chainId,
                    ...feeConfig,
                };
            } else {
                const contractAddress = this.contracts.counter;
                if (!contractAddress) return null;
                const data = this.generateCounterIncrementData(Math.floor(Math.random() * 5) + 1);
                tx = {
                    to: contractAddress,
                    data,
                    gasLimit: 100000,
                    nonce,
                    chainId: this.chainId,
                    ...feeConfig,
                };
            }

            const signedTx = await wallet.evmWallet.signTransaction(tx);
            const resp = await this.provider.broadcastTransaction(signedTx);

            // Track pending
            if (replaceExisting && wallet.pendingTxs.has(nonce)) {
                wallet.pendingTxs.delete(wallet.pendingTxs.get(nonce));
            }
            wallet.pendingTxs.set(nonce, resp.hash);

            this.stats.recordEvm(true, resp.hash);
            return resp;
        } catch (err) {
            this.stats.recordEvm(false, null, err);
            return null;
        } finally {
            this.releaseWalletLock(wallet.index);
        }
    }

    /** Perform a random EVM operation (weighted mixed mode). */
    async performRandomOperation(wallet) {
        const ops = [
            { type: 'eth_transfer', weight: 30 },
            { type: 'erc20', weight: 25 },
            { type: 'counter', weight: 25 },
            { type: 'storage', weight: 20 },
        ];

        const rand = Math.random() * 100;
        let cum = 0;
        let selected = ops[0];
        for (const op of ops) {
            cum += op.weight;
            if (rand <= cum) { selected = op; break; }
        }

        if (selected.type === 'eth_transfer') {
            const to = this.walletManager.getRandomWallet();
            if (to === wallet) return;
            const amount = ethers.parseEther((Math.random() * 0.0001).toFixed(8));
            await this.sendEthTransfer(wallet, to.evmAddress, amount);
        } else {
            await this._performContractOp(wallet, selected.type);
        }
    }

    /** @private */
    async _performContractOp(wallet, type) {
        const addr = this.contracts[type];
        if (!addr) return;

        let data;
        let gasLimit = 100000;

        switch (type) {
            case 'erc20': {
                const target = this.walletManager.getRandomWallet();
                const amount = ethers.parseUnits((Math.floor(Math.random() * 10) + 1).toString(), 18);
                data = this.generateERC20MintData(target.evmAddress, amount);
                break;
            }
            case 'counter': {
                data = this.generateCounterIncrementData(Math.floor(Math.random() * 5) + 1);
                break;
            }
            case 'storage': {
                if (Math.random() > 0.8) {
                    const iterations = Math.floor(Math.random() * 300) + 50;
                    data = this.generateHeavyComputationData(iterations);
                    gasLimit = 300000;
                } else {
                    data = this.generateStorageData(Math.floor(Math.random() * 1000000));
                }
                break;
            }
        }

        if (data) {
            await this.sendContractCall(wallet, addr, data, gasLimit);
        }
    }

    /** @private */
    async _handleNonceError(wallet, err) {
        const msg = err?.message || '';
        if (
            msg.includes('nonce too low') ||
            msg.includes('replacement transaction underpriced') ||
            msg.includes('transaction nonce is too low') ||
            msg.includes('already known')
        ) {
            await this.walletManager.resyncNonce(wallet);
        }
    }
}

// ---------------------------------------------------------------------------
// CosmosTransactionEngine - Bank sends, staking, validator discovery
// ---------------------------------------------------------------------------
class CosmosTransactionEngine {
    /**
     * @param {object} opts
     * @param {string} opts.rpcUrl
     * @param {string} opts.restUrl
     * @param {string} opts.chainId
     * @param {string} opts.denom
     * @param {string} opts.prefix
     * @param {StatsCollector} opts.stats
     * @param {WalletManager} opts.walletManager
     */
    constructor({ rpcUrl, restUrl, chainId, denom, prefix, stats, walletManager }) {
        this.rpcUrl = rpcUrl;
        this.restUrl = restUrl;
        this.chainId = chainId;
        this.denom = denom;
        this.prefix = prefix;
        this.stats = stats;
        this.walletManager = walletManager;
    }

    async sendBankSend(wallet, toAddress, amount) {
        if (!wallet.cosmosClient) return null;
        try {
            const sendMsg = {
                typeUrl: '/cosmos.bank.v1beta1.MsgSend',
                value: {
                    fromAddress: wallet.cosmosAddress,
                    toAddress,
                    amount: coins(amount, this.denom),
                },
            };
            const fee = { amount: coins(50000000000, this.denom), gas: '200000' };
            const result = await wallet.cosmosClient.signAndBroadcast(wallet.cosmosAddress, [sendMsg], fee, `Bank send ${amount}${this.denom}`);

            if (result.code === 0) {
                this.stats.recordCosmos(true, result.transactionHash);
                return result;
            }
            this.stats.recordCosmos(false);
            return null;
        } catch (err) {
            console.error(`Bank send error: ${err.message}`);
            this.stats.recordCosmos(false);
            return null;
        }
    }

    async delegateToValidator(wallet, validatorAddress, amount) {
        if (!wallet.cosmosClient) return null;
        try {
            const delegateMsg = {
                typeUrl: '/cosmos.staking.v1beta1.MsgDelegate',
                value: {
                    delegatorAddress: wallet.cosmosAddress,
                    validatorAddress,
                    amount: { denom: this.denom, amount: amount.toString() },
                },
            };
            const fee = { amount: coins(75000000000, this.denom), gas: '300000' };
            const result = await wallet.cosmosClient.signAndBroadcast(wallet.cosmosAddress, [delegateMsg], fee);

            if (result.code === 0) {
                this.stats.recordCosmos(true, result.transactionHash);
                return result;
            }
            this.stats.recordCosmos(false);
            return null;
        } catch (err) {
            console.error(`Delegate error: ${err.message}`);
            this.stats.recordCosmos(false);
            return null;
        }
    }

    async undelegateFromValidator(wallet, validatorAddress, amount) {
        if (!wallet.cosmosClient) return null;
        try {
            const undelegateMsg = {
                typeUrl: '/cosmos.staking.v1beta1.MsgUndelegate',
                value: {
                    delegatorAddress: wallet.cosmosAddress,
                    validatorAddress,
                    amount: { denom: this.denom, amount: amount.toString() },
                },
            };
            const fee = { amount: coins(75000000000, this.denom), gas: '300000' };
            const result = await wallet.cosmosClient.signAndBroadcast(wallet.cosmosAddress, [undelegateMsg], fee);

            if (result.code === 0) {
                this.stats.recordCosmos(true, result.transactionHash);
                return result;
            }
            this.stats.recordCosmos(false);
            return null;
        } catch (err) {
            console.error(`Undelegate error: ${err.message}`);
            this.stats.recordCosmos(false);
            return null;
        }
    }

    /** Discover active validators via Tendermint RPC. */
    async getValidators() {
        try {
            const tmClient = await Tendermint34Client.connect(this.rpcUrl);
            const client = await StargateClient.create(tmClient);
            const validators = await client.staking.validators('BOND_STATUS_BONDED');
            const addrs = validators.validators.map((v) => v.operatorAddress);
            console.log(`Found ${addrs.length} active validators`);
            return addrs;
        } catch (err) {
            console.error(`Validator discovery failed: ${err.message}`);
            return [];
        }
    }

    /**
     * Send a Cosmos transaction with manual eth_secp256k1 signing
     * (shared-sequence approach from unified-dual-spam).
     * @param {UnifiedWallet} wallet
     * @param {string} toAddress
     * @param {{ denom: string, amount: string }[]} amounts
     * @param {number} sequence
     * @param {number} accountNumber
     * @returns {Promise<object|null>}
     */
    async sendManualCosmosTx(wallet, toAddress, amounts, sequence, accountNumber) {
        try {
            const messages = [{
                typeUrl: '/cosmos.bank.v1beta1.MsgSend',
                value: MsgSend.fromPartial({
                    fromAddress: wallet.cosmosAddress,
                    toAddress,
                    amount: amounts,
                }),
            }];

            const txBody = TxBody.fromPartial({
                messages: messages.map((msg) =>
                    Any.fromPartial({
                        typeUrl: msg.typeUrl,
                        value: MsgSend.encode(msg.value).finish(),
                    })
                ),
                memo: '',
            });

            // eth_secp256k1 pubkey encoding
            const pubkeyBytes = wallet.publicKeyBytes;
            const fieldTag = (1 << 3) | 2;
            const pubkeyProto = Buffer.concat([
                Buffer.from([fieldTag]),
                Buffer.from([pubkeyBytes.length]),
                pubkeyBytes,
            ]);

            const pubkey = Any.fromPartial({
                typeUrl: '/cosmos.evm.crypto.v1.ethsecp256k1.PubKey',
                value: pubkeyProto,
            });

            const feeAmount = [{ denom: this.denom, amount: '5000' }];
            const gasLimit = Long.fromString('200000');

            const authInfo = makeAuthInfoBytes(
                [{ pubkey, sequence: Long.fromNumber(sequence) }],
                feeAmount,
                gasLimit,
                undefined,
                undefined,
            );

            const signDoc = makeSignDoc(
                TxBody.encode(txBody).finish(),
                authInfo,
                this.chainId,
                Long.fromNumber(accountNumber),
            );

            // Sign with eth_secp256k1 (keccak256 hash)
            const signBytes = SignDoc.encode(signDoc).finish();
            const hashedMessage = Buffer.from(keccak_256(signBytes));
            const sig = secp256k1.sign(hashedMessage, wallet.privateKeyBytes);

            const rHex = sig.r.toString(16).padStart(64, '0');
            const sHex = sig.s.toString(16).padStart(64, '0');
            const signatureBytes = Buffer.concat([Buffer.from(rHex, 'hex'), Buffer.from(sHex, 'hex')]);

            const txRaw = TxRaw.fromPartial({
                bodyBytes: TxBody.encode(txBody).finish(),
                authInfoBytes: authInfo,
                signatures: [signatureBytes],
            });

            const txBytes = TxRaw.encode(txRaw).finish();
            const txBase64 = toBase64(txBytes);

            const broadcastResponse = await fetch(`${this.restUrl}/cosmos/tx/v1beta1/txs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tx_bytes: txBase64, mode: 'BROADCAST_MODE_SYNC' }),
            });

            const result = await broadcastResponse.json();
            if (result.tx_response && result.tx_response.code === 0) {
                this.stats.recordCosmos(true, result.tx_response.txhash);
                return { transactionHash: result.tx_response.txhash, code: 0 };
            }

            this.stats.recordCosmos(false);
            return null;
        } catch (err) {
            console.error(`Manual Cosmos tx error: ${err.message}`);
            this.stats.recordCosmos(false);
            return null;
        }
    }

    /** Get account info from REST API. */
    async getAccountInfo(address) {
        try {
            const response = await fetch(`${this.restUrl}/cosmos/auth/v1beta1/accounts/${address}`);
            if (!response.ok) return { accountNumber: 0, sequence: 0 };
            const data = await response.json();
            const account = data.account;
            if (account && account['@type']) {
                return {
                    accountNumber: parseInt(account.account_number || account.base_account?.account_number || '0'),
                    sequence: parseInt(account.sequence || account.base_account?.sequence || '0'),
                };
            }
            return { accountNumber: 0, sequence: 0 };
        } catch {
            return { accountNumber: 0, sequence: 0 };
        }
    }

    /** Perform a random cosmos operation (weighted mixed mode). */
    async performRandomOperation(wallet, validators = []) {
        const ops = [
            { type: 'bank_send', weight: 70 },
            { type: 'delegate', weight: 20 },
            { type: 'undelegate', weight: 10 },
        ];

        const rand = Math.random() * 100;
        let cum = 0;
        let selected = ops[0];
        for (const op of ops) {
            cum += op.weight;
            if (rand <= cum) { selected = op; break; }
        }

        switch (selected.type) {
            case 'bank_send': {
                const to = this.walletManager.getRandomWallet();
                if (to === wallet) return;
                const amount = Math.floor(Math.random() * 1000) + 1;
                await this.sendBankSend(wallet, to.cosmosAddress, amount);
                break;
            }
            case 'delegate': {
                if (validators.length === 0) return;
                const val = validators[Math.floor(Math.random() * validators.length)];
                const amount = Math.floor(Math.random() * 50000) + 10000;
                await this.delegateToValidator(wallet, val, amount);
                break;
            }
            case 'undelegate': {
                if (validators.length === 0) return;
                const val = validators[Math.floor(Math.random() * validators.length)];
                const amount = Math.floor(Math.random() * 30000) + 5000;
                await this.undelegateFromValidator(wallet, val, amount);
                break;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// MempoolManager - inspection, gap filling, fee replacement, cleanup
// ---------------------------------------------------------------------------
class MempoolManager {
    /**
     * @param {ethers.JsonRpcProvider} provider
     * @param {UnifiedWallet[]} wallets
     */
    constructor(provider, wallets) {
        this.provider = provider;
        this.wallets = wallets;
    }

    /** Inspect mempool and clear gaps / stuck txs for our wallets. */
    async inspectAndClear() {
        try {
            const status = await this.provider.send('txpool_status', []);
            const queued = parseInt(status.queued || '0x0', 16);
            console.log(`Mempool: ${parseInt(status.pending || '0x0', 16)} pending, ${queued} queued`);

            if (queued < 10) return;

            const content = await this.provider.send('txpool_content', []);
            const queuedContent = content.queued || {};
            const ourAddrs = new Set(this.wallets.map((w) => w.evmAddress.toLowerCase()));

            for (const [address, nonceTxs] of Object.entries(queuedContent)) {
                if (!ourAddrs.has(address.toLowerCase())) continue;

                const wallet = this.wallets.find((w) => w.evmAddress.toLowerCase() === address.toLowerCase());
                if (!wallet) continue;

                const nonces = Object.keys(nonceTxs).map(Number).sort((a, b) => a - b);
                const latest = await this.provider.getTransactionCount(address, 'latest');
                const gap = nonces[0] - latest;

                if (gap > 0) {
                    await this._fillGaps(wallet, latest, nonces[0]);
                }
            }
        } catch (err) {
            // txpool_ methods may not be supported
        }
    }

    /** Fill nonce gaps with zero-value self-sends. */
    async fillNonceGaps() {
        for (const wallet of this.wallets) {
            const latest = await this.provider.getTransactionCount(wallet.evmAddress, 'latest');
            const pending = await this.provider.getTransactionCount(wallet.evmAddress, 'pending');
            if (pending > latest) {
                await this._fillGaps(wallet, latest, pending);
            }
        }
    }

    /** @private */
    async _fillGaps(wallet, from, to) {
        const feeData = await this.provider.getFeeData();
        const network = await this.provider.getNetwork();
        const gasPrice = (feeData.gasPrice || 1000000000n) * 50n;

        for (let nonce = from; nonce < to; nonce++) {
            try {
                const tx = {
                    to: wallet.evmAddress,
                    value: 0,
                    gasLimit: 21000,
                    gasPrice,
                    nonce,
                    chainId: Number(network.chainId),
                };
                const signed = await wallet.evmWallet.signTransaction(tx);
                await this.provider.broadcastTransaction(signed);
            } catch { /* skip */ }
        }
    }

    /** Replace stuck transactions with escalating fees (2.5x-5x). */
    async replaceStuck(stuckThresholdMs = 20000) {
        const now = Date.now();
        for (const wallet of this.wallets) {
            for (const [nonce, txHash] of wallet.pendingTxs.entries()) {
                // Only replace if wallet tracks timestamp (simplified check)
                if (now - wallet.lastReplacement < 10000) continue;

                try {
                    const receipt = await this.provider.getTransactionReceipt(txHash);
                    if (receipt) {
                        wallet.pendingTxs.delete(nonce);
                        continue;
                    }
                } catch { /* still pending */ }

                // Send replacement
                try {
                    const feeData = await this.provider.getFeeData();
                    const network = await this.provider.getNetwork();
                    const gasPrice = (feeData.gasPrice || 1000000000n) * 250n / 100n; // 2.5x

                    const tx = {
                        to: wallet.evmAddress,
                        value: 0,
                        gasLimit: 21000,
                        gasPrice,
                        nonce,
                        chainId: Number(network.chainId),
                    };
                    const signed = await wallet.evmWallet.signTransaction(tx);
                    await this.provider.broadcastTransaction(signed);
                    wallet.lastReplacement = Date.now();
                } catch { /* skip */ }
            }
        }
    }

    /** Gentle periodic cleanup during a spam run. */
    async gentleCleanup() {
        try {
            const status = await this.provider.send('txpool_status', []);
            const queued = parseInt(status.queued || '0x0', 16);
            if (queued > 200) {
                console.log(`Mempool overloaded (${queued} queued) - running cleanup...`);
                await this.inspectAndClear();
            }
        } catch { /* ignore */ }
    }
}

// ---------------------------------------------------------------------------
// StatsCollector - per-chain/per-type stats + MetricsAnalyzer integration
// ---------------------------------------------------------------------------
class StatsCollector {
    constructor() {
        this.evm = { total: 0, successful: 0, failed: 0 };
        this.cosmos = { total: 0, successful: 0, failed: 0 };
        this.evmReplaced = 0;
        this.evmGapped = 0;
        this.startTime = null;
        this.endTime = null;

        /** @type {MetricsAnalyzer|null} */
        this.metricsAnalyzer = null;
    }

    async initMetrics() {
        this.metricsAnalyzer = new MetricsAnalyzer();
        await this.metricsAnalyzer.initialize();
    }

    recordEvm(success, txHash = null, error = null) {
        this.evm.total++;
        if (success) {
            this.evm.successful++;
            if (this.metricsAnalyzer) this.metricsAnalyzer.recordTransaction(txHash, true);
        } else {
            this.evm.failed++;
            if (this.metricsAnalyzer) this.metricsAnalyzer.recordTransaction(null, false, error);
        }
    }

    recordCosmos(success, txHash = null) {
        this.cosmos.total++;
        if (success) this.cosmos.successful++;
        else this.cosmos.failed++;
    }

    start() {
        this.startTime = Date.now();
    }

    stop() {
        this.endTime = Date.now();
    }

    printReport() {
        const duration = (this.endTime - this.startTime) / 1000;
        const totalTxs = this.evm.total + this.cosmos.total;
        const totalSuccess = this.evm.successful + this.cosmos.successful;

        console.log('\n' + '='.repeat(60));
        console.log('           BLOCKCHAIN SPAMMER RESULTS');
        console.log('='.repeat(60));
        console.log(`Duration: ${duration.toFixed(2)}s`);
        console.log(`Total Transactions: ${totalTxs}`);
        console.log(`Combined Success Rate: ${totalTxs > 0 ? ((totalSuccess / totalTxs) * 100).toFixed(2) : 0}%`);
        console.log(`Combined TPS: ${(totalTxs / duration).toFixed(2)}`);

        if (this.evm.total > 0) {
            console.log('\n--- EVM ---');
            console.log(`  Total: ${this.evm.total}  Successful: ${this.evm.successful}  Failed: ${this.evm.failed}`);
            console.log(`  Success Rate: ${((this.evm.successful / this.evm.total) * 100).toFixed(2)}%`);
            console.log(`  TPS: ${(this.evm.total / duration).toFixed(2)}`);
            if (this.evmReplaced > 0) console.log(`  Replaced: ${this.evmReplaced}`);
            if (this.evmGapped > 0) console.log(`  Gapped: ${this.evmGapped}`);
        }

        if (this.cosmos.total > 0) {
            console.log('\n--- Cosmos ---');
            console.log(`  Total: ${this.cosmos.total}  Successful: ${this.cosmos.successful}  Failed: ${this.cosmos.failed}`);
            console.log(`  Success Rate: ${((this.cosmos.successful / this.cosmos.total) * 100).toFixed(2)}%`);
            console.log(`  TPS: ${(this.cosmos.total / duration).toFixed(2)}`);
        }

        console.log('='.repeat(60));
    }

    async generateMetricsReport() {
        if (!this.metricsAnalyzer) return;

        try {
            this.metricsAnalyzer.metrics.totalTransactions = this.evm.total + this.cosmos.total;
            this.metricsAnalyzer.metrics.successfulTransactions = this.evm.successful + this.cosmos.successful;
            this.metricsAnalyzer.metrics.failedTransactions = this.evm.failed + this.cosmos.failed;
            this.metricsAnalyzer.metrics.startTime = this.startTime;
            this.metricsAnalyzer.metrics.endTime = this.endTime;

            await this.metricsAnalyzer.analyzeBlocks();
            this.metricsAnalyzer.generateReport();

            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            this.metricsAnalyzer.saveDetailedReport(`detailed-metrics-${timestamp}.json`);
        } catch (err) {
            console.error('Metrics report generation failed:', err.message);
        }
    }
}

// ---------------------------------------------------------------------------
// SpamOrchestrator - mode dispatch, scheduling, block-aware rate limiting
// ---------------------------------------------------------------------------
class SpamOrchestrator {
    /**
     * @param {object} opts
     * @param {WalletManager} opts.walletManager
     * @param {EvmTransactionEngine} opts.evmEngine
     * @param {CosmosTransactionEngine} opts.cosmosEngine
     * @param {MempoolManager} opts.mempoolManager
     * @param {StatsCollector} opts.stats
     * @param {object} opts.config - parsed config from CLI / wizard
     */
    constructor({ walletManager, evmEngine, cosmosEngine, mempoolManager, stats, config }) {
        this.walletManager = walletManager;
        this.evmEngine = evmEngine;
        this.cosmosEngine = cosmosEngine;
        this.mempoolManager = mempoolManager;
        this.stats = stats;
        this.config = config;
        this.dashboardProcess = null;
        this.logCapture = null;
        this.stopMempoolMonitor = null;
    }

    /** Launch mempool-dashboard.js as a subprocess. */
    launchDashboard() {
        try {
            this.dashboardProcess = spawn('node', ['tools/mempool-dashboard.js'], { stdio: 'inherit' });
            this.dashboardProcess.on('error', (err) => {
                console.error(`Dashboard failed to start: ${err.message}`);
            });
            console.log('Mempool dashboard launched');
        } catch (err) {
            console.error(`Failed to launch dashboard: ${err.message}`);
        }
    }

    /** Enable log deduplication (from multi-chain-diverse-spam). */
    enableLogCapture() {
        const spamLogs = {};
        const origLog = console.log;
        const origError = console.error;

        const capture = (prefix, args) => {
            const msg = `${prefix}${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
            spamLogs[msg] = (spamLogs[msg] || 0) + 1;
        };

        console.log = (...args) => capture('', args);
        console.error = (...args) => capture('[error] ', args);

        this.logCapture = { spamLogs, origLog, origError };
    }

    /** Restore original console and print deduped summary. */
    disableLogCapture() {
        if (!this.logCapture) return;
        console.log = this.logCapture.origLog;
        console.error = this.logCapture.origError;

        if (Object.keys(this.logCapture.spamLogs).length > 0) {
            console.log('\nSpammer log summary (deduped):');
            for (const [msg, count] of Object.entries(this.logCapture.spamLogs)) {
                console.log(`[${count}x] ${msg}`);
            }
        }
        this.logCapture = null;
    }

    /** Run the selected spam mode. */
    async run() {
        const cfg = this.config;
        const chains = cfg.chains;
        const mode = cfg.mode;
        const duration = cfg.duration;
        const evmTps = cfg.evmTps;
        const cosmosTps = cfg.cosmosTps;

        // Dashboard
        if (cfg.dashboard) {
            this.launchDashboard();
            if (!cfg.verbose) {
                this.enableLogCapture();
            }
        }

        // Start mempool monitoring
        if (this.stats.metricsAnalyzer) {
            this.stopMempoolMonitor = await this.stats.metricsAnalyzer.startMempoolMonitoring(3000);
        }

        this.stats.start();

        try {
            if (chains === 'evm') {
                await this._runEvmOnly(mode, duration, evmTps);
            } else if (chains === 'cosmos') {
                await this._runCosmosOnly(mode, duration, cosmosTps);
            } else {
                // Both chains
                await this._runDualChain(mode, duration, evmTps, cosmosTps);
            }
        } finally {
            this.stats.stop();

            if (this.stopMempoolMonitor) this.stopMempoolMonitor();
            if (cfg.mempoolCleanup) {
                console.log('Final mempool cleanup...');
                await this.mempoolManager.inspectAndClear();
            }

            this.disableLogCapture();

            if (this.dashboardProcess && !this.dashboardProcess.killed) {
                this.dashboardProcess.kill();
            }

            this.stats.printReport();
            await this.stats.generateMetricsReport();
        }
    }

    /** EVM-only spam. */
    async _runEvmOnly(mode, duration, tps) {
        const interval = 1000 / tps;
        const endTime = Date.now() + duration * 1000;

        console.log(`\nStarting EVM spam: mode=${mode}, TPS=${tps}, duration=${duration}s`);

        while (Date.now() < endTime) {
            const wallet = this.walletManager.getRandomWallet();

            switch (mode) {
                case 'eth': {
                    const to = this.walletManager.getRandomWallet();
                    if (to !== wallet) {
                        await this.evmEngine.sendEthTransfer(wallet, to.evmAddress, ethers.parseEther((Math.random() * 0.0001).toFixed(8)));
                    }
                    break;
                }
                case 'erc20':
                case 'counter':
                case 'storage':
                    await this.evmEngine._performContractOp(wallet, mode);
                    break;
                case 'mixed':
                    await this.evmEngine.performRandomOperation(wallet);
                    break;
                case 'concurrent':
                    // Fire multiple wallets in parallel
                    await Promise.allSettled(
                        this.walletManager.wallets.map((w) => this.evmEngine.performRandomOperation(w))
                    );
                    break;
                default:
                    await this.evmEngine.performRandomOperation(wallet);
            }

            await sleep(interval);
        }
    }

    /** Cosmos-only spam. */
    async _runCosmosOnly(mode, duration, tps) {
        const interval = 1000 / tps;
        const endTime = Date.now() + duration * 1000;
        const validators = mode === 'staking' || mode === 'mixed' ? await this.cosmosEngine.getValidators() : [];

        console.log(`\nStarting Cosmos spam: mode=${mode}, TPS=${tps}, duration=${duration}s`);

        while (Date.now() < endTime) {
            const wallet = this.walletManager.getRandomWallet();

            switch (mode) {
                case 'bank': {
                    const to = this.walletManager.getRandomWallet();
                    if (to !== wallet) {
                        await this.cosmosEngine.sendBankSend(wallet, to.cosmosAddress, Math.floor(Math.random() * 1000) + 1);
                    }
                    break;
                }
                case 'staking': {
                    if (validators.length > 0) {
                        const val = validators[Math.floor(Math.random() * validators.length)];
                        const op = Math.random() > 0.7 ? 'undelegate' : 'delegate';
                        const amt = Math.floor(Math.random() * 100000) + 10000;
                        if (op === 'delegate') await this.cosmosEngine.delegateToValidator(wallet, val, amt);
                        else await this.cosmosEngine.undelegateFromValidator(wallet, val, amt);
                    }
                    break;
                }
                case 'mixed':
                    await this.cosmosEngine.performRandomOperation(wallet, validators);
                    break;
                default:
                    await this.cosmosEngine.performRandomOperation(wallet, validators);
            }

            await sleep(interval);
        }
    }

    /** Dual-chain spam with multiple modes. */
    async _runDualChain(mode, duration, evmTps, cosmosTps) {
        const validators = await this.cosmosEngine.getValidators();

        switch (mode) {
            case 'sequential':
                await this._runDualSequential(duration, evmTps + cosmosTps);
                break;
            case 'burst':
                await this._runDualBurst(duration, evmTps);
                break;
            case 'unified':
                await this._runUnifiedDual(duration, evmTps, cosmosTps);
                break;
            case 'advanced':
                await this._runAdvanced(duration, evmTps, cosmosTps);
                break;
            default:
                // mixed: run both chains concurrently
                await this._runDualMixed(duration, evmTps, cosmosTps, validators);
        }
    }

    /** Mixed: independent EVM and Cosmos loops running concurrently. */
    async _runDualMixed(duration, evmTps, cosmosTps, validators) {
        console.log(`\nStarting dual-chain mixed spam: EVM ${evmTps} TPS + Cosmos ${cosmosTps} TPS for ${duration}s`);

        const endTime = Date.now() + duration * 1000;
        const evmInterval = 1000 / evmTps;
        const cosmosInterval = 1000 / cosmosTps;

        const evmLoop = async () => {
            while (Date.now() < endTime) {
                const wallet = this.walletManager.getRandomWallet();
                await this.evmEngine.performRandomOperation(wallet);
                await sleep(evmInterval);
            }
        };

        const cosmosLoop = async () => {
            while (Date.now() < endTime) {
                const wallet = this.walletManager.getRandomWallet();
                await this.cosmosEngine.performRandomOperation(wallet, validators);
                await sleep(cosmosInterval);
            }
        };

        const mempoolLoop = async () => {
            while (Date.now() < endTime) {
                await sleep(10000);
                await this.mempoolManager.gentleCleanup();
            }
        };

        await Promise.all([evmLoop(), cosmosLoop(), mempoolLoop()]);
    }

    /** Sequential: alternate EVM and Cosmos from same accounts. */
    async _runDualSequential(duration, tps) {
        console.log(`\nStarting dual-chain sequential spam: ${tps} TPS for ${duration}s`);

        const interval = 1000 / tps;
        const endTime = Date.now() + duration * 1000;
        let count = 0;

        while (Date.now() < endTime) {
            const wallet = this.walletManager.getRandomWallet();
            const target = this.walletManager.getRandomWallet();
            if (wallet === target) continue;

            if (count % 2 === 0) {
                // EVM
                if (this.evmEngine.contracts.counter) {
                    const data = this.evmEngine.generateCounterIncrementData(Math.floor(Math.random() * 5) + 1);
                    await this.evmEngine.sendContractCall(wallet, this.evmEngine.contracts.counter, data);
                } else {
                    await this.evmEngine.sendEthTransfer(wallet, target.evmAddress, ethers.parseEther((Math.random() * 0.001).toFixed(6)));
                }
            } else {
                // Cosmos
                await this.cosmosEngine.sendBankSend(wallet, target.cosmosAddress, Math.floor(Math.random() * 1000000) + 100000);
            }

            count++;
            await sleep(interval);
        }
    }

    /** Burst: paired EVM+Cosmos transactions from same account. */
    async _runDualBurst(duration, tps) {
        console.log(`\nStarting dual-chain burst spam: ${tps} burst pairs/s for ${duration}s`);

        const interval = (1000 / tps) * 2; // account for 2 txs per burst
        const endTime = Date.now() + duration * 1000;

        while (Date.now() < endTime) {
            const wallet = this.walletManager.getRandomWallet();
            const target = this.walletManager.getRandomWallet();
            if (wallet === target) continue;

            // EVM first
            await this.evmEngine.sendEthTransfer(wallet, target.evmAddress, ethers.parseEther((Math.random() * 0.001).toFixed(6)));
            await sleep(50);
            // Cosmos immediately after
            await this.cosmosEngine.sendBankSend(wallet, target.cosmosAddress, Math.floor(Math.random() * 1000000) + 100000);

            await sleep(interval);
        }
    }

    /** Unified dual: time-interval based dispatching with shared sequence. */
    async _runUnifiedDual(duration, evmTps, cosmosTps) {
        console.log(`\nStarting unified dual-chain spam: EVM ${evmTps} TPS + Cosmos ${cosmosTps} TPS for ${duration}s`);

        const endTime = Date.now() + duration * 1000;
        const evmInterval = 1000 / evmTps;
        const cosmosInterval = 1000 / cosmosTps;
        let lastEvmTx = 0;
        let lastCosmosTx = 0;

        while (Date.now() < endTime) {
            const now = Date.now();
            const wallet = this.walletManager.getRandomWallet();

            if (now - lastEvmTx >= evmInterval) {
                const txType = Math.random() > 0.3 ? 'contract' : 'eth_transfer';
                if (txType === 'eth_transfer') {
                    const to = this.walletManager.getRandomWallet();
                    if (to !== wallet) {
                        await this.evmEngine.sendEthTransfer(wallet, to.evmAddress, ethers.parseEther((Math.random() * 0.001).toFixed(6)));
                    }
                } else if (this.evmEngine.contracts.counter) {
                    const data = this.evmEngine.generateCounterIncrementData(Math.floor(Math.random() * 5) + 1);
                    await this.evmEngine.sendContractCall(wallet, this.evmEngine.contracts.counter, data);
                }
                lastEvmTx = now;
            }

            if (now - lastCosmosTx >= cosmosInterval) {
                const to = this.walletManager.getRandomWallet();
                if (to !== wallet) {
                    await this.cosmosEngine.sendBankSend(wallet, to.cosmosAddress, Math.floor(Math.random() * 1000000) + 100000);
                }
                lastCosmosTx = now;
            }

            await sleep(50);
        }
    }

    /** Advanced: concurrent batch processing with nonce gaps, replacement, mempool cleanup. */
    async _runAdvanced(duration, evmTps, cosmosTps) {
        console.log(`\nStarting advanced dual-chain spam: EVM ${evmTps} TPS + Cosmos ${cosmosTps} TPS for ${duration}s`);
        console.log('Features: block-aware, nonce gaps, tx replacement, mempool cleanup\n');

        const endTime = Date.now() + duration * 1000;
        let lastBlockUpdate = 0;

        const evmLoop = async () => {
            while (Date.now() < endTime) {
                const now = Date.now();
                if (now - lastBlockUpdate >= 1000) {
                    await this.evmEngine.updateCurrentBlock();
                    lastBlockUpdate = now;
                }

                const batchSize = Math.min(50, Math.floor(evmTps / 5));
                const batch = [];

                for (let i = 0; i < batchSize; i++) {
                    const wallet = this.walletManager.getRandomWallet();
                    if (this.evmEngine.canWalletSendTx(wallet.index)) {
                        const type = Math.random() > 0.3 ? 'contract' : 'eth_transfer';
                        batch.push(
                            this.evmEngine.sendAdvancedTransaction(wallet, { transactionType: type }).then((result) => {
                                if (result) this.evmEngine.recordWalletTx(wallet.index);
                            })
                        );
                    }
                }

                if (batch.length > 0) await Promise.allSettled(batch);
                await sleep(200);
            }
        };

        const cosmosLoop = async () => {
            const validators = await this.cosmosEngine.getValidators();
            while (Date.now() < endTime) {
                const batchSize = Math.min(25, Math.floor(cosmosTps / 4));
                const batch = [];

                for (let i = 0; i < batchSize; i++) {
                    const wallet = this.walletManager.getRandomWallet();
                    batch.push(this.cosmosEngine.performRandomOperation(wallet, validators));
                }

                if (batch.length > 0) await Promise.allSettled(batch);
                await sleep(250);
            }
        };

        const mempoolLoop = async () => {
            while (Date.now() < endTime) {
                await sleep(10000);
                await this.mempoolManager.gentleCleanup();
            }
        };

        await Promise.all([evmLoop(), cosmosLoop(), mempoolLoop()]);
    }
}

// ---------------------------------------------------------------------------
// InteractiveSetup - readline prompts to build config
// ---------------------------------------------------------------------------
class InteractiveSetup {
    constructor() {
        this.rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    }

    /** @private */
    ask(question, defaultValue = '') {
        const suffix = defaultValue ? ` [${defaultValue}]` : '';
        return new Promise((resolve) => {
            this.rl.question(`${question}${suffix}: `, (answer) => {
                resolve(answer.trim() || defaultValue);
            });
        });
    }

    /** @private */
    async askChoice(question, options) {
        console.log(`\n${question}`);
        options.forEach((opt, i) => console.log(`  ${i + 1}. ${opt}`));
        const answer = await this.ask('Choice', '1');
        const idx = parseInt(answer, 10) - 1;
        return options[Math.max(0, Math.min(idx, options.length - 1))];
    }

    /**
     * Run the full interactive wizard and return a config object.
     * @returns {Promise<object>}
     */
    async run() {
        console.log('\n=== Blockchain Spammer Setup ===\n');

        // [1] Endpoints
        console.log('[1] Endpoints');
        const evmRpc = await this.ask('    EVM RPC URL', process.env.RPC_URL || 'http://localhost:8545');
        const cosmosRpc = await this.ask('    Cosmos RPC URL', process.env.COSMOS_RPC_URL || 'http://localhost:26657');
        const cosmosRest = await this.ask('    Cosmos REST URL', process.env.COSMOS_REST_URL || 'http://localhost:1317');

        // [2] Chain config
        console.log('\n[2] Chain Config');
        const evmChainId = parseInt(await this.ask('    EVM Chain ID', process.env.EVM_CHAIN_ID || '262144'), 10);
        const cosmosChainId = await this.ask('    Cosmos Chain ID', process.env.COSMOS_CHAIN_ID || '9001');
        const cosmosDenom = await this.ask('    Cosmos denom', process.env.COSMOS_DENOM || 'atest');
        const cosmosPrefix = await this.ask('    Cosmos address prefix', process.env.COSMOS_PREFIX || 'evmd');

        // [3] Key loading
        console.log('\n[3] Key Loading');
        const keySource = await this.askChoice('    Load wallet keys from:', [
            '.env file (PRIVATE_KEY*, MNEMONIC*)',
            'JSON key file',
            'Enter keys manually',
        ]);

        let keys;
        if (keySource.startsWith('.env')) {
            keys = KeyLoader.loadFromEnv();
        } else if (keySource.startsWith('JSON')) {
            const keyFile = await this.ask('    Path to key file');
            keys = KeyLoader.loadFromJsonFile(keyFile);
        } else {
            keys = await KeyLoader.loadInteractive(this.rl);
        }

        // [4] Chain selection
        console.log('\n[4] Chain Selection');
        const chainChoice = await this.askChoice('    Which chains?', ['EVM only', 'Cosmos only', 'Both']);
        const chains = chainChoice.startsWith('EVM') ? 'evm' : chainChoice.startsWith('Cosmos') ? 'cosmos' : 'both';

        // [5] Transaction types
        let mode = 'mixed';
        if (chains === 'evm' || chains === 'both') {
            console.log('\n[5] EVM Transaction Types');
            mode = (
                await this.askChoice('    EVM mode:', ['mixed', 'eth', 'erc20', 'counter', 'storage', 'concurrent'])
            );
        }
        if (chains === 'cosmos') {
            console.log('\n[5] Cosmos Transaction Types');
            mode = (await this.askChoice('    Cosmos mode:', ['mixed', 'bank', 'staking']));
        }

        // [6] Spam mode (if both chains)
        if (chains === 'both') {
            console.log('\n[6] Dual-Chain Spam Mode');
            mode = (
                await this.askChoice('    Mode:', ['mixed', 'sequential', 'burst', 'unified', 'advanced'])
            );
        }

        // [7] Performance
        console.log('\n[7] Performance');
        const evmTps = parseInt(await this.ask('    EVM TPS', '10'), 10);
        const cosmosTps = parseInt(await this.ask('    Cosmos TPS', '5'), 10);
        const duration = parseInt(await this.ask('    Duration (seconds)', '60'), 10);

        // [8] Deploy contracts
        console.log('\n[8] Contract Deployment');
        const deploy = (await this.ask('    Deploy contracts? (y/N)', 'N')).toLowerCase() === 'y';

        // [9] Advanced options
        console.log('\n[9] Advanced Options');
        const advancedYn = (await this.ask('    Enable advanced options? (y/N)', 'N')).toLowerCase() === 'y';
        let blockAware = false;
        let nonceGaps = false;
        let txReplacement = false;
        let mempoolCleanup = false;
        let autoFund = false;

        if (advancedYn) {
            blockAware = (await this.ask('    Block-aware rate limiting? (y/N)', 'N')).toLowerCase() === 'y';
            nonceGaps = (await this.ask('    Create nonce gaps? (y/N)', 'N')).toLowerCase() === 'y';
            txReplacement = (await this.ask('    Enable tx replacement? (y/N)', 'N')).toLowerCase() === 'y';
            mempoolCleanup = (await this.ask('    Mempool cleanup on exit? (Y/n)', 'Y')).toLowerCase() !== 'n';
            autoFund = (await this.ask('    Auto-fund wallets? (y/N)', 'N')).toLowerCase() === 'y';
        }

        // [10] Dashboard
        console.log('\n[10] Dashboard');
        const dashboard = (await this.ask('    Launch mempool dashboard? (Y/n)', 'Y')).toLowerCase() !== 'n';

        this.rl.close();

        const config = {
            evmRpc,
            cosmosRpc,
            cosmosRest,
            evmChainId,
            cosmosChainId,
            cosmosDenom,
            cosmosPrefix,
            keys,
            chains,
            mode,
            evmTps,
            cosmosTps,
            duration,
            deploy,
            blockAware,
            nonceGaps,
            txReplacement,
            mempoolCleanup,
            autoFund,
            dashboard,
            verbose: false,
            quiet: false,
        };

        // Summary
        console.log('\n=== Config Summary ===');
        console.log(`  Chains: ${chains}`);
        console.log(`  Mode: ${mode}`);
        console.log(`  EVM TPS: ${evmTps}  Cosmos TPS: ${cosmosTps}`);
        console.log(`  Duration: ${duration}s`);
        console.log(`  Wallets: ${keys.privateKeys.length}`);
        console.log(`  Deploy: ${deploy}  Dashboard: ${dashboard}`);
        console.log(`  Advanced: blockAware=${blockAware} nonceGaps=${nonceGaps} txReplacement=${txReplacement}`);
        console.log('');

        const proceed = (await new Promise((resolve) => {
            const confirmRl = readline.createInterface({ input: process.stdin, output: process.stdout });
            confirmRl.question('Proceed? (Y/n): ', (answer) => {
                confirmRl.close();
                resolve(answer.trim());
            });
        }));

        if (proceed.toLowerCase() === 'n') {
            console.log('Aborted.');
            process.exit(0);
        }

        return config;
    }
}

// ---------------------------------------------------------------------------
// CliParser - --flag parsing for non-interactive/automation mode
// ---------------------------------------------------------------------------
class CliParser {
    /**
     * Parse process.argv into a config object.
     * @returns {object|null} null if --help or --interactive
     */
    static parse() {
        const args = process.argv.slice(2);

        if (args.includes('--help') || args.includes('-h')) {
            CliParser.printUsage();
            process.exit(0);
        }

        if (args.length === 0 || args.includes('--interactive')) {
            return null; // signal: run interactive wizard
        }

        const get = (name, fallback) => {
            const arg = args.find((a) => a.startsWith(`--${name}=`));
            return arg ? arg.split('=').slice(1).join('=') : fallback;
        };
        const has = (name) => args.includes(`--${name}`);

        const keySource = get('keys', 'env');
        let keys;
        if (keySource === 'json') {
            const keyFile = get('key-file', 'keys.json');
            keys = KeyLoader.loadFromJsonFile(keyFile);
        } else {
            keys = KeyLoader.loadFromEnv();
        }

        return {
            evmRpc: get('evm-rpc', process.env.RPC_URL || 'http://localhost:8545'),
            cosmosRpc: get('cosmos-rpc', process.env.COSMOS_RPC_URL || 'http://localhost:26657'),
            cosmosRest: get('cosmos-rest', process.env.COSMOS_REST_URL || 'http://localhost:1317'),
            evmChainId: parseInt(get('evm-chain-id', process.env.EVM_CHAIN_ID || '262144'), 10),
            cosmosChainId: get('cosmos-chain-id', process.env.COSMOS_CHAIN_ID || '9001'),
            cosmosDenom: get('cosmos-denom', process.env.COSMOS_DENOM || 'atest'),
            cosmosPrefix: get('cosmos-prefix', process.env.COSMOS_PREFIX || 'evmd'),
            keys,
            chains: get('chains', 'both'),
            mode: get('mode', 'mixed'),
            evmTps: parseInt(get('evm-tps', get('tps', '10')), 10),
            cosmosTps: parseInt(get('cosmos-tps', get('tps', '5')), 10),
            duration: parseInt(get('duration', '60'), 10),
            deploy: has('deploy'),
            blockAware: has('block-aware') || has('advanced'),
            nonceGaps: has('nonce-gaps') || has('advanced'),
            txReplacement: has('tx-replacement') || has('advanced'),
            mempoolCleanup: has('mempool-cleanup') || has('advanced'),
            autoFund: has('auto-fund'),
            dashboard: has('dashboard') && !has('no-dashboard'),
            verbose: has('verbose'),
            quiet: has('quiet'),
        };
    }

    static printUsage() {
        console.log(`
Usage: node blockchain-spammer.js [OPTIONS]

  --interactive           Launch setup wizard (default when no args)
  --chains=<evm|cosmos|both>
  --mode=<eth|erc20|counter|storage|mixed|concurrent|bank|staking|
          sequential|burst|unified|advanced>

  --evm-rpc=<URL>         EVM RPC endpoint
  --cosmos-rpc=<URL>      Cosmos RPC endpoint
  --cosmos-rest=<URL>     Cosmos REST endpoint
  --evm-chain-id=<N>      EVM chain ID (default: 262144)
  --cosmos-chain-id=<ID>  Cosmos chain ID (default: 9001)
  --cosmos-denom=<DENOM>  Cosmos denomination (default: atest)
  --cosmos-prefix=<PFX>   Cosmos address prefix (default: evmd)

  --keys=<env|json>       Key source (default: env)
  --key-file=<PATH>       Path to JSON key file (when --keys=json)

  --tps=<N>               Target TPS (applied to both chains if specific not set)
  --evm-tps=<N>           EVM target TPS
  --cosmos-tps=<N>        Cosmos target TPS
  --duration=<SECONDS>    Spam duration in seconds

  --deploy                Deploy test contracts before spamming
  --dashboard             Launch mempool-dashboard.js
  --no-dashboard          Suppress dashboard

  --block-aware           Enable block-aware rate limiting
  --nonce-gaps            Enable nonce gap creation
  --tx-replacement        Enable stuck tx replacement
  --mempool-cleanup       Enable mempool cleanup on exit
  --auto-fund             Auto-fund wallets from richest wallet
  --advanced              Enable all advanced features

  --verbose               Verbose logging
  --quiet                 Minimal logging
`);
    }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// main()
// ---------------------------------------------------------------------------
async function main() {
    // Parse CLI args or launch interactive wizard
    let config = CliParser.parse();

    if (!config) {
        const wizard = new InteractiveSetup();
        config = await wizard.run();
    }

    console.log('\n--- Blockchain Spammer ---');
    console.log(`Chains: ${config.chains}  Mode: ${config.mode}  Duration: ${config.duration}s`);

    // Initialize provider
    const evmProvider = new ethers.JsonRpcProvider(config.evmRpc);

    // Wallet manager
    const walletManager = new WalletManager({
        privateKeys: config.keys.privateKeys,
        evmProvider,
        cosmosRpcUrl: config.cosmosRpc,
        cosmosPrefix: config.cosmosPrefix,
        cosmosDenom: config.cosmosDenom,
        evmChainId: config.evmChainId,
    });

    const initCosmos = config.chains === 'cosmos' || config.chains === 'both';
    await walletManager.initialize({ initCosmos });
    await walletManager.initNonces();

    // Contract deployer
    const contractDeployer = new ContractDeployer(evmProvider);
    contractDeployer.loadFromEnv();

    if (config.deploy) {
        await contractDeployer.deployAll(walletManager.wallets);
    }

    if (config.chains === 'evm' || config.chains === 'both') {
        await contractDeployer.validateContracts();
    }

    // Auto-fund
    if (config.autoFund) {
        await walletManager.autoFundWallets();
    }

    // Stats
    const stats = new StatsCollector();
    await stats.initMetrics();

    // Engines
    const evmEngine = new EvmTransactionEngine({
        provider: evmProvider,
        chainId: config.evmChainId,
        contracts: contractDeployer.contracts,
        stats,
        walletManager,
    });

    const cosmosEngine = new CosmosTransactionEngine({
        rpcUrl: config.cosmosRpc,
        restUrl: config.cosmosRest,
        chainId: config.cosmosChainId,
        denom: config.cosmosDenom,
        prefix: config.cosmosPrefix,
        stats,
        walletManager,
    });

    // Mempool manager
    const mempoolManager = new MempoolManager(evmProvider, walletManager.wallets);

    // Orchestrator
    const orchestrator = new SpamOrchestrator({
        walletManager,
        evmEngine,
        cosmosEngine,
        mempoolManager,
        stats,
        config,
    });

    // Graceful shutdown via SIGINT
    let shuttingDown = false;
    process.on('SIGINT', () => {
        if (shuttingDown) process.exit(1);
        shuttingDown = true;
        console.log('\nSIGINT received - finishing current transactions...');
        // Force stop after allowing current iteration to finish
        stats.stop();
        stats.printReport();
        stats.generateMetricsReport().then(() => process.exit(0)).catch(() => process.exit(1));
    });

    await orchestrator.run();
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch((err) => {
        console.error('Fatal error:', err);
        process.exit(1);
    });
}

export {
    SecureKeyManager,
    KeyLoader,
    UnifiedWallet,
    WalletManager,
    ContractDeployer,
    EvmTransactionEngine,
    CosmosTransactionEngine,
    MempoolManager,
    StatsCollector,
    SpamOrchestrator,
    InteractiveSetup,
    CliParser,
};
