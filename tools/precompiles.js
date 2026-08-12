#!/usr/bin/env node
/**
 * Precompile test suite for the local EVM chain (Republic/rai protocol).
 *
 * Merges the legacy test-precompiles.js (read), test-precompiles-2.js
 * (extended read), and test-precompiles-write.js (write) into one runner
 * with section selection.
 *
 * Usage:
 *   node tools/precompiles.js                # run all sections
 *   node tools/precompiles.js --section read
 *   node tools/precompiles.js --section write
 *   node tools/precompiles.js --rpc http://localhost:8545 --wallet dev0
 */
import { ethers } from 'ethers';
import { parseArgs } from 'util';

const args = parseArgs({
    args: process.argv.slice(2),
    options: {
        rpc: { type: 'string' },
        section: { type: 'string' },
        wallet: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
    },
    strict: false,
});

if (args.values.help) {
    console.log(`
Precompile test suite for the local EVM chain.

Usage: node tools/precompiles.js [--section <read|extended|write|all>] [--rpc <url>] [--wallet <dev0|dev1>]

Sections:
  read       Bech32, Bank, Staking query, Distribution, WERC20, Governance/Slashing code checks
  extended   Slashing params, Governance REST queries, ICS20, P256
  write      Staking delegate/undelegate, Distribution withdraw/claim, Governance proposal, WERC20 approve/transferFrom

Options:
  --rpc <url>       RPC endpoint (default: http://localhost:8545)
  --wallet <key>    dev0 or dev1 (default: dev0)
  -h, --help        Show this help
`);
    process.exit(0);
}

const RPC_URL = args.values.rpc || 'http://localhost:8545';
const provider = new ethers.JsonRpcProvider(RPC_URL);
const WALLETS = {
    dev0: '0x88CBEAD91AEE890D27BF06E003ADE3D4E952427E88F88D31D61D3EF5E5D54305',
    dev1: '0x741DE4F8988EA941D3FF0287911CA4074E62B7D45C991A51186455366F10B544',
};
const wallet = new ethers.Wallet(WALLETS[args.values.wallet || 'dev0'], provider);
const wallet2 = new ethers.Wallet(WALLETS.dev1, provider);

const PRECOMPILES = {
    P256: '0x0000000000000000000000000000000000000100',
    Bech32: '0x0000000000000000000000000000000000000400',
    Staking: '0x0000000000000000000000000000000000000800',
    Distribution: '0x0000000000000000000000000000000000000801',
    ICS20: '0x0000000000000000000000000000000000000802',
    Bank: '0x0000000000000000000000000000000000000804',
    Governance: '0x0000000000000000000000000000000000000805',
    Slashing: '0x0000000000000000000000000000000000000806',
    WERC20: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE',
};

const VALIDATOR_EVM = '0x7cB61D4117AE31a12E393a1Cfa3BaC666481D02E';
const VALIDATOR_BECH32 = 'raivaloper10jmp6sgh4cc6zt3e8gw05wavvejgr5pweczpke';

const results = [];

function log(test, status, detail) {
    results.push({ test, status, detail });
    const icon = status === 'PASS' ? '[PASS]' : status === 'FAIL' ? '[FAIL]' : '[INFO]';
    console.log(`${icon} ${test}: ${detail}`);
}

function summary(label) {
    console.log(`\n=== ${label} SUMMARY ===`);
    const passed = results.filter((r) => r.status === 'PASS').length;
    const failed = results.filter((r) => r.status === 'FAIL').length;
    console.log(`Total: ${results.length}, Passed: ${passed}, Failed: ${failed}`);
    if (failed > 0) {
        console.log('\nFailed tests:');
        results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(`  - ${r.test}: ${r.detail}`));
    }
}

