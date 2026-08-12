import { ethers } from 'ethers';

const RPC_URL = 'http://localhost:8545';
const provider = new ethers.JsonRpcProvider(RPC_URL);

// dev0 private key
const PRIVATE_KEY = '0x88CBEAD91AEE890D27BF06E003ADE3D4E952427E88F88D31D61D3EF5E5D54305';
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

// Precompile addresses (from v0.5.0 docs)
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

const results = [];

function log(test, status, detail) {
  const entry = { test, status, detail };
  results.push(entry);
  const icon = status === 'PASS' ? '[PASS]' : status === 'FAIL' ? '[FAIL]' : '[INFO]';
  console.log(`${icon} ${test}: ${detail}`);
}

async function testBech32Precompile() {
  console.log('\n--- Bech32 Precompile (0x...0400) ---');
  const abi = [
    'function hexToBech32(address addr, string prefix) returns (string)',
    'function bech32ToHex(string bech32Address) returns (address)',
  ];
  const contract = new ethers.Contract(PRECOMPILES.Bech32, abi, wallet);

  try {
    // hexToBech32 - convert dev0 EVM address to rai bech32
    const bech32Addr = await contract.hexToBech32.staticCall(wallet.address, 'rai');
    log('Bech32: hexToBech32', 'PASS', `${wallet.address} -> ${bech32Addr}`);

    // bech32ToHex - convert back
    const hexAddr = await contract.bech32ToHex.staticCall(bech32Addr);
    const match = hexAddr.toLowerCase() === wallet.address.toLowerCase();
    log('Bech32: bech32ToHex', match ? 'PASS' : 'FAIL', `${bech32Addr} -> ${hexAddr} (match: ${match})`);
  } catch (err) {
    log('Bech32 Precompile', 'FAIL', err.message.slice(0, 200));
  }
}

async function testBankPrecompile() {
  console.log('\n--- Bank Precompile (0x...0804) ---');
  const abi = [
    'function balances(address account) view returns (tuple(address contractAddress, uint256 amount)[])',
    'function totalSupply() view returns (tuple(address contractAddress, uint256 amount)[])',
    'function supplyOf(address erc20Address) view returns (uint256)',
  ];
  const contract = new ethers.Contract(PRECOMPILES.Bank, abi, provider);

  try {
    const balances = await contract.balances(wallet.address);
    if (balances.length > 0) {
      log('Bank: balances()', 'PASS', `Found ${balances.length} balance(s): ${balances.map(b => `${b.contractAddress}=${ethers.formatEther(b.amount)}`).join(', ')}`);
    } else {
      log('Bank: balances()', 'PASS', 'No balances returned (may be expected)');
    }
  } catch (err) {
    log('Bank: balances()', 'FAIL', err.message.slice(0, 200));
  }

  try {
    const supply = await contract.totalSupply();
    log('Bank: totalSupply()', 'PASS', `${supply.length} token(s) in supply`);
  } catch (err) {
    log('Bank: totalSupply()', 'FAIL', err.message.slice(0, 200));
  }

  try {
    const supply = await contract.supplyOf(PRECOMPILES.WERC20);
    log('Bank: supplyOf(WERC20)', 'PASS', `Supply: ${ethers.formatEther(supply)} atest`);
  } catch (err) {
    log('Bank: supplyOf(WERC20)', 'FAIL', err.message.slice(0, 200));
  }
}

