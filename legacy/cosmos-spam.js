import { StargateClient, SigningStargateClient } from '@cosmjs/stargate';
import { DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { Tendermint34Client } from '@cosmjs/tendermint-rpc';
import { coins } from '@cosmjs/stargate';
import { bech32 } from 'bech32';
import dotenv from 'dotenv';

dotenv.config();

class CosmosSpammer {
    constructor() {
        const {
            COSMOS_RPC_URL,
            COSMOS_REST_URL,
            COSMOS_CHAIN_ID,
            COSMOS_DENOM,
            COSMOS_PREFIX
        } = process.env;

        if (!COSMOS_RPC_URL || !COSMOS_REST_URL || !COSMOS_CHAIN_ID || !COSMOS_DENOM || !COSMOS_PREFIX) {
            throw new Error('COSMOS_RPC_URL, COSMOS_REST_URL, COSMOS_CHAIN_ID, COSMOS_DENOM, and COSMOS_PREFIX must be set in .env');
        }

        this.rpcUrl = COSMOS_RPC_URL;
        this.restUrl = COSMOS_REST_URL;
        this.chainId = COSMOS_CHAIN_ID;
        this.denom = COSMOS_DENOM;
        this.prefix = COSMOS_PREFIX;
        
        this.wallets = [];
        this.signingClients = [];
        
        this.stats = {
            totalTxs: 0,
            successfulTxs: 0,
            failedTxs: 0,
            startTime: null,
            endTime: null
        };
        
        console.log(`Initialized Cosmos Spammer`);
    }
    
    async initializeWallets() {
        console.log('Initializing Cosmos wallets using private keys from .env...');
        
        // Use private keys directly like the faucet does
        const privateKeys = [
            process.env.PRIVATE_KEY,
            process.env.PRIVATE_KEY_1, 
            process.env.PRIVATE_KEY_2,
            process.env.PRIVATE_KEY_3
        ].filter(Boolean);
        
        if (privateKeys.length === 0) {
            throw new Error('No private keys found in .env file');
        }
        
        for (let i = 0; i < privateKeys.length; i++) {
            try {
                // Convert hex private key to bytes
                const privateKeyHex = privateKeys[i].replace('0x', '');
                const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
                
                // For eth_secp256k1 keys: derive EVM address first, then convert to bech32
                // This matches what the faucet does for dual environment
                const evmWallet = new (await import('ethers')).Wallet(privateKeys[i]);
                const evmAddress = evmWallet.address;
                
                // Convert EVM address directly to cosmos bech32 (no ripemd160)
                const addressBytes = Buffer.from(evmAddress.replace('0x', ''), 'hex');
                const words = bech32.toWords(addressBytes);
                const cosmosAddress = bech32.encode(this.prefix, words);
                
                // Create wallet for signing
                const wallet = await DirectSecp256k1Wallet.fromKey(privateKeyBytes, this.prefix);
                
                const signingClient = await SigningStargateClient.connectWithSigner(
                    this.rpcUrl,
                    wallet,
                    { gasPrice: { denom: this.denom, amount: '25000000000' } }
                );
                
                this.wallets.push({
                    index: i,
                    wallet: wallet,
                    address: cosmosAddress,
                    signingClient: signingClient,
                    privateKey: privateKeys[i],
                    evmAddress: evmAddress
                });
                
                console.log(`Loaded Cosmos wallet ${i}: ${cosmosAddress} (EVM: ${evmAddress})`);
                
                try {
                    const balance = await signingClient.getBalance(cosmosAddress, this.denom);
                    console.log(`  Balance: ${balance.amount} ${this.denom}`);
                } catch (balanceError) {
                    console.log(`  Balance check failed: ${balanceError.message}`);
                }
                
            } catch (error) {
                console.error(`Failed to initialize wallet ${i}:`, error.message);
            }
        }
        
        console.log(`Initialized ${this.wallets.length} Cosmos wallets using DirectSecp256k1Wallet`);
    }
    
    getRandomWallet() {
        return this.wallets[Math.floor(Math.random() * this.wallets.length)];
    }
    
    getRandomAmount() {
        // Very small base-unit amounts to avoid draining limited balances
        return Math.floor(Math.random() * 1000) + 1;
    }
    
    async sendBankSend(fromWallet, toAddress, amount) {
        try {
            const sendMsg = {
                typeUrl: '/cosmos.bank.v1beta1.MsgSend',
                value: {
                    fromAddress: fromWallet.address,
                    toAddress: toAddress,
                    amount: coins(amount, this.denom)
                }
            };
            
            const fee = {
                amount: coins(50000000000, this.denom),
                gas: '200000'
            };
            
            const result = await fromWallet.signingClient.signAndBroadcast(
                fromWallet.address,
                [sendMsg],
                fee,
                `Bank send ${amount}${this.denom}`
            );
            
            if (result.code === 0) {
                console.log(`Bank send: ${fromWallet.address} -> ${toAddress} (${amount}${this.denom}) - ${result.transactionHash}`);
                this.stats.successfulTxs++;
                return result;
            } else {
                console.error(`Bank send failed: ${result.rawLog}`);
                this.stats.failedTxs++;
                return null;
            }
        } catch (error) {
            console.error(`Bank send error: ${error.message}`);
            this.stats.failedTxs++;
            return null;
        }
    }
    
    async delegateToValidator(wallet, validatorAddress, amount) {
        try {
            // Keep staking amounts modest to avoid draining balances
            const delegateMsg = {
                typeUrl: '/cosmos.staking.v1beta1.MsgDelegate',
                value: {
                    delegatorAddress: wallet.address,
                    validatorAddress: validatorAddress,
                    amount: {
                        denom: this.denom,
                        amount: amount.toString()
                    }
                }
            };
            
            const fee = {
                amount: coins(75000000000, this.denom),
                gas: '300000'
            };
            
            const result = await wallet.signingClient.signAndBroadcast(
                wallet.address,
                [delegateMsg],
                fee,
                `Delegate ${amount}${this.denom} to ${validatorAddress}`
            );
            
            if (result.code === 0) {
                console.log(`Delegate: ${wallet.address} -> ${validatorAddress} (${amount}${this.denom}) - ${result.transactionHash}`);
                this.stats.successfulTxs++;
                return result;
            } else {
                console.error(`Delegate failed: ${result.rawLog}`);
                this.stats.failedTxs++;
                return null;
            }
        } catch (error) {
            console.error(`Delegate error: ${error.message}`);
            this.stats.failedTxs++;
            return null;
        }
    }
    
    async undelegateFromValidator(wallet, validatorAddress, amount) {
        try {
            const undelegateMsg = {
                typeUrl: '/cosmos.staking.v1beta1.MsgUndelegate',
                value: {
                    delegatorAddress: wallet.address,
                    validatorAddress: validatorAddress,
                    amount: {
                        denom: this.denom,
                        amount: amount.toString()
                    }
                }
            };
            
            const fee = {
                amount: coins(75000000000, this.denom),
                gas: '300000'
            };
            
            const result = await wallet.signingClient.signAndBroadcast(
                wallet.address,
                [undelegateMsg],
                fee,
                `Undelegate ${amount}${this.denom} from ${validatorAddress}`
            );
            
            if (result.code === 0) {
                console.log(`Undelegate: ${wallet.address} <- ${validatorAddress} (${amount}${this.denom}) - ${result.transactionHash}`);
                this.stats.successfulTxs++;
                return result;
            } else {
                console.error(`Undelegate failed: ${result.rawLog}`);
                this.stats.failedTxs++;
                return null;
            }
        } catch (error) {
            console.error(`Undelegate error: ${error.message}`);
            this.stats.failedTxs++;
            return null;
        }
    }
    
    async getValidators() {
        try {
            const tmClient = await Tendermint34Client.connect(this.rpcUrl);
            const client = await StargateClient.create(tmClient);
            
            const validators = await client.staking.validators('BOND_STATUS_BONDED');
            const validatorAddresses = validators.validators.map(v => v.operatorAddress);
            
            console.log(`Found ${validatorAddresses.length} active validators`);
            return validatorAddresses;
        } catch (error) {
            console.error('Failed to get validators:', error.message);
            return ['evmdvaloper1c6fe5d33615a1c52c08018c47e8bc53646a0e101']; // Fallback to default
        }
    }
    
    async spamBankSends(duration, tps) {
        console.log(`\nStarting Cosmos bank send spam: ${tps} TPS for ${duration}s`);
        
        const interval = 1000 / tps;
        const endTime = Date.now() + (duration * 1000);
        
        while (Date.now() < endTime) {
            const fromWallet = this.getRandomWallet();
            const toWallet = this.getRandomWallet();
            
            if (fromWallet !== toWallet) {
                const amount = this.getRandomAmount();
                this.sendBankSend(fromWallet, toWallet.address, amount);
            }
            
            await this.sleep(interval);
        }
    }
    
    async spamStaking(duration, tps) {
        console.log(`\nStarting Cosmos staking spam: ${tps} TPS for ${duration}s`);
        
        const validators = await this.getValidators();
        if (validators.length === 0) {
            console.error('No validators found for staking');
            return;
        }
        
        const interval = 1000 / tps;
        const endTime = Date.now() + (duration * 1000);
        
        while (Date.now() < endTime) {
            const wallet = this.getRandomWallet();
            const validator = validators[Math.floor(Math.random() * validators.length)];
            
            const operation = Math.random() > 0.7 ? 'undelegate' : 'delegate';
            const amount = Math.floor(Math.random() * 100000) + 10000; // 0.01-0.1 evmos
            
            if (operation === 'delegate') {
                this.delegateToValidator(wallet, validator, amount);
            } else {
                this.undelegateFromValidator(wallet, validator, amount);
            }
            
            await this.sleep(interval);
        }
    }
    
    async spamMixedCosmos(duration, tps) {
        console.log(`\nStarting mixed Cosmos transaction spam: ${tps} TPS for ${duration}s`);
        
        const validators = await this.getValidators();
        
        const interval = 1000 / tps;
        const endTime = Date.now() + (duration * 1000);
        
        const operations = [
            { type: 'bank_send', weight: 70 },
            { type: 'delegate', weight: 20 },
            { type: 'undelegate', weight: 10 }
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
            
            switch (selectedOp.type) {
                case 'bank_send':
                    const toWallet = this.getRandomWallet();
                    if (wallet !== toWallet) {
                        const amount = this.getRandomAmount();
                        this.sendBankSend(wallet, toWallet.address, amount);
                    }
                    break;
                    
                case 'delegate':
                    if (validators.length > 0) {
                        const validator = validators[Math.floor(Math.random() * validators.length)];
                        const amount = Math.floor(Math.random() * 50000) + 10000;
                        this.delegateToValidator(wallet, validator, amount);
                    }
                    break;
                    
                case 'undelegate':
                    if (validators.length > 0) {
                        const validator = validators[Math.floor(Math.random() * validators.length)];
                        const amount = Math.floor(Math.random() * 30000) + 5000;
                        this.undelegateFromValidator(wallet, validator, amount);
                    }
                    break;
            }
            
            await this.sleep(interval);
        }
    }
    
    async concurrentCosmosSpam(duration, tpsPerWallet) {
        console.log(`\nStarting concurrent Cosmos spam: ${tpsPerWallet} TPS per wallet (${this.wallets.length} wallets)`);
        
        const promises = this.wallets.map(async (wallet, index) => {
            const interval = 1000 / tpsPerWallet;
            const endTime = Date.now() + (duration * 1000);
            
            while (Date.now() < endTime) {
                const targetWallet = this.getRandomWallet();
                if (wallet !== targetWallet) {
                    const amount = this.getRandomAmount();
                    this.sendBankSend(wallet, targetWallet.address, amount);
                }
                
                await this.sleep(interval + (index * 100)); // Slight offset per wallet
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
        
        console.log('\n=== Cosmos Spam Statistics ===');
        console.log(`Duration: ${duration / 1000}s`);
        console.log(`Total transactions: ${this.stats.totalTxs}`);
        console.log(`Successful: ${this.stats.successfulTxs}`);
        console.log(`Failed: ${this.stats.failedTxs}`);
        console.log(`Success rate: ${((this.stats.successfulTxs / this.stats.totalTxs) * 100).toFixed(2)}%`);
        console.log(`Average TPS: ${tps.toFixed(2)}`);
    }
    
    async run(mode = 'mixed', duration = 60, tps = 5) {
        await this.initializeWallets();
        
        if (this.wallets.length === 0) {
            console.error('No wallets initialized. Cannot proceed.');
            return;
        }
        
        this.stats.startTime = Date.now();
        this.stats.totalTxs = 0;
        this.stats.successfulTxs = 0;
        this.stats.failedTxs = 0;
        
        switch (mode) {
            case 'bank':
                await this.spamBankSends(duration, tps);
                break;
            case 'staking':
                await this.spamStaking(duration, tps);
                break;
            case 'mixed':
                await this.spamMixedCosmos(duration, tps);
                break;
            case 'concurrent':
                await this.concurrentCosmosSpam(duration, tps);
                break;
            default:
                console.error('Unknown mode:', mode);
                return;
        }
        
        this.stats.endTime = Date.now();
        this.stats.totalTxs = this.stats.successfulTxs + this.stats.failedTxs;
        
        this.printStats();
    }
}

async function main() {
    const args = process.argv.slice(2);
    const mode = args[0] || 'mixed';
    const duration = parseInt(args[1]) || 60;
    const tps = parseInt(args[2]) || 5;
    
    console.log(`Starting Cosmos spam test:`);
    console.log(`Mode: ${mode}`);
    console.log(`Duration: ${duration}s`);
    console.log(`TPS: ${tps}`);
    
    const spammer = new CosmosSpammer();
    await spammer.run(mode, duration, tps);
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export default CosmosSpammer;