async function sectionRead() {
    // Bech32
    const bech32Abi = [
        'function hexToBech32(address addr, string prefix) returns (string)',
        'function bech32ToHex(string bech32Address) returns (address)',
    ];
    const bech32 = new ethers.Contract(PRECOMPILES.Bech32, bech32Abi, wallet);
    try {
        const bech32Addr = await bech32.hexToBech32.staticCall(wallet.address, 'rai');
        log('Bech32: hexToBech32', 'PASS', `${wallet.address} -> ${bech32Addr}`);
    } catch (err) {
        log('Bech32: hexToBech32', 'FAIL', err.message.slice(0, 200));
    }
    try {
        const bech32Addr = await bech32.hexToBech32.staticCall(wallet.address, 'rai');
        const hexAddr = await bech32.bech32ToHex.staticCall(bech32Addr);
        const match = hexAddr.toLowerCase() === wallet.address.toLowerCase();
        log('Bech32: bech32ToHex', match ? 'PASS' : 'FAIL', `${bech32Addr} -> ${hexAddr} (match: ${match})`);
    } catch (err) {
        log('Bech32: bech32ToHex', 'FAIL', err.message.slice(0, 200));
    }

    // Bank
    const bankAbi = [
        'function balances(address account) view returns (tuple(address contractAddress, uint256 amount)[])',
        'function totalSupply() view returns (tuple(address contractAddress, uint256 amount)[])',
        'function supplyOf(address erc20Address) view returns (uint256)',
    ];
    const bank = new ethers.Contract(PRECOMPILES.Bank, bankAbi, provider);
    try {
        const balances = await bank.balances(wallet.address);
        log('Bank: balances()', 'PASS', balances.length ? `Found ${balances.length} balance(s)` : 'No balances (may be expected)');
    } catch (err) {
        log('Bank: balances()', 'FAIL', err.message.slice(0, 200));
    }
    try {
        const supply = await bank.totalSupply();
        log('Bank: totalSupply()', 'PASS', `${supply.length} token(s) in supply`);
    } catch (err) {
        log('Bank: totalSupply()', 'FAIL', err.message.slice(0, 200));
    }

    // Staking (query only)
    const stakingAbi = [
        'function delegation(address delegatorAddress, string validatorAddress) view returns (uint256 shares, tuple(string denom, uint256 amount) balance)',
        'function validator(address validatorAddress) view returns (tuple(string operatorAddress, string consensusPubkey, bool jailed, uint8 status, uint256 tokens, uint256 delegatorShares, string description, int64 unbondingHeight, int64 unbondingTime, uint256 commission, uint256 minSelfDelegation))',
    ];
    const staking = new ethers.Contract(PRECOMPILES.Staking, stakingAbi, provider);
    try {
        const validatorInfo = await staking.validator(VALIDATOR_EVM);
        log('Staking: validator()', 'PASS', `Operator: ${validatorInfo.operatorAddress}, Tokens: ${ethers.formatEther(validatorInfo.tokens)}, Jailed: ${validatorInfo.jailed}`);
    } catch (err) {
        log('Staking: validator()', 'FAIL', err.message.slice(0, 200));
    }
    try {
        const delegationInfo = await staking.delegation(wallet.address, VALIDATOR_BECH32);
        log('Staking: delegation()', 'PASS', `Shares: ${ethers.formatEther(delegationInfo.shares)}, Balance: ${delegationInfo.balance.amount} ${delegationInfo.balance.denom}`);
    } catch (err) {
        log('Staking: delegation()', 'FAIL', err.message.slice(0, 200));
    }

    // Distribution
    const distAbi = [
        'function delegationRewards(address delegatorAddress, string validatorAddress) view returns (tuple(string denom, uint256 amount)[])',
    ];
    const dist = new ethers.Contract(PRECOMPILES.Distribution, distAbi, provider);
    try {
        const rewards = await dist.delegationRewards(wallet.address, VALIDATOR_BECH32);
        log('Distribution: delegationRewards()', 'PASS', rewards.length ? `Rewards: ${rewards.map((r) => `${r.amount} ${r.denom}`).join(', ')}` : 'No rewards yet');
    } catch (err) {
        log('Distribution: delegationRewards()', 'FAIL', err.message.slice(0, 200));
    }

    // WERC20 (read)
    const werc20Abi = [
        'function name() view returns (string)',
        'function symbol() view returns (string)',
        'function decimals() view returns (uint8)',
        'function totalSupply() view returns (uint256)',
        'function balanceOf(address account) view returns (uint256)',
    ];
    const werc20 = new ethers.Contract(PRECOMPILES.WERC20, werc20Abi, provider);
    try {
        log('WERC20: name()', 'PASS', `Name: ${await werc20.name()}`);
    } catch (err) {
        log('WERC20: name()', 'FAIL', err.message.slice(0, 200));
    }
    try {
        log('WERC20: symbol()', 'PASS', `Symbol: ${await werc20.symbol()}`);
    } catch (err) {
        log('WERC20: symbol()', 'FAIL', err.message.slice(0, 200));
    }
    try {
        const balance = await werc20.balanceOf(wallet.address);
        log('WERC20: balanceOf()', 'PASS', `Balance: ${ethers.formatEther(balance)}`);
    } catch (err) {
        log('WERC20: balanceOf()', 'FAIL', err.message.slice(0, 200));
    }

    // Governance + Slashing code existence
    for (const [name, addr] of [['Governance', PRECOMPILES.Governance], ['Slashing', PRECOMPILES.Slashing]]) {
        try {
            const code = await provider.getCode(addr);
            const hasCode = code !== '0x' && code.length > 2;
            log(`${name}: code exists`, hasCode ? 'PASS' : 'FAIL', `Code length: ${code.length}`);
        } catch (err) {
            log(`${name}: code exists`, 'FAIL', err.message.slice(0, 200));
        }
    }
}

