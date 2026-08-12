import { ethers } from "ethers";

// Replace with your Ethereum node URL
const ETH_NODE_URL = "https://evm-rpc.sei.basementnodes.ca";

// Replace with your contract address
const CONTRACT_ADDRESS = "0x709944a48caf83535e43471680fda4905fb3920a";

// Initialize ethers.js provider
const provider = new ethers.JsonRpcProvider(ETH_NODE_URL);

// Store metrics for analysis
const metrics = [];

function getResponseSize(logs) {
  return Buffer.byteLength(JSON.stringify(logs), 'utf8');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

async function testEthGetLogs(startBlock, initialIncrement, maxTests = 50) {
  let currentBlock = startBlock;
  let increment = initialIncrement;
  let testCount = 0;

  console.log("Block Range | Time (ms) | Logs Count | Size | B/ms | Logs/ms | KB/Log");
  console.log("-".repeat(90));

  while (testCount < maxTests) {
    const toBlock = currentBlock + increment;
    const blockRangeDiff = toBlock - currentBlock;

    try {
      const startTime = Date.now();

      const filter = {
        fromBlock: currentBlock,
        toBlock: toBlock,
        address: CONTRACT_ADDRESS
      };

      // Fetch logs within the specified block range
      const logs = await provider.getLogs(filter);

      const endTime = Date.now();
      const responseTime = endTime - startTime;
      const logsCount = logs.length;
      const responseSize = getResponseSize(logs);

      // Calculate metrics
      const bytesPerMs = (responseSize / responseTime).toFixed(1);
      const logsPerMs = (logsCount / responseTime).toFixed(3);
      const kbPerLog = logsCount > 0 ? ((responseSize / 1024) / logsCount).toFixed(2) : 'N/A';

      // Store metrics for later analysis
      metrics.push({
        blockRange: blockRangeDiff,
        responseTime,
        logsCount,
        responseSize,
        bytesPerMs: parseFloat(bytesPerMs),
                   logsPerMs: parseFloat(logsPerMs),
                   kbPerLog: kbPerLog !== 'N/A' ? parseFloat(kbPerLog) : null
      });

      // Log current test results
      console.log(
        `${currentBlock}-${toBlock}`.padEnd(12),
                  `| ${responseTime}`.padEnd(10),
                  `| ${logsCount}`.padEnd(12),
                  `| ${formatBytes(responseSize)}`.padEnd(10),
                  `| ${bytesPerMs}`.padEnd(8),
                  `| ${logsPerMs}`.padEnd(10),
                  `| ${kbPerLog}`
      );

      // If we hit exactly 10000 logs, this might indicate truncation
      if (logsCount === 10000) {
        console.log("\nPossible truncation detected - exactly 10000 logs returned");
        console.log(`Response size: ${formatBytes(responseSize)}`);
      }

      // If we exceed 2000 blocks, log a warning
      if (blockRangeDiff > 2000) {
        console.log(`\nWarning: Query range (${blockRangeDiff}) exceeds recommended 2000 block limit`);
      }

      currentBlock = toBlock + 1;
      increment += 50;
      testCount++;

      // Every 10 tests, display trend analysis
      if (testCount % 10 === 0) {
        analyzeTrends();
      }

    } catch (error) {
      console.log("\nError occurred during testing:");
      if (error.code === ethers.errors.TIMEOUT) {
        console.log(`Timeout at block range ${currentBlock}-${toBlock} (${blockRangeDiff} blocks)`);
      } else {
        console.log(`Error: ${error.message}`);
        console.log(`At block range: ${currentBlock}-${toBlock} (${blockRangeDiff} blocks)`);
      }
      analyzeTrends();
      process.exit(1);
    }

    // Add a small delay between requests
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  // Final analysis
  analyzeTrends();
}

function analyzeTrends() {
  if (metrics.length < 2) return;

  console.log("\nTrend Analysis:");
  console.log("-".repeat(50));

  // Calculate correlations
  const blockRangeToBytes = calculateCorrelation(
    metrics.map(m => m.blockRange),
                                                 metrics.map(m => m.bytesPerMs)
  );

  const blockRangeToLogs = calculateCorrelation(
    metrics.map(m => m.blockRange),
                                                metrics.map(m => m.logsPerMs)
  );

  const sizeToTime = calculateCorrelation(
    metrics.map(m => m.responseSize),
                                          metrics.map(m => m.responseTime)
  );

  console.log(`Correlation between block range and bytes/ms: ${blockRangeToBytes.toFixed(3)}`);
  console.log(`Correlation between block range and logs/ms: ${blockRangeToLogs.toFixed(3)}`);
  console.log(`Correlation between response size and time: ${sizeToTime.toFixed(3)}`);

  // Average KB per log over time
  const avgKbPerLog = average(metrics.map(m => m.kbPerLog).filter(v => v !== null));
  console.log(`Average KB per log: ${avgKbPerLog.toFixed(2)}`);

  // Report on any 10000-log responses
  const truncatedResponses = metrics.filter(m => m.logsCount === 10000);
  if (truncatedResponses.length > 0) {
    console.log(`\nPossible truncated responses: ${truncatedResponses.length}`);
    console.log("Responses with exactly 10000 logs:");
    truncatedResponses.forEach(m => {
      console.log(`- Range: ${m.blockRange} blocks, Size: ${formatBytes(m.responseSize)}, Time: ${m.responseTime}ms`);
    });
  }
}

function calculateCorrelation(x, y) {
  const n = x.length;
  const sum1 = sum(x);
  const sum2 = sum(y);
  const sum1sq = sum(x.map(x => x * x));
  const sum2sq = sum(y.map(y => y * y));
  const pSum = sum(x.map((x, i) => x * y[i]));
  const num = pSum - (sum1 * sum2 / n);
  const den = Math.sqrt((sum1sq - sum1 * sum1 / n) * (sum2sq - sum2 * sum2 / n));
  return num / den;
}

function sum(array) {
  return array.reduce((a, b) => a + b, 0);
}

function average(array) {
  return array.reduce((a, b) => a + b, 0) / array.length;
}

// Example usage
const startBlock = 107432958;
const initialIncrement = 50;
const maxTests = 50;  // Limit the number of tests to run

testEthGetLogs(startBlock, initialIncrement, maxTests);
