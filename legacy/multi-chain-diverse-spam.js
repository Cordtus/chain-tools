import dotenv from 'dotenv';
import { ethers } from 'ethers';
import { spawn } from 'child_process';
import EVMSpammer from './evm-spam.js';
import CosmosSpammer from './cosmos-spam.js';

dotenv.config();

function hydratePrivateKeysFromMnemonics() {
    const privateKeyVars = ['PRIVATE_KEY', 'PRIVATE_KEY_1', 'PRIVATE_KEY_2', 'PRIVATE_KEY_3'];
    const mnemonicVars = ['MNEMONIC', 'MNEMONIC_1', 'MNEMONIC_2', 'MNEMONIC_3'];
    const walletVars = ['WALLET', 'WALLET_1', 'WALLET_2', 'WALLET_3'];

    for (let i = 0; i < privateKeyVars.length; i++) {
        const pkVar = privateKeyVars[i];
        const mnVar = mnemonicVars[i];
        const wVar = walletVars[i];

        // If mnemonic is provided, derive both private key and address
        if (process.env[mnVar]) {
            try {
                const wallet = ethers.Wallet.fromPhrase(process.env[mnVar]);

                if (!process.env[pkVar]) {
                    process.env[pkVar] = wallet.privateKey;
                    console.log(`Derived ${pkVar} from ${mnVar}`);
                }

                const derivedAddress = wallet.address;
                if (!process.env[wVar]) {
                    process.env[wVar] = derivedAddress;
                    console.log(`Set ${wVar} to derived address ${derivedAddress}`);
                } else if (process.env[wVar].toLowerCase() !== derivedAddress.toLowerCase()) {
                    console.warn(
                        `${wVar} (${process.env[wVar]}) does not match address from ${mnVar} (${derivedAddress})`
                    );
                }
            } catch (error) {
                console.error(`Failed to derive ${pkVar}/${wVar} from ${mnVar}: ${error.message}`);
            }
        } else if (process.env[pkVar] && !process.env[wVar]) {
            // If only private key is provided, still populate WALLET* for convenience
            try {
                const wallet = new ethers.Wallet(process.env[pkVar]);
                process.env[wVar] = wallet.address;
                console.log(`Derived ${wVar} from ${pkVar}: ${wallet.address}`);
            } catch (error) {
                console.error(`Failed to derive ${wVar} from ${pkVar}: ${error.message}`);
            }
        }
    }
}

function parseArgs() {
    const args = process.argv.slice(2);

    const config = {
        duration: 120,
        evmMode: 'mixed',
        cosmosMode: 'mixed',
        evmTps: 10,
        cosmosTps: 5
    };

    for (const arg of args) {
        if (arg.startsWith('--duration=')) {
            const value = parseInt(arg.split('=')[1], 10);
            if (!Number.isNaN(value) && value > 0) {
                config.duration = value;
            }
        } else if (arg.startsWith('--evm-tps=')) {
            const value = parseInt(arg.split('=')[1], 10);
            if (!Number.isNaN(value) && value > 0) {
                config.evmTps = value;
            }
        } else if (arg.startsWith('--cosmos-tps=')) {
            const value = parseInt(arg.split('=')[1], 10);
            if (!Number.isNaN(value) && value > 0) {
                config.cosmosTps = value;
            }
        } else if (arg.startsWith('--evm-mode=')) {
            config.evmMode = arg.split('=')[1] || config.evmMode;
        } else if (arg.startsWith('--cosmos-mode=')) {
            config.cosmosMode = arg.split('=')[1] || config.cosmosMode;
        }
    }

    return config;
}

async function main() {
    const { duration, evmMode, cosmosMode, evmTps, cosmosTps } = parseArgs();

    hydratePrivateKeysFromMnemonics();

    console.log('\nMulti-chain Diverse Spammer');
    console.log('===========================');
    console.log(`Duration: ${duration}s`);
    console.log(`EVM:    mode=${evmMode}, tps=${evmTps}`);
    console.log(`Cosmos: mode=${cosmosMode}, tps=${cosmosTps}`);

    const evmSpammer = new EVMSpammer();
    const cosmosSpammer = new CosmosSpammer();

    // Capture spammer logs to avoid blowing away the dashboard UI
    const spamLogs = {};
    const originalLog = console.log;
    const originalError = console.error;

    const captureLog = (prefix, args) => {
        const msg = `${prefix}${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
        spamLogs[msg] = (spamLogs[msg] || 0) + 1;
    };

    const enableLogCapture = process.env.SPAM_VERBOSE !== '1';
    if (enableLogCapture) {
        console.log = (...args) => captureLog('', args);
        console.error = (...args) => captureLog('[error] ', args);
    }

    let dashboardProcess = null;
    try {
        // Launch the dual-chain mempool dashboard for live visualization
        dashboardProcess = spawn('node', ['../tools/mempool-dashboard.js'], {
            stdio: 'inherit'
        });

        dashboardProcess.on('error', (error) => {
            console.error(`Failed to start mempool dashboard: ${error.message}`);
        });

        await Promise.all([
            evmSpammer.run(evmMode, duration, evmTps).catch((error) => {
                captureLog('[error] ', [`EVM spammer error: ${error.message}`]);
            }),
            cosmosSpammer.run(cosmosMode, duration, cosmosTps).catch((error) => {
                captureLog('[error] ', [`Cosmos spammer error: ${error.message}`]);
            })
        ]);
    } finally {
        if (enableLogCapture) {
            console.log = originalLog;
            console.error = originalError;
        }

        if (dashboardProcess && !dashboardProcess.killed) {
            dashboardProcess.kill();
        }
    }

    console.log('\nMulti-chain spam run complete.');

    if (enableLogCapture && Object.keys(spamLogs).length > 0) {
        console.log('\nSpammer log summary (deduped):');
        for (const [msg, count] of Object.entries(spamLogs)) {
            console.log(`[${count}x] ${msg}`);
        }
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export default main;
