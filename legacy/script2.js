import { ethers } from "ethers";

// Configuration
const ETH_NODE_URL = "https://evm-rpc.sei.basementnodes.ca";
const CONTRACT_ADDRESS = "0x709944a48caf83535e43471680fda4905fb3920a";
const INITIAL_BLOCK_RANGE = 500;
const RANGE_INCREMENT = 50;
const MAX_TESTS = 50;

// Store metrics for final analysis
const metrics = [];

function getResponseSize(logs) {
  return Buffer.byteLength(JSON.stringify(logs), 'utf8');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function padString(str, length) {
  return String(str).padEnd(length);
}

function analyzeResults(metrics) {
  console.log("\nPerformance Analysis");
  console.log("=".repeat(50));

  const queriesWithLogs = metrics.filter(m => m.logsCount > 0);
  const totalQueries = metrics.length;

  console.log(`\nGeneral Statistics:`);
  console.log(`Total Queries Run: ${totalQueries}`);
  console.log(`Queries with Logs: ${queriesWithLogs.length}`);
  console.log(`Empty Responses: ${totalQueries - queriesWithLogs.length}`);

  if (queriesWithLogs.length > 0) {
    // Calculate correlations
    const rangeToTime = calculateCorrelation(
      queriesWithLogs.map(m => m.rangeSize),
                                             queriesWithLogs.map(m => m.responseTime)
    );
    const rangeToLogs = calculateCorrelation(
      queriesWithLogs.map(m => m.rangeSize),
                                             queriesWithLogs.map(m => m.logsCount)
    );

    console.log(`\nCorrelations:`);
    console.log(`Range Size to Response Time: ${rangeToTime.toFixed(3)}`);
    console.log(`Range Size to Log Count: ${rangeToLogs.toFixed(3)}`);

    // Performance metrics
    const avgResponseTime = queriesWithLogs.reduce((acc, m) => acc + m.responseTime, 0) / queriesWithLogs.length;
    const avgLogsPerQuery = queriesWithLogs.reduce((acc, m) => acc + m.logsCount, 0) / queriesWithLogs.length;
    const maxLogs = Math.max(...queriesWithLogs.map(m => m.logsCount));
    const maxLogsQuery = queriesWithLogs.find(m => m.logsCount === maxLogs);

    console.log(`\nPerformance Metrics:`);
    console.log(`Average Response Time: ${avgResponseTime.toFixed(2)}ms`);
    console.log(`Average Logs per Query: ${avgLogsPerQuery.toFixed(2)}`);
    console.log(`Maximum Logs in Single Query: ${maxLogs}`);
    if (maxLogsQuery) {
      console.log(`- At Range Size: ${maxLogsQuery.rangeSize} blocks`);
      console.log(`- Response Time: ${maxLogsQuery.responseTime}ms`);
      console.log(`- Efficiency: ${maxLogsQuery.logsPerMs.toFixed(3)} logs/ms`);
    }

    // Look for potential truncation patterns
    const truncatedQueries = queriesWithLogs.filter(m => m.logsCount === 10000);
    if (truncatedQueries.length > 0) {
      console.log(`\nPotential Truncation Detected:`);
      console.log(`Queries hitting 10000 log limit: ${truncatedQueries.length}`);
      console.log(`Range sizes with truncation: ${truncatedQueries.map(m => m.rangeSize).join(', ')}`);
    }
  }
}

function calculateCorrelation(x, y) {
  const n = x.length;
  const sum1 = x.reduce((a, b) => a + b, 0);
  const sum2 = y.reduce((a, b) => a + b, 0);
  const sum1sq = x.reduce((a, b) => a + (b * b), 0);
  const sum2sq = y.reduce((a, b) => a + (b * b), 0);
  const pSum = x.reduce((a, b, i) => a + (b * y[i]), 0);
  const num = pSum - (sum1 * sum2 / n);
  const den = Math.sqrt((sum1sq - sum1 * sum1 / n) * (sum2sq - sum2 * sum2 / n));
  return num / den;
}

async function testEthGetLogs() {
  const provider = new ethers.JsonRpcProvider(ETH_NODE_URL);

  try {
    // Get latest block and use it as our fixed endpoint
    const fixedToBlock = await provider.getBlockNumber();
    console.log(`Fixed end block: ${fixedToBlock} (0x${fixedToBlock.toString(16)})`);

    let currentRange = INITIAL_BLOCK_RANGE;
    let testCount = 0;

    // Column headers with fixed widths
    console.log("\nBlock Range         Time  Logs    Size     B/ms   Logs/ms  KB/Log  Range");
    console.log("=".repeat(80));

    while (testCount < MAX_TESTS) {
      const fromBlock = fixedToBlock - currentRange;
      if (fromBlock < 0) break;

      try {
        const startTime = Date.now();
        const filter = {
          fromBlock: fromBlock,
          toBlock: fixedToBlock,
          address: CONTRACT_ADDRESS
        };

        const logs = await provider.getLogs(filter);

        const endTime = Date.now();
        const responseTime = endTime - startTime;
        const logsCount = logs.length;
        const responseSize = getResponseSize(logs);

        // Calculate metrics
        const bytesPerMs = (responseSize / responseTime).toFixed(1);
        const logsPerMs = (logsCount / responseTime).toFixed(3);
        const kbPerLog = logsCount > 0 ? ((responseSize / 1024) / logsCount).toFixed(2) : 'N/A';

        // Store metrics for analysis
        metrics.push({
          rangeSize: currentRange,
          responseTime,
          logsCount,
          responseSize,
          bytesPerMs: parseFloat(bytesPerMs),
                     logsPerMs: parseFloat(logsPerMs),
                     kbPerLog: kbPerLog !== 'N/A' ? parseFloat(kbPerLog) : 0
        });

        // Format block range
        const rangeDisplay = `${fromBlock.toString(16)}-${fixedToBlock.toString(16)}`;

        // Log with fixed column widths
        console.log(
          padString(rangeDisplay, 17) +
          padString(responseTime, 6) +
          padString(logsCount, 8) +
          padString(formatBytes(responseSize), 9) +
          padString(bytesPerMs, 8) +
          padString(logsPerMs, 9) +
          padString(kbPerLog, 8) +
          currentRange
        );

        if (logsCount === 10000) {
          console.log(`\nWarning: Hit 10000 log limit at range ${currentRange}`);
        }

        currentRange += RANGE_INCREMENT;
        testCount++;

      } catch (error) {
        console.log(`Error at range ${currentRange}: ${error.message}`);
        process.exit(1);
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Perform final analysis
    analyzeResults(metrics);

  } catch (error) {
    console.error("Failed to initialize or get latest block:", error);
    process.exit(1);
  }
}

// Run the test
testEthGetLogs();