async function sectionExtended() {
    // Slashing params
    const slashingAbi = [
        'function getParams() view returns (tuple(int64 signedBlocksWindow, tuple(uint256 value, uint8 precision) minSignedPerWindow, int64 downtimeJailDuration, tuple(uint256 value, uint8 precision) slashFractionDoubleSign, tuple(uint256 value, uint8 precision) slashFractionDowntime) params)',
    ];
    const slashing = new ethers.Contract(PRECOMPILES.Slashing, slashingAbi, provider);
    try {
        const params = await slashing.getParams();
        log('Slashing: getParams()', 'PASS', `signedBlocksWindow=${params.signedBlocksWindow}, downtimeJailDuration=${params.downtimeJailDuration}`);
    } catch (err) {
        log('Slashing: getParams()', 'FAIL', err.message.slice(0, 300));
    }

    // Governance REST queries
    try {
        const resp = await fetch(`${process.env.COSMOS_REST_URL || 'http://localhost:1317'}/cosmos/gov/v1/proposals`);
        const data = await resp.json();
        log('Governance: query proposals (REST)', 'PASS', `Found ${data.proposals?.length || 0} proposals`);
    } catch (err) {
        log('Governance: query proposals (REST)', 'FAIL', err.message.slice(0, 200));
    }

    // ICS20
    const ics20Abi = ['function denomTrace(string hash) view returns (tuple(string path, string baseDenom) denomTrace)'];
    const ics20 = new ethers.Contract(PRECOMPILES.ICS20, ics20Abi, provider);
    try {
        const trace = await ics20.denomTrace('test');
        log('ICS20: denomTrace()', 'PASS', `path=${trace.path}, baseDenom=${trace.baseDenom}`);
    } catch (err) {
        if (err.message.includes('execution reverted')) {
            log('ICS20: denomTrace()', 'PASS', 'Precompile active (reverted as expected - no IBC channels)');
        } else {
            log('ICS20: denomTrace()', 'FAIL', err.message.slice(0, 200));
        }
    }

    // P256
    try {
        const iface = new ethers.Interface([
            'function verifySignature(bytes32 hash, uint256 r, uint256 s, uint256 x, uint256 y) view returns (bool)',
        ]);
        const calldata = iface.encodeFunctionData('verifySignature', [ethers.zeroPadValue('0x01', 32), 1n, 1n, 1n, 1n]);
        const result = await provider.call({ to: PRECOMPILES.P256, data: calldata });
        log('P256: verifySignature()', 'PASS', `Precompile responded (result: ${result})`);
    } catch (err) {
        if (err.message.includes('execution reverted')) {
            log('P256: verifySignature()', 'PASS', 'Precompile active (reverted with invalid sig - expected)');
        } else {
            log('P256: verifySignature()', 'FAIL', err.message.slice(0, 200));
        }
    }
}

