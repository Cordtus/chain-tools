#!/usr/bin/env node
import { ethers } from "ethers";
import { parseArgs } from "util";
import { formatBytes, getResponseSize, padString, calculateCorrelation } from "../lib/rpc-metrics.js";

const DEFAULT_CONFIG = {
  rpcUrl: null,  // Must be provided via --rpcUrl
  contractAddress: null,  // Must be provided via --contractAddress
  initialRange: 50,
  increment: 10,
  maxTests: 50,
  scanMode: "backward",
  growthMode: "linear",
  analysis: ["efficiency"],
  delay: 1000,
  outputFormat: "table",
  startBlock: null,
  endBlock: null,
};

const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    rpcUrl: { type: "string", short: "r" },
    contractAddress: { type: "string", short: "c" },
    initialRange: { type: "string", short: "i" },
    increment: { type: "string", short: "n" },
    maxTests: { type: "string", short: "m" },
    scanMode: { type: "string", short: "s" },
    growthMode: { type: "string", short: "g" },
    analysis: { type: "string", short: "a" },
    delay: { type: "string", short: "d" },
    outputFormat: { type: "string", short: "o" },
    startBlock: { type: "string", short: "b" },
    endBlock: { type: "string", short: "e" },
    help: { type: "boolean", short: "h" },
    verbose: { type: "boolean", short: "v" },
  },
  strict: false,
});

if (args.values.help) {
  showHelp();
  process.exit(0);
}

const config = {
  ...DEFAULT_CONFIG,
  ...(args.values.rpcUrl && { rpcUrl: args.values.rpcUrl }),
  ...(args.values.contractAddress && { contractAddress: args.values.contractAddress }),
  ...(args.values.initialRange && { initialRange: parseInt(args.values.initialRange) }),
  ...(args.values.increment && { increment: parseInt(args.values.increment) }),
  ...(args.values.maxTests && { maxTests: parseInt(args.values.maxTests) }),
  ...(args.values.scanMode && { scanMode: args.values.scanMode }),
  ...(args.values.growthMode && { growthMode: args.values.growthMode }),
  ...(args.values.analysis && { analysis: args.values.analysis.split(",") }),
  ...(args.values.delay && { delay: parseInt(args.values.delay) }),
  ...(args.values.outputFormat && { outputFormat: args.values.outputFormat }),
  ...(args.values.startBlock && { startBlock: parseInt(args.values.startBlock) }),
  ...(args.values.endBlock && { endBlock: parseInt(args.values.endBlock) }),
  verbose: args.values.verbose || false,
};

