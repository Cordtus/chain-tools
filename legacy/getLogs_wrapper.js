import { ethers } from "ethers";
import fs from "fs";

// Replace with your Ethereum node URL and contract address
const ETH_NODE_URL = "https://evm.sei-main-eu.ccvalidators.com:443";
const CONTRACT_ADDRESS = "0xe8eae1aaB1b4BBa29eAbaEfe7df4510833b6491e";

const provider = new ethers.JsonRpcProvider(ETH_NODE_URL);

async function fetchLogs(startBlock, endBlock, logLevel = "INFO") {
    let currentBlock = startBlock;
    const maxBatchSize = 2000;
    const maxLogs = 10000;
    let aggregatedLogs = [];
    const debugFile = "debug_output.json";

    // Function to log messages based on log level
    const log = (level, message) => {
        if (level === "DEBUG" || logLevel === "DEBUG") console.log(message);
    };

        while (currentBlock <= endBlock) {
            const batchEnd = Math.min(currentBlock + maxBatchSize - 1, endBlock);
            log("DEBUG", `Querying block range: ${currentBlock} to ${batchEnd}`);

            try {
                const filter = {
                    fromBlock: currentBlock,
                    toBlock: batchEnd,
                    address: CONTRACT_ADDRESS,
                };

                const logs = await provider.getLogs(filter);
                aggregatedLogs.push(...logs);

                log("INFO", `Fetched logs for range ${currentBlock} to ${batchEnd}, count: ${logs.length}`);

                if (logs.length === maxLogs) {
                    log(
                        "DEBUG",
                        `Exactly ${maxLogs} logs returned for range ${currentBlock} to ${batchEnd}. Splitting further.`
                    );
                    // Recursively split the range into smaller parts
                    const midpoint = Math.floor((currentBlock + batchEnd) / 2);
                    aggregatedLogs.push(...await fetchLogs(currentBlock, midpoint, logLevel));
                    aggregatedLogs.push(...await fetchLogs(midpoint + 1, batchEnd, logLevel));
                }

                currentBlock = batchEnd + 1; // Move to the next range
            } catch (error) {
                console.error(`Error fetching logs for range ${currentBlock} to ${batchEnd}: ${error.message}`);
                process.exit(1);
            }
        }

        if (logLevel === "DEBUG") {
            log("DEBUG", "Writing detailed logs to file.");
            fs.writeFileSync(debugFile, JSON.stringify(aggregatedLogs, null, 2));
        }

        return aggregatedLogs;
}

// Example usage
const startBlock = 107432958; // Replace with your start block
const endBlock = 107433958; // Replace with your end block
const logLevel = "DEBUG"; // Set to "INFO" or "DEBUG"

(async () => {
    const logs = await fetchLogs(startBlock, endBlock, logLevel);
    if (logLevel === "INFO") {
        console.log(JSON.stringify(logs)); // Output aggregated logs to console
    }
})();