async function testStakingPrecompile() {
  console.log('\n--- Staking Precompile (0x...0800) ---');

  // Query-only ABI
  const abi = [
    'function delegation(address delegatorAddress, string validatorAddress) view returns (uint256 shares, tuple(string denom, uint256 amount) balance)',
    'function validator(address validatorAddress) view returns (tuple(string operatorAddress, string consensusPubkey, bool jailed, uint8 status, uint256 tokens, uint256 delegatorShares, string description, int64 unbondingHeight, int64 unbondingTime, uint256 commission, uint256 minSelfDelegation))',
    'function delegate(address delegatorAddress, string validatorAddress, uint256 amount) returns (bool)',
  ];
  const contract = new ethers.Contract(PRECOMPILES.Staking, abi, wallet);

  // Get validator address (EVM form of raivaloper10jmp6sgh4cc6zt3e8gw05wavvejgr5pweczpke)
  // The validator's EVM address is 0x7cB61D4117AE31a12E393a1Cfa3BaC666481D02E
  const validatorEvmAddr = '0x7cB61D4117AE31a12E393a1Cfa3BaC666481D02E';
  const validatorBech32 = 'raivaloper10jmp6sgh4cc6zt3e8gw05wavvejgr5pweczpke';

  try {
    const validatorInfo = await contract.validator(validatorEvmAddr);
    log('Staking: validator()', 'PASS', `Operator: ${validatorInfo.operatorAddress}, Tokens: ${ethers.formatEther(validatorInfo.tokens)}, Jailed: ${validatorInfo.jailed}, Status: ${validatorInfo.status}`);
  } catch (err) {
    log('Staking: validator()', 'FAIL', err.message.slice(0, 200));
  }

  try {
    const delegationInfo = await contract.delegation(wallet.address, validatorBech32);
    log('Staking: delegation()', 'PASS', `Shares: ${ethers.formatEther(delegationInfo.shares)}, Balance: ${delegationInfo.balance.amount.toString()} ${delegationInfo.balance.denom}`);
  } catch (err) {
    log('Staking: delegation()', 'FAIL', err.message.slice(0, 200));
  }

  // Test delegate via precompile (small amount)
  try {
    const delegateAmount = ethers.parseEther('0.01'); // 0.01 token
    const tx = await contract.delegate(wallet.address, validatorBech32, delegateAmount);
    const receipt = await tx.wait();
    log('Staking: delegate() tx', 'PASS', `TX: ${receipt.hash}, Gas: ${receipt.gasUsed.toString()}`);
  } catch (err) {
    log('Staking: delegate() tx', 'FAIL', err.message.slice(0, 200));
  }
}

async function testDistributionPrecompile() {
  console.log('\n--- Distribution Precompile (0x...0801) ---');
  const abi = [
    'function delegationRewards(address delegatorAddress, string validatorAddress) view returns (tuple(string denom, uint256 amount)[])',
    'function delegationTotalRewards(address delegatorAddress) view returns (tuple(tuple(string validatorAddress, tuple(string denom, uint256 amount)[] reward)[] rewards, tuple(string denom, uint256 amount)[] total))',
  ];
  const contract = new ethers.Contract(PRECOMPILES.Distribution, abi, provider);
  const validatorBech32 = 'raivaloper10jmp6sgh4cc6zt3e8gw05wavvejgr5pweczpke';

  try {
    const rewards = await contract.delegationRewards(wallet.address, validatorBech32);
    if (rewards.length > 0) {
      log('Distribution: delegationRewards()', 'PASS', `Rewards: ${rewards.map(r => `${r.amount} ${r.denom}`).join(', ')}`);
    } else {
      log('Distribution: delegationRewards()', 'PASS', 'No rewards yet (expected for new delegation)');
    }
  } catch (err) {
    log('Distribution: delegationRewards()', 'FAIL', err.message.slice(0, 200));
  }
}