// Validate required parameters
if (!config.rpcUrl) {
  console.error(" Error: RPC URL is required. Use --rpcUrl or -r to specify.");
  console.error("Example: node stress-test.js -r https://eth-mainnet.g.alchemy.com/v2/YOUR-KEY -c 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  process.exit(1);
}

if (!config.contractAddress) {
  console.error(" Error: Contract address is required. Use --contractAddress or -c to specify.");
  console.error("Example: node stress-test.js -r https://eth-mainnet.g.alchemy.com/v2/YOUR-KEY -c 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  process.exit(1);
}

const metrics = [];
let testCount = 0;

function showHelp() {
  console.log(`
Ethereum RPC Stress Testing Tool - Multi-Chain EVM Compatible

Usage: node stress-test.js -r <RPC_URL> -c <CONTRACT_ADDRESS> [OPTIONS]

REQUIRED:
  --rpcUrl, -r <url>        RPC endpoint URL (required)
  --contractAddress, -c     Contract address to query (required)

SCAN MODES:
  --scanMode, -s <mode>     Scanning strategy (default: backward)
    backward               Move backward from latest block
    forward                Move forward from start block
    fixed                  Use fixed endpoint, increase range

GROWTH MODES:
  --growthMode, -g <mode>   Range growth strategy (default: linear)
    linear                 Add increment each iteration
    exponential            Double range each iteration
    fibonacci              Fibonacci sequence growth

ANALYSIS MODES:
  --analysis, -a <modes>    Analysis types (comma-separated, default: efficiency)
    efficiency             Calculate optimal logs/ms ratio
    correlation            Statistical correlation analysis
    trends                 Live trend analysis during run
    truncation             Detect 10k log limit hits
    all                    Enable all analysis modes

OPTIONS:
  --initialRange, -i <n>    Initial block range (default: 50)
  --increment, -n <n>       Range increment (default: 10)
  --maxTests, -m <n>        Maximum test iterations (default: 50)
  --delay, -d <ms>          Delay between requests (default: 1000)
  --startBlock, -b <n>      Starting block number (for forward mode)
  --endBlock, -e <n>        Ending block number (for fixed mode)
  --outputFormat, -o <fmt>  Output format: table, json, csv (default: table)
  --verbose, -v             Verbose output
  --help, -h                Show this help message

EXAMPLES FOR POPULAR NETWORKS:

  # Ethereum Mainnet - USDC Contract
  node stress-test.js -r https://eth-mainnet.g.alchemy.com/v2/YOUR-KEY -c 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48

  # Polygon - MATIC Token
  node stress-test.js -r https://polygon-rpc.com -c 0x0000000000000000000000000000000000001010 -a all

  # Arbitrum - GMX Token with correlation analysis
  node stress-test.js -r https://arb1.arbitrum.io/rpc -c 0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a -a correlation,efficiency

  # BSC - PancakeSwap with exponential growth
  node stress-test.js -r https://bsc-dataseed.binance.org -c 0x10ED43C718714eb63d5aA57B78B54704E256024E -g exponential

  # Avalanche - AVAX with trend analysis
  node stress-test.js -r https://api.avax.network/ext/bc/C/rpc -c 0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7 -a trends

  # Base - Forward scan from specific block
  node stress-test.js -r https://mainnet.base.org -c 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 -s forward -b 1000000

  # QuickNode endpoint example (works with any EVM chain)
  node stress-test.js -r https://YOUR-ENDPOINT.quiknode.pro/YOUR-KEY -c 0xYourContract -m 100 -d 500
  `);
}

function analyzeTrends() {
  if (!config.analysis.includes("trends") && !config.analysis.includes("all")) return;
  if (metrics.length < 2) return;

  console.log("\n Live Trend Analysis");
  console.log("=".repeat(50));

  const validMetrics = metrics.filter((m) => m.logsCount > 0);
  if (validMetrics.length < 2) {
    console.log("Insufficient data for trend analysis");
    return;
  }

  const avgResponseTime = validMetrics.reduce((a, m) => a + m.responseTime, 0) / validMetrics.length;
  const avgLogsPerMs = validMetrics.reduce((a, m) => a + m.logsPerMs, 0) / validMetrics.length;

  console.log(`Average Response Time: ${avgResponseTime.toFixed(2)}ms`);
  console.log(`Average Logs/ms: ${avgLogsPerMs.toFixed(3)}`);

  const lastFive = validMetrics.slice(-5);
  const trend = lastFive[lastFive.length - 1].logsPerMs - lastFive[0].logsPerMs;
  console.log(`Recent Trend: ${trend > 0 ? " Improving" : trend < 0 ? " Degrading" : " Stable"}`);
}

function analyzeEfficiency() {
  if (!config.analysis.includes("efficiency") && !config.analysis.includes("all")) return;

  console.log("\n Efficiency Analysis");
  console.log("=".repeat(50));

  const validMetrics = metrics.filter((m) => m.logsCount > 0);
  if (validMetrics.length === 0) {
    console.log("No valid data for efficiency analysis");
    return;
  }

  const bestEfficiency = validMetrics.reduce((best, m) => (m.logsPerMs > best.logsPerMs ? m : best));
  const worstEfficiency = validMetrics.reduce((worst, m) => (m.logsPerMs < worst.logsPerMs ? m : worst));

  console.log(`\nBest Efficiency: ${bestEfficiency.logsPerMs.toFixed(3)} logs/ms`);
  console.log(`  Range: ${bestEfficiency.rangeSize} blocks`);
  console.log(`  Retrieved: ${bestEfficiency.logsCount} logs in ${bestEfficiency.responseTime}ms`);

  console.log(`\nWorst Efficiency: ${worstEfficiency.logsPerMs.toFixed(3)} logs/ms`);
  console.log(`  Range: ${worstEfficiency.rangeSize} blocks`);
  console.log(`  Retrieved: ${worstEfficiency.logsCount} logs in ${worstEfficiency.responseTime}ms`);

  const avgEfficiency = validMetrics.reduce((sum, m) => sum + m.logsPerMs, 0) / validMetrics.length;
  console.log(`\nAverage Efficiency: ${avgEfficiency.toFixed(3)} logs/ms`);
}

function analyzeCorrelations() {
  if (!config.analysis.includes("correlation") && !config.analysis.includes("all")) return;

  console.log("\n Correlation Analysis");
  console.log("=".repeat(50));

  const validMetrics = metrics.filter((m) => m.logsCount > 0);
  if (validMetrics.length < 3) {
    console.log("Insufficient data for correlation analysis (need at least 3 data points)");
    return;
  }

  const rangeToTime = calculateCorrelation(
    validMetrics.map((m) => m.rangeSize),
    validMetrics.map((m) => m.responseTime)
  );
  const rangeToLogs = calculateCorrelation(
    validMetrics.map((m) => m.rangeSize),
    validMetrics.map((m) => m.logsCount)
  );
  const logsToTime = calculateCorrelation(
    validMetrics.map((m) => m.logsCount),
    validMetrics.map((m) => m.responseTime)
  );

  console.log(`Range Size  Response Time: ${rangeToTime.toFixed(3)}`);
  console.log(`Range Size  Log Count: ${rangeToLogs.toFixed(3)}`);
  console.log(`Log Count  Response Time: ${logsToTime.toFixed(3)}`);

  if (Math.abs(rangeToTime) > 0.7) {
    console.log(`\n Strong correlation between range and response time detected`);
    console.log(`  Consider ${rangeToTime > 0 ? "smaller" : "different"} range sizes for better performance`);
  }
}

function analyzeTruncation() {
  if (!config.analysis.includes("truncation") && !config.analysis.includes("all")) return;

  console.log("\n Truncation Detection");
  console.log("=".repeat(50));

  const truncated = metrics.filter((m) => m.logsCount === 10000);
  if (truncated.length === 0) {
    console.log("No truncation detected (no queries returned exactly 10000 logs)");
    return;
  }

  console.log(` Potential truncation detected in ${truncated.length} queries:`);
  truncated.forEach((m) => {
    console.log(`  Range: ${m.rangeSize} blocks, Time: ${m.responseTime}ms, Size: ${formatBytes(m.responseSize)}`);
  });

  const minRange = Math.min(...truncated.map((m) => m.rangeSize));
  console.log(`\nSmallest range with truncation: ${minRange} blocks`);
  console.log("Consider using ranges smaller than this to avoid truncation");
}

function performFinalAnalysis() {
  console.log("\n" + "=".repeat(60));
  console.log(" ".repeat(20) + "FINAL ANALYSIS");
  console.log("=".repeat(60));

  const validMetrics = metrics.filter((m) => m.logsCount > 0);
  console.log(`\n Summary Statistics:`);
  console.log(`Total Queries: ${metrics.length}`);
  console.log(`Queries with Logs: ${validMetrics.length}`);
  console.log(`Empty Responses: ${metrics.length - validMetrics.length}`);

  if (validMetrics.length > 0) {
    const totalLogs = validMetrics.reduce((sum, m) => sum + m.logsCount, 0);
    const totalTime = validMetrics.reduce((sum, m) => sum + m.responseTime, 0);
    const totalSize = validMetrics.reduce((sum, m) => sum + m.responseSize, 0);

    console.log(`\nTotal Logs Retrieved: ${totalLogs}`);
    console.log(`Total Response Time: ${totalTime}ms`);
    console.log(`Total Data Transferred: ${formatBytes(totalSize)}`);
    console.log(`Average Response Time: ${(totalTime / validMetrics.length).toFixed(2)}ms`);
    console.log(`Average Logs per Query: ${(totalLogs / validMetrics.length).toFixed(2)}`);
  }

  analyzeEfficiency();
  analyzeCorrelations();
  analyzeTruncation();
}

function getNextRange(currentRange) {
  switch (config.growthMode) {
    case "exponential":
      return currentRange * 2;
    case "fibonacci":
      if (testCount === 0) return config.initialRange;
      if (testCount === 1) return config.initialRange + config.increment;
      const prev2 = metrics[metrics.length - 2]?.rangeSize || config.initialRange;
      const prev1 = metrics[metrics.length - 1]?.rangeSize || config.initialRange;
      return prev2 + prev1;
    case "linear":
    default:
      return currentRange + config.increment;
  }
}

async function runTest() {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  
  if (config.verbose) {
    console.log("\n Starting Stress Test");
    console.log("Configuration:", JSON.stringify(config, null, 2));
  }

  try {
    const latestBlock = await provider.getBlockNumber();
    console.log(`\n Latest block: ${latestBlock} (0x${latestBlock.toString(16)})`);

    let currentRange = config.initialRange;
    let fromBlock, toBlock;
    
    const fixedEndBlock = config.endBlock || latestBlock;
    const startBlock = config.startBlock || 0;

    if (config.outputFormat === "table") {
      console.log("\n" + padString("Block Range", 20) + padString("Time", 8) + padString("Logs", 8) + 
                  padString("Size", 10) + padString("B/ms", 8) + padString("Logs/ms", 10) + 
                  padString("KB/Log", 8) + "Range");
      console.log("=".repeat(80));
    }

    while (testCount < config.maxTests) {
      switch (config.scanMode) {
        case "forward":
          fromBlock = startBlock + testCount * currentRange;
          toBlock = fromBlock + currentRange;
          if (fromBlock > latestBlock) {
            console.log("\nReached latest block, stopping");
            break;
          }
          break;
        case "fixed":
          toBlock = fixedEndBlock;
          fromBlock = Math.max(0, toBlock - currentRange);
          if (currentRange > toBlock) {
            console.log("\nRange exceeds available blocks, stopping");
            testCount = config.maxTests;
          }
          break;
        case "backward":
        default:
          toBlock = latestBlock - (testCount * currentRange);
          fromBlock = Math.max(0, toBlock - currentRange);
          if (toBlock <= 0) {
            console.log("\nReached genesis block, stopping");
            testCount = config.maxTests;
          }
          break;
      }

      if (testCount >= config.maxTests || fromBlock > latestBlock || toBlock <= 0) break;

      try {
        const startTime = Date.now();
        const filter = {
          fromBlock,
          toBlock,
          address: config.contractAddress,
        };

        const logs = await provider.getLogs(filter);
        const endTime = Date.now();
        const responseTime = endTime - startTime;
        const logsCount = logs.length;
        const responseSize = getResponseSize(logs);

        const bytesPerMs = responseSize / responseTime;
        const logsPerMs = logsCount / responseTime;
        const kbPerLog = logsCount > 0 ? (responseSize / 1024) / logsCount : 0;

        metrics.push({
          rangeSize: toBlock - fromBlock,
          fromBlock,
          toBlock,
          responseTime,
          logsCount,
          responseSize,
          bytesPerMs,
          logsPerMs,
          kbPerLog,
        });

        if (config.outputFormat === "table") {
          const rangeDisplay = `${fromBlock.toString(16)}-${toBlock.toString(16)}`;
          console.log(
            padString(rangeDisplay, 20) +
            padString(responseTime.toString(), 8) +
            padString(logsCount.toString(), 8) +
            padString(formatBytes(responseSize), 10) +
            padString(bytesPerMs.toFixed(1), 8) +
            padString(logsPerMs.toFixed(3), 10) +
            padString(kbPerLog > 0 ? kbPerLog.toFixed(2) : "N/A", 8) +
            currentRange
          );
        } else if (config.outputFormat === "json") {
          console.log(JSON.stringify({
            test: testCount + 1,
            fromBlock,
            toBlock,
            rangeSize: toBlock - fromBlock,
            responseTime,
            logsCount,
            responseSize,
            bytesPerMs,
            logsPerMs,
            kbPerLog,
          }));
        } else if (config.outputFormat === "csv") {
          if (testCount === 0) {
            console.log("test,fromBlock,toBlock,rangeSize,responseTime,logsCount,responseSize,bytesPerMs,logsPerMs,kbPerLog");
          }
          console.log(`${testCount + 1},${fromBlock},${toBlock},${toBlock - fromBlock},${responseTime},${logsCount},${responseSize},${bytesPerMs.toFixed(2)},${logsPerMs.toFixed(3)},${kbPerLog.toFixed(2)}`);
        }

        if (logsCount === 10000) {
          console.log(`\n Hit 10000 log limit at range ${currentRange}`);
        }

        if ((config.analysis.includes("trends") || config.analysis.includes("all")) && 
            testCount > 0 && testCount % 10 === 0) {
          analyzeTrends();
        }

      } catch (error) {
        console.log(`\n Error at range ${currentRange}: ${error.message}`);
        if (config.verbose) {
          console.error(error);
        }
      }

      currentRange = getNextRange(currentRange);
      testCount++;

      if (testCount < config.maxTests) {
        await new Promise((resolve) => setTimeout(resolve, config.delay));
      }
    }

    performFinalAnalysis();

  } catch (error) {
    console.error("\n Failed to initialize:", error.message);
    if (config.verbose) {
      console.error(error);
    }
    process.exit(1);
  }
}

runTest();