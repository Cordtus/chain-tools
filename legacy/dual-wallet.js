import { ethers } from 'ethers';
import { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import { SigningStargateClient } from '@cosmjs/stargate';
import dotenv from 'dotenv';

dotenv.config();

/**
 * Unified wallet that can perform both EVM and Cosmos transactions
 * using the same private key/mnemonic
 */
class DualWallet {
    constructor(index, mnemonic, evmProvider, cosmosRpcUrl, fundingKeys = null) {
        this.index = index;
        this.mnemonic = mnemonic;
        this.evmProvider = evmProvider;
        this.cosmosRpcUrl = cosmosRpcUrl;
        this.fundingKeys = fundingKeys; // Array of dev wallet private keys for funding
        
        // Will be initialized later
        this.evmWallet = null;
        this.cosmosWallet = null;
        this.cosmosClient = null;
        this.evmAddress = null;
        this.cosmosAddress = null;
        
        // Dev wallet addresses for reference
        this.devAddresses = {
            cosmos: [
                'cosmos1cml96vmptgw99syqrrz8az79xer2pcgp95srxm',  // dev0
                'cosmos1jcltmuhplrdcwp7stlr4hlhlhgd4htqhnu0t2g',  // dev1
                'cosmos1gzsvk8rruqn2sx64acfsskrwy8hvrmafzhvvr0',  // dev2
                'cosmos1fx944mzagwdhx0wz7k9tfztc8g3lkfk6pzezqh'   // dev3
            ],
            evm: [
                '0xC6Fe5D33615a1C52c08018c47E8Bc53646A0E101',  // dev0 
                '0x963EBDf2e1f8DB8707D05FC75bfeFFBa1B5BaC17',  // dev1
                '0x40a0cb1C63e026A81B55EE1308586E21eec1eFa9',  // dev2
                '0x498B5AeC5D439b733dC2F58AB489783A23FB26dA'   // dev3
            ]
        };
    }
    
    async initialize() {
        // Initialize EVM wallet
        this.evmWallet = ethers.Wallet.fromPhrase(this.mnemonic, this.evmProvider);
        this.evmAddress = this.evmWallet.address;
        
        // Initialize Cosmos wallet from same mnemonic
        this.cosmosWallet = await DirectSecp256k1HdWallet.fromMnemonic(this.mnemonic, {
            prefix: 'cosmos'
        });
        
        const [cosmosAccount] = await this.cosmosWallet.getAccounts();
        this.cosmosAddress = cosmosAccount.address;
        
        // Initialize Cosmos signing client
        this.cosmosClient = await SigningStargateClient.connectWithSigner(
            this.cosmosRpcUrl,
            this.cosmosWallet,
            { gasPrice: { denom: 'atest', amount: '25000000000' } }
        );
        
        console.log(`Dual Wallet ${this.index}:`);
        console.log(`  EVM: ${this.evmAddress}`);
        console.log(`  Cosmos: ${this.cosmosAddress}`);
        
        // Fund wallets if needed and funding keys are provided
        if (this.fundingKeys && this.index < this.fundingKeys.length) {
            await this.fundIfNeeded();
        }
        
        // Check final balances
        try {
            const evmBalance = await this.evmProvider.getBalance(this.evmAddress);
            console.log(`  EVM Balance: ${ethers.formatEther(evmBalance)} ETH`);
        } catch (error) {
            console.log(`  EVM Balance: Error - ${error.message}`);
        }
        
        try {
            const cosmosBalance = await this.cosmosClient.getBalance(this.cosmosAddress, 'atest');
            console.log(`  Cosmos Balance: ${cosmosBalance.amount} atest`);
        } catch (error) {
            console.log(`  Cosmos Balance: Error - ${error.message}`);
        }
    }
    
    async fundIfNeeded() {
        const fundingPrivateKey = this.fundingKeys[this.index];
        if (!fundingPrivateKey) return;
        
        // Check if this is already a dev wallet (no funding needed)
        if (this.evmAddress === this.devAddresses.evm[this.index] && 
            this.cosmosAddress === this.devAddresses.cosmos[this.index]) {
            console.log(`  Already a dev wallet, no funding needed`);
            return;
        }
        
        console.log(`  Funding wallet ${this.index} if needed...`);
        
        try {
            // Fund EVM wallet if needed
            const evmBalance = await this.evmProvider.getBalance(this.evmAddress);
            if (evmBalance < ethers.parseEther('0.1')) {
                console.log(`    Funding EVM address from dev${this.index}...`);
                const fundingWallet = new ethers.Wallet(fundingPrivateKey, this.evmProvider);
                
                const tx = {
                    to: this.evmAddress,
                    value: ethers.parseEther('1.0'), // Send 1 ETH
                    gasLimit: 21000,
                    gasPrice: await this.evmProvider.getGasPrice(),
                    nonce: await this.evmProvider.getTransactionCount(fundingWallet.address, 'pending')
                };
                
                const signedTx = await fundingWallet.signTransaction(tx);
                const txResponse = await this.evmProvider.broadcastTransaction(signedTx);
                console.log(`    EVM funding tx: ${txResponse.hash}`);
                await txResponse.wait(); // Wait for confirmation
            }
            
            // Fund Cosmos wallet if needed using the dev wallet's mnemonic from .env
            const cosmosBalance = await this.cosmosClient.getBalance(this.cosmosAddress, 'atest');
            if (cosmosBalance.amount === '0') {
                console.log(`    Funding Cosmos address from dev${this.index}...`);
                
                // Get actual dev wallet mnemonics that correspond to the funded addresses
                const devMnemonics = [
                    'clump speak segment reopen purity omit isolate arrest tribe change clarify floor bulb among business salad extra spring weather agent brave oppose still grass', // dev0
                    'extra scare melt bright payment ride bicycle insect damage umbrella cheap glass twin aerobic math often ensure rail copy camera rotate special level monkey', // dev1
                    'brown shrimp crawl what saddle weather shoot subway spare sad shoe poem vessel bleak weasel banner stove arch pyramid advance welcome truth solution devote', // dev2
                    'spot awake gravity trap engage receive soft oil minute frequent blame summer artwork input impact plunge clump glad hint exile battle follow potato afraid'  // dev3
                ];
                
                const devMnemonic = devMnemonics[this.index];
                if (devMnemonic) {
                    const fundingCosmosWallet = await DirectSecp256k1HdWallet.fromMnemonic(
                        devMnemonic, 
                        { prefix: 'cosmos' }
                    );
                    
                    const fundingCosmosClient = await SigningStargateClient.connectWithSigner(
                        this.cosmosRpcUrl,
                        fundingCosmosWallet,
                        { gasPrice: { denom: 'atest', amount: '25000000000' } }
                    );
                    
                    const sendMsg = {
                        typeUrl: '/cosmos.bank.v1beta1.MsgSend',
                        value: {
                            fromAddress: this.devAddresses.cosmos[this.index],
                            toAddress: this.cosmosAddress,
                            amount: [{ denom: 'atest', amount: '100000000000000000000' }] // 100 atest
                        }
                    };
                    
                    const fee = {
                        amount: [{ denom: 'atest', amount: '50000000000' }],
                        gas: '200000'
                    };
                    
                    const result = await fundingCosmosClient.signAndBroadcast(
                        this.devAddresses.cosmos[this.index],
                        [sendMsg],
                        fee
                    );
                    
                    if (result.code === 0) {
                        console.log(`    Cosmos funding tx: ${result.transactionHash}`);
                    } else {
                        console.error(`    Cosmos funding failed: ${result.rawLog}`);
                    }
                } else {
                    console.error(`    No dev mnemonic found for wallet ${this.index}`);
                }
            }
            
        } catch (error) {
            console.error(`  Funding failed: ${error.message}`);
        }
    }
    
    // EVM Transaction Methods
    async sendEvmTransfer(toAddress, amount) {
        try {
            const tx = {
                to: toAddress,
                value: amount,
                gasLimit: 21000,
                gasPrice: await this.evmProvider.getGasPrice(),
                nonce: await this.evmProvider.getTransactionCount(this.evmAddress, 'pending')
            };
            
            const signedTx = await this.evmWallet.signTransaction(tx);
            const txResponse = await this.evmProvider.broadcastTransaction(signedTx);
            
            console.log(`[${this.index}] EVM Transfer: ${amount} ETH -> ${toAddress} | ${txResponse.hash}`);
            return { success: true, hash: txResponse.hash, type: 'evm_transfer' };
        } catch (error) {
            console.error(`[${this.index}] EVM Transfer failed: ${error.message}`);
            return { success: false, error: error.message, type: 'evm_transfer' };
        }
    }
    
    async sendEvmContractCall(contractAddress, data, gasLimit = 100000) {
        try {
            const tx = {
                to: contractAddress,
                data: data,
                gasLimit: gasLimit,
                gasPrice: await this.evmProvider.getGasPrice(),
                nonce: await this.evmProvider.getTransactionCount(this.evmAddress, 'pending')
            };
            
            const signedTx = await this.evmWallet.signTransaction(tx);
            const txResponse = await this.evmProvider.broadcastTransaction(signedTx);
            
            console.log(`[${this.index}] EVM Contract: ${contractAddress} | ${txResponse.hash}`);
            return { success: true, hash: txResponse.hash, type: 'evm_contract' };
        } catch (error) {
            console.error(`[${this.index}] EVM Contract failed: ${error.message}`);
            return { success: false, error: error.message, type: 'evm_contract' };
        }
    }
    
    // Cosmos Transaction Methods
    async sendCosmosBankSend(toAddress, amount, denom = 'atest') {
        try {
            const sendMsg = {
                typeUrl: '/cosmos.bank.v1beta1.MsgSend',
                value: {
                    fromAddress: this.cosmosAddress,
                    toAddress: toAddress,
                    amount: [{ denom, amount: amount.toString() }]
                }
            };
            
            const fee = {
                amount: [{ denom: 'atest', amount: '50000000000' }],
                gas: '200000'
            };
            
            const result = await this.cosmosClient.signAndBroadcast(
                this.cosmosAddress,
                [sendMsg],
                fee,
                `Bank send ${amount}${denom}`
            );
            
            if (result.code === 0) {
                console.log(`[${this.index}] Cosmos Send: ${amount}${denom} -> ${toAddress} | ${result.transactionHash}`);
                return { success: true, hash: result.transactionHash, type: 'cosmos_send' };
            } else {
                console.error(`[${this.index}] Cosmos Send failed: ${result.rawLog}`);
                return { success: false, error: result.rawLog, type: 'cosmos_send' };
            }
        } catch (error) {
            console.error(`[${this.index}] Cosmos Send failed: ${error.message}`);
            return { success: false, error: error.message, type: 'cosmos_send' };
        }
    }
    
    // Mixed transaction sequences
    async performRandomTransaction(otherWallets, contracts) {
        const transactionTypes = [
            'evm_transfer',
            'evm_contract_erc20',
            'evm_contract_counter',
            'cosmos_send'
        ].filter(type => {
            // Filter based on availability
            if (type.startsWith('evm_contract') && !contracts[type.split('_')[2]]) return false;
            return true;
        });
        
        const selectedType = transactionTypes[Math.floor(Math.random() * transactionTypes.length)];
        const targetWallet = otherWallets[Math.floor(Math.random() * otherWallets.length)];
        
        switch (selectedType) {
            case 'evm_transfer':
                const ethAmount = ethers.parseEther((Math.random() * 0.001).toFixed(6));
                return await this.sendEvmTransfer(targetWallet.evmAddress, ethAmount);
                
            case 'evm_contract_erc20':
                const erc20Data = this.generateERC20TransferData(
                    targetWallet.evmAddress,
                    ethers.parseUnits('100', 18)
                );
                return await this.sendEvmContractCall(contracts.erc20, erc20Data);
                
            case 'evm_contract_counter':
                const counterData = this.generateCounterIncrementData(
                    Math.floor(Math.random() * 10) + 1
                );
                return await this.sendEvmContractCall(contracts.counter, counterData);
                
            case 'cosmos_send':
                const cosmosAmount = Math.floor(Math.random() * 1000000) + 100000;
                return await this.sendCosmosBankSend(targetWallet.cosmosAddress, cosmosAmount);
                
            default:
                return { success: false, error: 'Unknown transaction type', type: selectedType };
        }
    }
    
    // Contract data generation helpers
    generateERC20TransferData(toAddress, amount) {
        const iface = new ethers.Interface([
            "function transfer(address to, uint256 amount) returns (bool)"
        ]);
        return iface.encodeFunctionData("transfer", [toAddress, amount]);
    }
    
    generateCounterIncrementData(amount = 1) {
        const iface = new ethers.Interface([
            "function incrementBy(uint256 amount)"
        ]);
        return iface.encodeFunctionData("incrementBy", [amount]);
    }
}

export default DualWallet;