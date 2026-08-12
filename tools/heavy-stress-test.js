#!/usr/bin/env node
import { ethers } from "ethers";
import { parseArgs } from "util";
import {
  LOAD_PROFILES,
  LOAD_STRATEGIES,
  detectChain,
  getRecommendedContracts,
  generateLoadFilter,
  EVENT_SIGNATURES
} from "../lib/load-profiles.js";
import { formatBytes } from "../lib/rpc-metrics.js";

const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    rpcUrl: { type: "string", short: "r" },
    contractAddress: { type: "string", short: "c" },
    loadProfile: { type: "string", short: "l" },
    loadStrategy: { type: "string", short: "s" },
    parallel: { type: "string", short: "p" },
    initialRange: { type: "string", short: "i" },
    maxTests: { type: "string", short: "m" },
    delay: { type: "string", short: "d" },
    topics: { type: "string", short: "t" },
    noAddress: { type: "boolean", short: "n" },
    autoDetect: { type: "boolean", short: "a" },
    help: { type: "boolean", short: "h" },
    verbose: { type: "boolean", short: "v" },
    list: { type: "boolean" },
  },
  strict: false,
});

if (args.values.help) {
  showHelp();
  process.exit(0);
}

if (args.values.list) {
  listContracts();
  process.exit(0);
}

function showHelp() {
  console.log(`
eth_getLogs Load Generation Tool

Generates load on RPC endpoints by querying high-activity contracts.

Usage: node tools/heavy-stress-test.js -r <RPC_URL> [OPTIONS]

LOAD PROFILES (use -l or --loadProfile):
  light      - Moderate activity contracts
  medium     - Active contracts with regular traffic
  heavy      - High activity contracts (default)
  chaos      - Query ALL contracts (use carefully!)

LOAD STRATEGIES (use -s or --loadStrategy):
  scatter       - Query all events without filtering (default)
  multiTopic    - Query multiple event types simultaneously
  highFrequency - Focus on Transfer events only
  chaos         - Query without address filter (ALL contracts!)

OPTIONS:
  --rpcUrl, -r <url>        RPC endpoint URL (required)
  --contractAddress, -c     Override with custom contract address
  --loadProfile, -l <prof>  Load intensity: light|medium|heavy|chaos
  --loadStrategy, -s <strat> Query strategy for data scatter
  --parallel, -p <n>        Number of parallel queries (default: 1, max: 10)
  --initialRange, -i <n>    Initial block range (default: 100)
  --maxTests, -m <n>        Maximum test iterations (default: 20)
  --delay, -d <ms>          Delay between requests (default: 500)
  --topics, -t <topics>     Custom topics (comma-separated hex strings)
  --noAddress, -n           Query without address filter
  --autoDetect, -a          Auto-detect chain and use recommended contracts
  --verbose, -v             Verbose output with details
  --list                    List all available high-load contracts
  --help, -h                Show this help

EXAMPLES:

  # Auto-detect chain and use high-activity contracts
  node tools/heavy-stress-test.js -r https://eth.alchemy.com/v2/KEY -a -l heavy

  # Parallel queries on a specific contract
  node tools/heavy-stress-test.js -r https://polygon-rpc.com -c 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 -p 5

  # Chaos mode - query ALL contracts for Transfer events
  node tools/heavy-stress-test.js -r https://rpc.url -s chaos -i 10 -m 5

  # Custom topics
  node tools/heavy-stress-test.js -r https://rpc.url -c 0xContract -t 0xddf252ad,0x8c5be1e5

  # List all available high-load contracts
  node tools/heavy-stress-test.js --list

CHAIN DETECTION:
Auto-detects chain from RPC URL:
- Ethereum, Polygon, Arbitrum, Base, BSC, Avalanche, Optimism

Each chain has pre-configured high-activity contracts.
  `);
}

