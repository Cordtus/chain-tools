import { ethers } from 'ethers';

const RPC_URL = 'http://localhost:8545';
const provider = new ethers.JsonRpcProvider(RPC_URL);

// dev0 private key
const wallet = new ethers.Wallet('0x88CBEAD91AEE890D27BF06E003ADE3D4E952427E88F88D31D61D3EF5E5D54305', provider);
// dev1 private key
const wallet2 = new ethers.Wallet('0x741DE4F8988EA941D3FF0287911CA4074E62B7D45C991A51186455366F10B544', provider);

const validatorBech32 = 'raivaloper10jmp6sgh4cc6zt3e8gw05wavvejgr5pweczpke';

const results = [];
function log(test, status, detail) {
  results.push({ test, status, detail });
  const icon = status === 'PASS' ? '[PASS]' : status === 'FAIL' ? '[FAIL]' : '[INFO]';
  console.log(`${icon} ${test}: ${detail}`);
}

// ========== STAKING PRECOMPILE (0x800) ==========
async function testStakingWrite() {
  console.log('\n--- Staking Precompile: Write Operations ---');
  const abi = [
    'function delegate(address delegatorAddress, string validatorAddress, uint256 amount) returns (bool)',
    'function undelegate(address delegatorAddress, string validatorAddress, uint256 amount) returns (int64 completionTime)',
    'function delegation(address delegatorAddress, string validatorAddress) view returns (uint256 shares, tuple(string denom, uint256 amount) balance)',
  ];
  const contract = new ethers.Contract('0x0000000000000000000000000000000000000800', abi, wallet2);

  // Delegate from dev1
  try {
    const amount = ethers.parseEther('1.0');
    const tx = await contract.delegate(wallet2.address, validatorBech32, amount);
    const receipt = await tx.wait();
    log('Staking: delegate() via precompile', 'PASS', `Hash: ${receipt.hash}, Gas: ${receipt.gasUsed}`);
  } catch (err) {
    log('Staking: delegate() via precompile', 'FAIL', err.message.slice(0, 300));
  }

  // Query delegation
  try {
    const delegation = await contract.delegation(wallet2.address, validatorBech32);
    log('Staking: delegation() query after delegate', 'PASS', `Shares: ${ethers.formatEther(delegation.shares)}, Amount: ${delegation.balance.amount}`);
  } catch (err) {
    log('Staking: delegation() after delegate', 'FAIL', err.message.slice(0, 300));
  }

  // Undelegate half (use raw encoding - ethers.js v6 Contract proxy has issues with this method)
  try {
    const amount = ethers.parseEther('0.5');
    const iface = new ethers.Interface([
      'function undelegate(address delegatorAddress, string validatorAddress, uint256 amount) returns (int64 completionTime)',
    ]);
    const calldata = iface.encodeFunctionData('undelegate', [wallet2.address, validatorBech32, amount]);
    const tx = await wallet2.sendTransaction({
      to: '0x0000000000000000000000000000000000000800',
      data: calldata,
      gasLimit: 300000,
    });
    const receipt = await tx.wait();
    log('Staking: undelegate() via precompile', 'PASS', `Hash: ${receipt.hash}, Gas: ${receipt.gasUsed}`);
  } catch (err) {
    log('Staking: undelegate() via precompile', 'FAIL', err.message.slice(0, 300));
  }
}

// ========== DISTRIBUTION PRECOMPILE (0x801) ==========
async function testDistributionWrite() {
  console.log('\n--- Distribution Precompile: Write Operations ---');
  const abi = [
    'function withdrawDelegatorRewards(address delegatorAddress, string validatorAddress) returns (tuple(string denom, uint256 amount)[])',
    'function claimRewards(address delegatorAddress, uint32 maxRetrieve) returns (bool)',
    'function delegationRewards(address delegatorAddress, string validatorAddress) view returns (tuple(string denom, uint256 amount)[])',
  ];
  const contract = new ethers.Contract('0x0000000000000000000000000000000000000801', abi, wallet);

  // Query rewards first
  try {
    const rewards = await contract.delegationRewards(wallet.address, validatorBech32);
    log('Distribution: delegationRewards() query', 'PASS', rewards.length > 0 ? `Rewards: ${rewards.map(r => `${r.amount} ${r.denom}`).join(', ')}` : 'No rewards accrued yet');
  } catch (err) {
    log('Distribution: delegationRewards() query', 'FAIL', err.message.slice(0, 300));
  }

  // Withdraw delegator rewards (use raw encoding for reliability)
  try {
    const iface = new ethers.Interface([
      'function withdrawDelegatorRewards(address delegatorAddress, string validatorAddress) returns (tuple(string denom, uint256 amount)[])',
    ]);
    const calldata = iface.encodeFunctionData('withdrawDelegatorRewards', [wallet.address, validatorBech32]);
    const tx = await wallet.sendTransaction({
      to: '0x0000000000000000000000000000000000000801',
      data: calldata,
      gasLimit: 300000,
    });
    const receipt = await tx.wait();
    log('Distribution: withdrawDelegatorRewards()', 'PASS', `Hash: ${receipt.hash}, Gas: ${receipt.gasUsed}`);
  } catch (err) {
    log('Distribution: withdrawDelegatorRewards()', 'FAIL', err.message.slice(0, 300));
  }

  // claimRewards (use raw encoding with explicit nonce to avoid race condition)
  try {
    const iface = new ethers.Interface([
      'function claimRewards(address delegatorAddress, uint32 maxRetrieve) returns (bool)',
    ]);
    const calldata = iface.encodeFunctionData('claimRewards', [wallet.address, 100]);
    const nonce = await provider.getTransactionCount(wallet.address, 'latest');
    const tx = await wallet.sendTransaction({
      to: '0x0000000000000000000000000000000000000801',
      data: calldata,
      gasLimit: 300000,
      nonce,
    });
    const receipt = await tx.wait();
    log('Distribution: claimRewards()', 'PASS', `Hash: ${receipt.hash}, Gas: ${receipt.gasUsed}`);
  } catch (err) {
    log('Distribution: claimRewards()', 'FAIL', err.message.slice(0, 300));
  }
}