async function testWERC20Precompile() {
  console.log('\n--- WERC20 Precompile (0xEeee...eEEeE) ---');
  const abi = [
    'function name() view returns (string)',
    'function symbol() view returns (string)',
    'function decimals() view returns (uint8)',
    'function totalSupply() view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
    'function transfer(address to, uint256 amount) returns (bool)',
    'function deposit() payable',
    'function withdraw(uint256 amount)',
  ];
  const contract = new ethers.Contract(PRECOMPILES.WERC20, abi, wallet);

  try {
    const name = await contract.name();
    log('WERC20: name()', 'PASS', `Name: ${name}`);
  } catch (err) {
    log('WERC20: name()', 'FAIL', err.message.slice(0, 200));
  }

  try {
    const symbol = await contract.symbol();
    log('WERC20: symbol()', 'PASS', `Symbol: ${symbol}`);
  } catch (err) {
    log('WERC20: symbol()', 'FAIL', err.message.slice(0, 200));
  }

  try {
    const decimals = await contract.decimals();
    log('WERC20: decimals()', 'PASS', `Decimals: ${decimals}`);
  } catch (err) {
    log('WERC20: decimals()', 'FAIL', err.message.slice(0, 200));
  }

  try {
    const totalSupply = await contract.totalSupply();
    log('WERC20: totalSupply()', 'PASS', `Total Supply: ${ethers.formatEther(totalSupply)}`);
  } catch (err) {
    log('WERC20: totalSupply()', 'FAIL', err.message.slice(0, 200));
  }

  try {
    const balance = await contract.balanceOf(wallet.address);
    log('WERC20: balanceOf()', 'PASS', `Balance: ${ethers.formatEther(balance)}`);
  } catch (err) {
    log('WERC20: balanceOf()', 'FAIL', err.message.slice(0, 200));
  }

  // Test deposit (no-op per docs, but should work)
  try {
    const depositAmount = ethers.parseEther('0.001');
    const tx = await contract.deposit({ value: depositAmount });
    const receipt = await tx.wait();
    log('WERC20: deposit()', 'PASS', `TX: ${receipt.hash}, Gas: ${receipt.gasUsed.toString()}`);
  } catch (err) {
    log('WERC20: deposit()', 'FAIL', err.message.slice(0, 200));
  }

  // Test withdraw (no-op per docs)
  try {
    const withdrawAmount = ethers.parseEther('0.001');
    const tx = await contract.withdraw(withdrawAmount);
    const receipt = await tx.wait();
    log('WERC20: withdraw()', 'PASS', `TX: ${receipt.hash}, Gas: ${receipt.gasUsed.toString()}`);
  } catch (err) {
    log('WERC20: withdraw()', 'FAIL', err.message.slice(0, 200));
  }

  // Test ERC20 transfer via WERC20
  const dev1Addr = '0x963EBDf2e1f8DB8707D05FC75bfeFFBa1B5BaC17';
  try {
    const transferAmount = ethers.parseEther('0.001');
    const tx = await contract.transfer(dev1Addr, transferAmount);
    const receipt = await tx.wait();
    log('WERC20: transfer()', 'PASS', `TX: ${receipt.hash}, Gas: ${receipt.gasUsed.toString()}`);
  } catch (err) {
    log('WERC20: transfer()', 'FAIL', err.message.slice(0, 200));
  }
}

async function testGovernancePrecompile() {
  console.log('\n--- Governance Precompile (0x...0805) ---');
  // Just check if it has code deployed (existence check)
  try {
    const code = await provider.getCode(PRECOMPILES.Governance);
    const hasCode = code !== '0x' && code.length > 2;
    log('Governance: code exists', hasCode ? 'PASS' : 'FAIL', `Code length: ${code.length}`);
  } catch (err) {
    log('Governance: code exists', 'FAIL', err.message.slice(0, 200));
  }
}

async function testSlashingPrecompile() {
  console.log('\n--- Slashing Precompile (0x...0806) ---');
  try {
    const code = await provider.getCode(PRECOMPILES.Slashing);
    const hasCode = code !== '0x' && code.length > 2;
    log('Slashing: code exists', hasCode ? 'PASS' : 'FAIL', `Code length: ${code.length}`);
  } catch (err) {
    log('Slashing: code exists', 'FAIL', err.message.slice(0, 200));
  }
}

async function main() {
  console.log('=== Republic Protocol - Precompile Test Suite ===');
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Tester: ${wallet.address}`);

  const blockNumber = await provider.getBlockNumber();
  console.log(`Block: ${blockNumber}`);
  console.log();

  await testBech32Precompile();
  await testBankPrecompile();
  await testStakingPrecompile();
  await testDistributionPrecompile();
  await testWERC20Precompile();
  await testGovernancePrecompile();
  await testSlashingPrecompile();

  // Summary
  console.log('\n\n=== TEST SUMMARY ===');
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`Total: ${results.length}, Passed: ${passed}, Failed: ${failed}`);
  console.log(`Success Rate: ${((passed / results.length) * 100).toFixed(1)}%`);

  if (failed > 0) {
    console.log('\nFailed tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => {
      console.log(`  - ${r.test}: ${r.detail}`);
    });
  }
}

main().catch(console.error);
