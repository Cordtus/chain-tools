import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import dotenv from 'dotenv';
import solc from 'solc';

dotenv.config();

const RPC_URL = process.env.RPC_URL;

if (!RPC_URL) {
    console.error('RPC_URL must be set in .env for contract deployment');
    process.exit(1);
}

const DEPLOYER_KEY_VARS = ['PRIVATE_KEY', 'PRIVATE_KEY_1', 'PRIVATE_KEY_2', 'PRIVATE_KEY_3'];

function getCandidatePrivateKeys() {
    const keys = [];
    for (const keyVar of DEPLOYER_KEY_VARS) {
        const value = process.env[keyVar];
        if (value) {
            keys.push({ envVar: keyVar, privateKey: value });
        }
    }
    return keys;
}

async function selectDeployerWallet(provider) {
    const candidates = getCandidatePrivateKeys();
    if (candidates.length === 0) {
        console.error('No PRIVATE_KEY, PRIVATE_KEY_1, PRIVATE_KEY_2, or PRIVATE_KEY_3 found in .env for deployment');
        process.exit(1);
    }

    console.log('Selecting deployer from funded wallets...');

    let best = null;

    for (const candidate of candidates) {
        const wallet = new ethers.Wallet(candidate.privateKey, provider);
        try {
            const balance = await provider.getBalance(wallet.address);
            console.log(`  ${candidate.envVar} (${wallet.address}): ${ethers.formatEther(balance)} native`);

            if (!best || balance > best.balance) {
                best = { wallet, balance, envVar: candidate.envVar };
            }
        } catch (error) {
            console.error(`  Failed to get balance for ${wallet.address}: ${error.message}`);
        }
    }

    if (!best || best.balance === 0n) {
        console.error('No funded deployer wallet found (all balances are zero)');
        process.exit(1);
    }

    console.log(`Using ${best.envVar} (${best.wallet.address}) as deployer`);
    return best.wallet;
}

async function compileContract(contractName) {
    const contractPath = path.join('contracts', `${contractName}.sol`);
    
    if (!fs.existsSync(contractPath)) {
        throw new Error(`Contract file not found: ${contractPath}`);
    }

    console.log(`Compiling ${contractName}...`);
    
    try {
        const solidityCode = fs.readFileSync(contractPath, 'utf8');
        
        const input = {
            language: 'Solidity',
            sources: {
                [contractName]: {
                    content: solidityCode,
                },
            },
            settings: {
                outputSelection: {
                    '*': {
                        '*': ['*'],
                    },
                },
            },
        };

        const output = JSON.parse(solc.compile(JSON.stringify(input)));
        
        if (output.errors) {
            output.errors.forEach(error => {
                if (error.severity === 'error') {
                    throw new Error(`Compilation error: ${error.message}`);
                }
                console.warn(`Warning: ${error.message}`);
            });
        }

        const contract = output.contracts[contractName][contractName];
        return {
            abi: contract.abi,
            bytecode: contract.evm.bytecode.object
        };
    } catch (error) {
        throw new Error(`Failed to compile ${contractName}: ${error.message}`);
    }
}

async function deployContract(provider, wallet, contractName, constructorArgs = []) {
    try {
        const { abi, bytecode } = await compileContract(contractName);
        
        console.log(`\nDeploying ${contractName}...`);
        
        const factory = new ethers.ContractFactory(abi, bytecode, wallet);
        const contract = await factory.deploy(...constructorArgs);
        
        console.log(`${contractName} deployment transaction: ${contract.deploymentTransaction().hash}`);
        
        const receipt = await contract.waitForDeployment();
        const address = await contract.getAddress();
        
        console.log(`${contractName} deployed to: ${address}`);
        console.log(`Gas used: ${receipt.gasUsed?.toString()}`);
        
        return {
            contract,
            address,
            abi
        };
    } catch (error) {
        console.error(`Failed to deploy ${contractName}:`, error);
        throw error;
    }
}

async function main() {
    console.log('Starting contract deployment...');
    console.log('RPC URL:', RPC_URL);
    
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = await selectDeployerWallet(provider);
    
    console.log('Deployer address:', wallet.address);
    
    try {
        // Test RPC connection first
        const blockNumber = await provider.getBlockNumber();
        console.log(`Connected to RPC. Latest block: ${blockNumber}`);
        
        const balance = await provider.getBalance(wallet.address);
        console.log('Deployer balance:', ethers.formatEther(balance), 'ETH');
        
        if (balance === 0n) {
            console.error('Deployer has no balance. Please fund the account first.');
            process.exit(1);
        }
    } catch (error) {
        console.error('RPC connection failed:', error.message);
        console.log('Please check your RPC_URL in .env file');
        process.exit(1);
    }

    const deployedContracts = {};

    try {
        const erc20 = await deployContract(provider, wallet, 'TestERC20', [1000000]);
        deployedContracts.TestERC20 = erc20.address;

        const storage = await deployContract(provider, wallet, 'TestStorage');
        deployedContracts.TestStorage = storage.address;

        const counter = await deployContract(provider, wallet, 'TestCounter');
        deployedContracts.TestCounter = counter.address;

        console.log('\n=== Deployment Summary ===');
        Object.entries(deployedContracts).forEach(([name, address]) => {
            console.log(`${name}: ${address}`);
        });

        const envPath = '.env';
        let envContent = fs.readFileSync(envPath, 'utf8');
        
        envContent = envContent.replace(/TEST_ERC20_CONTRACT=.*/, `TEST_ERC20_CONTRACT=${deployedContracts.TestERC20}`);
        envContent = envContent.replace(/TEST_STORAGE_CONTRACT=.*/, `TEST_STORAGE_CONTRACT=${deployedContracts.TestStorage}`);
        envContent = envContent.replace(/TEST_COUNTER_CONTRACT=.*/, `TEST_COUNTER_CONTRACT=${deployedContracts.TestCounter}`);
        
        fs.writeFileSync(envPath, envContent);
        console.log('\n.env file updated with contract addresses');

        const deploymentInfo = {
            timestamp: new Date().toISOString(),
            network: {
                rpcUrl: RPC_URL,
                chainId: (await provider.getNetwork()).chainId.toString()
            },
            deployer: wallet.address,
            contracts: deployedContracts
        };
        
        fs.writeFileSync('deployment.json', JSON.stringify(deploymentInfo, null, 2));
        console.log('Deployment info saved to deployment.json');

    } catch (error) {
        console.error('Deployment failed:', error);
        process.exit(1);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}