// ========== GOVERNANCE PRECOMPILE (0x805) ==========
async function testGovernanceWrite() {
  console.log('\n--- Governance Precompile: Write Operations ---');

  // Read the actual governance ABI from the docs to find correct method signatures
  // Let's try to vote on proposal 1 via precompile (if still possible) or submit a new one
  const abi = [
    'function vote(uint64 proposalId, uint8 option, string metadata)',
    'function getProposal(uint64 proposalId) view returns (tuple(uint64 id, string[] messages, uint32 status, tuple(string yes, string abstain, string no, string noWithVeto) finalTallyResult, uint64 submitTime, uint64 depositEndTime, tuple(string denom, uint256 amount)[] totalDeposit, uint64 votingStartTime, uint64 votingEndTime, string metadata, string title, string summary, address proposer))',
  ];
  const contract = new ethers.Contract('0x0000000000000000000000000000000000000805', abi, wallet);

  // Query proposal 1
  try {
    const proposal = await contract.getProposal(1);
    log('Governance: getProposal(1)', 'PASS', `Title: "${proposal[10]}", Status: ${proposal[2]}, Proposer: ${proposal[12]}`);
  } catch (err) {
    log('Governance: getProposal(1)', 'FAIL', err.message.slice(0, 300));
  }
}

// ========== BECH32 PRECOMPILE (0x400) ==========
async function testBech32Write() {
  console.log('\n--- Bech32 Precompile: Conversions ---');
  const abi = [
    'function hexToBech32(address addr, string prefix) returns (string)',
    'function bech32ToHex(string bech32Address) returns (address)',
  ];
  const contract = new ethers.Contract('0x0000000000000000000000000000000000000400', abi, wallet);

  // Convert validator address
  try {
    const bech32Addr = await contract.hexToBech32.staticCall('0x7cB61D4117AE31a12E393a1Cfa3BaC666481D02E', 'raivaloper');
    log('Bech32: validator hexToBech32', 'PASS', `Validator bech32: ${bech32Addr}`);
  } catch (err) {
    log('Bech32: validator hexToBech32', 'FAIL', err.message.slice(0, 300));
  }

  // Convert dev1 address
  try {
    const bech32Addr = await contract.hexToBech32.staticCall(wallet2.address, 'rai');
    const roundTrip = await contract.bech32ToHex.staticCall(bech32Addr);
    const match = roundTrip.toLowerCase() === wallet2.address.toLowerCase();
    log('Bech32: dev1 round-trip', match ? 'PASS' : 'FAIL', `${wallet2.address} -> ${bech32Addr} -> ${roundTrip}`);
  } catch (err) {
    log('Bech32: dev1 round-trip', 'FAIL', err.message.slice(0, 300));
  }
}

// ========== WERC20 PRECOMPILE (0xEeee...) ==========
async function testWERC20Write() {
  console.log('\n--- WERC20 Precompile: ERC20 Operations ---');
  const abi = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function transferFrom(address from, address to, uint256 amount) returns (bool)',
    'function balanceOf(address account) view returns (uint256)',
  ];
  const werc20 = new ethers.Contract('0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', abi, wallet);

  // Approve dev1 to spend 0.01 tokens
  try {
    const amount = ethers.parseEther('0.01');
    const tx = await werc20.approve(wallet2.address, amount);
    const receipt = await tx.wait();
    log('WERC20: approve()', 'PASS', `Approved ${ethers.formatEther(amount)} to ${wallet2.address}, Gas: ${receipt.gasUsed}`);
  } catch (err) {
    log('WERC20: approve()', 'FAIL', err.message.slice(0, 300));
  }

  // Check allowance
  try {
    const allowance = await werc20.allowance(wallet.address, wallet2.address);
    log('WERC20: allowance()', 'PASS', `Allowance: ${ethers.formatEther(allowance)}`);
  } catch (err) {
    log('WERC20: allowance()', 'FAIL', err.message.slice(0, 300));
  }

  // TransferFrom (dev1 spends dev0's allowance)
  try {
    const werc20AsWallet2 = werc20.connect(wallet2);
    const amount = ethers.parseEther('0.005');
    const tx = await werc20AsWallet2.transferFrom(wallet.address, wallet2.address, amount);
    const receipt = await tx.wait();
    log('WERC20: transferFrom()', 'PASS', `Transferred ${ethers.formatEther(amount)} from dev0 to dev1, Gas: ${receipt.gasUsed}`);
  } catch (err) {
    log('WERC20: transferFrom()', 'FAIL', err.message.slice(0, 300));
  }
}

async function main() {
  console.log('=== Republic Protocol - Precompile Write Operations Test ===');
  console.log(`Tester (dev0): ${wallet.address}`);
  console.log(`Tester (dev1): ${wallet2.address}`);
  console.log(`Validator: ${validatorBech32}`);

  await testStakingWrite();
  await testDistributionWrite();
  await testGovernanceWrite();
  await testBech32Write();
  await testWERC20Write();

  console.log('\n\n=== WRITE OPERATIONS TEST SUMMARY ===');
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