function listContracts() {
  console.log("\n HIGH-LOAD CONTRACTS BY CHAIN\n");
  console.log("=".repeat(60));
  
  for (const [chain, profiles] of Object.entries(LOAD_PROFILES)) {
    console.log(`\n ${chain.toUpperCase()}`);
    console.log("-".repeat(40));
    
    for (const [intensity, contracts] of Object.entries(profiles)) {
      console.log(`\n  ${intensity.toUpperCase()} LOAD:`);
      for (const contract of contracts) {
        console.log(`    • ${contract.name}`);
        console.log(`      ${contract.address}`);
        console.log(`      ${contract.description}`);
      }
    }
  }
  
  console.log("\n\n EVENT SIGNATURES FOR CUSTOM QUERIES\n");
  console.log("-".repeat(40));
  for (const [name, sig] of Object.entries(EVENT_SIGNATURES)) {
    console.log(`${name}: ${sig}`);
  }
}

async function runHeavyLoadTest() {
  // Configuration
  const config = {
    rpcUrl: args.values.rpcUrl,
    contractAddress: args.values.contractAddress,
    loadProfile: args.values.loadProfile || 'heavy',
    loadStrategy: args.values.loadStrategy || 'scatter',
    parallel: parseInt(args.values.parallel) || 1,
    initialRange: parseInt(args.values.initialRange) || 100,
    maxTests: parseInt(args.values.maxTests) || 20,
    delay: parseInt(args.values.delay) || 500,
    topics: args.values.topics ? args.values.topics.split(',') : null,
    noAddress: args.values.noAddress || false,
    autoDetect: args.values.autoDetect || false,
    verbose: args.values.verbose || false,
  };
  
  // Validate
  if (!config.rpcUrl) {
    console.error(" RPC URL is required. Use -r or --rpcUrl");
    process.exit(1);
  }
  
  // Limit parallel queries
  if (config.parallel > 10) {
    console.warn(" Limiting parallel queries to 10 to prevent overwhelming the node");
    config.parallel = 10;
  }
  
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  
  console.log("\n Heavy Load RPC Stress Test");
  console.log("=".repeat(60));
  
  // Auto-detect chain and contracts
  let contracts = [];
  if (config.autoDetect && !config.contractAddress) {
    const detectedChain = detectChain(config.rpcUrl);
    if (detectedChain) {
      console.log(` Detected chain: ${detectedChain}`);
      contracts = getRecommendedContracts(detectedChain, config.loadProfile);
      if (contracts && contracts.length > 0) {
        console.log(` Using ${config.loadProfile.toUpperCase()} load profile with ${contracts.length} contract(s)`);
        contracts.forEach(c => {
          console.log(`  • ${c.name}: ${c.address.slice(0, 10)}...`);
        });
      }
    } else {
      console.log(" Could not auto-detect chain. Please specify contract address with -c");
      if (!config.contractAddress) {
        process.exit(1);
      }
    }
  }
  
  // Use manual contract if specified
  if (config.contractAddress) {
    contracts = [{ 
      address: config.contractAddress, 
      name: "Custom Contract",
      topics: config.topics || []
    }];
  }
  
  // Chaos mode - no contract filter
  if (config.loadStrategy === 'chaos' || config.noAddress) {
    console.warn("\n CHAOS MODE ACTIVATED ");
    console.warn("Querying WITHOUT address filter - this will query ALL contracts!");
    console.warn("This can overwhelm nodes and should be used very carefully!");
    contracts = [{ address: null, name: "ALL CONTRACTS", topics: [EVENT_SIGNATURES.Transfer] }];
  }
  
  if (contracts.length === 0) {
    console.error(" No contracts specified. Use -c for manual or -a for auto-detect");
    process.exit(1);
  }
  
  // Load strategy
  const strategy = LOAD_STRATEGIES[config.loadStrategy] || LOAD_STRATEGIES.scatter;
  console.log(`\n Load Strategy: ${strategy.name}`);
  console.log(`   ${strategy.description}`);
  if (strategy.warning) {
    console.warn(`   ${strategy.warning}`);
  }
  
  // Parallel queries
  if (config.parallel > 1) {
    console.log(`\n Parallel Queries: ${config.parallel}`);
    console.log("   Multiplying load by running concurrent requests");
  }
  
  try {
    const latestBlock = await provider.getBlockNumber();
    console.log(`\n Latest block: ${latestBlock} (0x${latestBlock.toString(16)})`);
    
    console.log("\n" + "=".repeat(80));
    console.log("Range    Contract         Parallel  Time(ms)  Logs    Size      Logs/ms  Status");
    console.log("-".repeat(80));
    
    let currentRange = config.initialRange;
    let totalLogs = 0;
    let totalTime = 0;
    let totalBytes = 0;
    let testCount = 0;
    
    while (testCount < config.maxTests) {
      const toBlock = latestBlock;
      const fromBlock = Math.max(0, toBlock - currentRange);
      
      // Cycle through contracts or use multiple in parallel
      const contractsToQuery = config.parallel > contracts.length 
        ? [...contracts, ...contracts, ...contracts].slice(0, config.parallel)
        : contracts.slice(0, config.parallel);
      
      const parallelPromises = [];
      const startTime = Date.now();
      
      for (let i = 0; i < config.parallel; i++) {
        const contract = contractsToQuery[i % contractsToQuery.length];
        const filter = generateLoadFilter({
          strategy: config.loadStrategy,
          address: contract.address,
          topics: contract.topics || strategy.topics || config.topics,
          fromBlock,
          toBlock
        });
        
        parallelPromises.push(
          provider.getLogs(filter.filter).catch(err => ({ error: err.message }))
        );
      }
      
      const results = await Promise.all(parallelPromises);
      const endTime = Date.now();
      const responseTime = endTime - startTime;
      
      let successCount = 0;
      let errorCount = 0;
      let logsRetrieved = 0;
      let dataSize = 0;
      
      results.forEach((result, idx) => {
        if (result.error) {
          errorCount++;
          if (config.verbose) {
            console.error(`  Query ${idx + 1} failed: ${result.error}`);
          }
        } else {
          successCount++;
          logsRetrieved += result.length;
          dataSize += Buffer.byteLength(JSON.stringify(result), 'utf8');
        }
      });
      
      totalLogs += logsRetrieved;
      totalTime += responseTime;
      totalBytes += dataSize;
      
      const logsPerMs = logsRetrieved / responseTime;
      const status = errorCount > 0 ? ` ${errorCount} failed` : " OK";
      const contractName = contractsToQuery[0].name.slice(0, 15).padEnd(15);
      
      console.log(
        `${currentRange.toString().padEnd(8)} ` +
        `${contractName} ` +
        `${config.parallel.toString().padEnd(9)} ` +
        `${responseTime.toString().padEnd(9)} ` +
        `${logsRetrieved.toString().padEnd(7)} ` +
        `${formatBytes(dataSize).padEnd(9)} ` +
        `${logsPerMs.toFixed(2).padEnd(8)} ` +
        status
      );
      
      // Check for limits
      if (logsRetrieved >= 10000 * config.parallel * 0.8) {
        console.warn(`\n Approaching 10k log limit per query. Retrieved ${logsRetrieved} total logs.`);
      }
      
      // Increase range for next iteration
      currentRange = Math.min(currentRange * 1.5, 2000); // Cap at 2000 to avoid timeouts
      testCount++;
      
      // Delay between tests
      if (testCount < config.maxTests) {
        await new Promise(resolve => setTimeout(resolve, config.delay));
      }
    }
    
    // Final summary
    console.log("\n" + "=".repeat(60));
    console.log(" LOAD TEST SUMMARY");
    console.log("-".repeat(60));
    console.log(`Total Queries: ${testCount * config.parallel}`);
    console.log(`Total Logs Retrieved: ${totalLogs.toLocaleString()}`);
    console.log(`Total Data Transferred: ${formatBytes(totalBytes)}`);
    console.log(`Total Time: ${totalTime}ms`);
    console.log(`Average Logs/ms: ${(totalLogs / totalTime).toFixed(3)}`);
    console.log(`Average Response Time: ${(totalTime / testCount).toFixed(2)}ms`);
    console.log(`Data Throughput: ${formatBytes(totalBytes / (totalTime / 1000))}/s`);
    
    if (config.parallel > 1) {
      console.log(`\n Parallel Performance:`);
      console.log(`  Queries per test: ${config.parallel}`);
      console.log(`  Effective load multiplier: ${config.parallel}x`);
    }
    
  } catch (error) {
    console.error("\n Test failed:", error.message);
    if (config.verbose) {
      console.error(error);
    }
    process.exit(1);
  }
}

// Run the test
runHeavyLoadTest();