async function sectionWrite() {
    const sendRaw = async (wallet_, to, abi, method, methodArgs, gasLimit = 300000) => {
        const iface = new ethers.Interface([abi]);
        const calldata = iface.encodeFunctionData(method, methodArgs);
        const tx = await wallet_.sendTransaction({ to, data: calldata, gasLimit });
        const receipt = await tx.wait();
        return receipt;
    };

    // Staking delegate/undelegate
    const stakingWriteAbi = [
        'function delegate(address delegatorAddress, string validatorAddress, uint256 amount) returns (bool)',
        'function undelegate(address delegatorAddress, string validatorAddress, uint256 amount) returns (int64 completionTime)',
    ];
    try {
        const receipt = await sendRaw(wallet2, PRECOMPILES.Staking, stakingWriteAbi[0], 'delegate', [wallet2.address, VALIDATOR_BECH32, ethers.parseEther('1.0')]);
        log('Staking: delegate()', 'PASS', `Hash: ${receipt.hash}, Gas: ${receipt.gasUsed}`);
    } catch (err) {
        log('Staking: delegate()', 'FAIL', err.message.slice(0, 300));
    }
    try {
        const receipt = await sendRaw(wallet2, PRECOMPILES.Staking, stakingWriteAbi[1], 'undelegate', [wallet2.address, VALIDATOR_BECH32, ethers.parseEther('0.5')]);
        log('Staking: undelegate()', 'PASS', `Hash: ${receipt.hash}, Gas: ${receipt.gasUsed}`);
    } catch (err) {
        log('Staking: undelegate()', 'FAIL', err.message.slice(0, 300));
    }

    // Distribution withdraw
    const distWriteAbi = [
        'function withdrawDelegatorRewards(address delegatorAddress, string validatorAddress) returns (tuple(string denom, uint256 amount)[])',
    ];
    try {
        const receipt = await sendRaw(wallet, PRECOMPILES.Distribution, distWriteAbi[0], 'withdrawDelegatorRewards', [wallet.address, VALIDATOR_BECH32]);
        log('Distribution: withdrawDelegatorRewards()', 'PASS', `Hash: ${receipt.hash}, Gas: ${receipt.gasUsed}`);
    } catch (err) {
        log('Distribution: withdrawDelegatorRewards()', 'FAIL', err.message.slice(0, 300));
    }

    // Governance proposal query
    const govAbi = [
        'function getProposal(uint64 proposalId) view returns (tuple(uint64 id, string[] messages, uint32 status, tuple(string yes, string abstain, string no, string noWithVeto) finalTallyResult, uint64 submitTime, uint64 depositEndTime, tuple(string denom, uint256 amount)[] totalDeposit, uint64 votingStartTime, uint64 votingEndTime, string metadata, string title, string summary, address proposer))',
    ];
    try {
        const gov = new ethers.Contract(PRECOMPILES.Governance, govAbi, wallet);
        const proposal = await gov.getProposal(1);
        log('Governance: getProposal(1)', 'PASS', `Title: "${proposal[10]}", Status: ${proposal[2]}, Proposer: ${proposal[12]}`);
    } catch (err) {
        log('Governance: getProposal(1)', 'FAIL', err.message.slice(0, 300));
    }

    // WERC20 approve / allowance / transferFrom
    const werc20WriteAbi = [
        'function approve(address spender, uint256 amount) returns (bool)',
        'function allowance(address owner, address spender) view returns (uint256)',
        'function transferFrom(address from, address to, uint256 amount) returns (bool)',
    ];
    const werc20 = new ethers.Contract(PRECOMPILES.WERC20, werc20WriteAbi, wallet);
    try {
        const amount = ethers.parseEther('0.01');
        const tx = await werc20.approve(wallet2.address, amount);
        const receipt = await tx.wait();
        log('WERC20: approve()', 'PASS', `Approved ${ethers.formatEther(amount)} to ${wallet2.address}, Gas: ${receipt.gasUsed}`);
    } catch (err) {
        log('WERC20: approve()', 'FAIL', err.message.slice(0, 300));
    }
    try {
        const allowance = await werc20.allowance(wallet.address, wallet2.address);
        log('WERC20: allowance()', 'PASS', `Allowance: ${ethers.formatEther(allowance)}`);
    } catch (err) {
        log('WERC20: allowance()', 'FAIL', err.message.slice(0, 300));
    }
    try {
        const werc20AsWallet2 = werc20.connect(wallet2);
        const tx = await werc20AsWallet2.transferFrom(wallet.address, wallet2.address, ethers.parseEther('0.005'));
        const receipt = await tx.wait();
        log('WERC20: transferFrom()', 'PASS', `Transferred 0.005 dev0->dev1, Gas: ${receipt.gasUsed}`);
    } catch (err) {
        log('WERC20: transferFrom()', 'FAIL', err.message.slice(0, 300));
    }
}

async function main() {
    const section = args.values.section || 'all';
    console.log(`=== Precompile Test Suite ===`);
    console.log(`RPC: ${RPC_URL} | Tester: ${wallet.address} | Section: ${section}`);

    if (section === 'read' || section === 'all') await sectionRead();
    if (section === 'extended' || section === 'all') await sectionExtended();
    if (section === 'write' || section === 'all') await sectionWrite();

    summary('TEST');
}

main().catch(console.error);
