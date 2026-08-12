import { ethers } from "ethers";

// Replace with your Ethereum node URL
const ETH_NODE_URL = "https://evm-rpc.sei.basementnodes.ca";
const CONTRACT_ADDRESS = "0x709944a48caf83535e43471680fda4905fb3920a";

const provider = new ethers.JsonRpcProvider(ETH_NODE_URL);

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

async function testEthGetLogs(initialIncrement = 50, maxTests = 50) {
    try {
        // Get the latest block number first
        const latestBlock = await provider.getBlockNumber();
        console.log(`Latest block: ${latestBlock}`);

        let currentBlock = latestBlock;
        let increment = initialIncrement;
        let testCount = 0;

        console.log("\nBlock Range | Time (ms) | Logs Count | Size | B/ms | Logs/ms | KB/Log");
        console.log("-".repeat(90));

        while (testCount < maxTests && currentBlock > 0) {
            const fromBlock = Math.max(0, currentBlock - increment);
            const blockRangeDiff = currentBlock - fromBlock;

            try {
                const startTime = Date.now();

                const filter = {
                    fromBlock: fromBlock,
                    toBlock: currentBlock,
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

                // Log current test results with hex block numbers
                console.log(
                    `${fromBlock.toString(16)}-${currentBlock.toString(16)}`.padEnd(12),
                            `| ${responseTime}`.padEnd(10),
                            `| ${logsCount}`.padEnd(12),
                            `| ${formatBytes(responseSize)}`.padEnd(10),
                            `| ${bytesPerMs}`.padEnd(8),
                            `| ${logsPerMs}`.padEnd(10),
                            `| ${kbPerLog}`
                );

                // If we hit exactly 10000 logs, this might indicate truncation
                if (logsCount === 10000) {
                    console.log(`\nPossible truncation detected at range ${blockRangeDiff} blocks`);
                    console.log(`Response size: ${formatBytes(responseSize)}`);
                }

                // If we exceed 2000 blocks, log a warning
                if (blockRangeDiff > 2000) {
                    console.log(`\nWarning: Query range (${blockRangeDiff}) exceeds recommended 2000 block limit`);
                }

                // Move backwards and increase range
                currentBlock = fromBlock - 1;
                increment = Math.min(increment * 2, 10000); // Cap at 10000 blocks
                testCount++;

            } catch (error) {
                console.log("\nError occurred during testing:");
                console.log(`Block range: ${fromBlock}-${currentBlock} (${blockRangeDiff} blocks)`);
                console.log(`Error: ${error.message}`);

                // On error, reduce the increment and try again
                increment = Math.max(Math.floor(increment / 2), initialIncrement);
                console.log(`Reducing increment to ${increment} blocks`);

                if (error.code === ethers.errors.TIMEOUT) {
                    break;
                }
            }

            // Add a small delay between requests
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

    } catch (error) {
        console.error("Failed to get latest block:");
        console.error(error);
        process.exit(1);
    }
}

// Start with 50 block increment, max 50 tests
testEthGetLogs(50, 50);
