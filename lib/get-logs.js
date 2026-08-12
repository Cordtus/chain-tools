/**
 * Truncation-safe eth_getLogs fetcher.
 *
 * eth_getLogs silently truncates at 10,000 logs per query. This module
 * recursively binary-splits any block range that returns exactly the limit
 * so callers receive the complete log set. Extracted from the legacy
 * getLogs_wrapper.js one-off so it can be reused by any tool.
 */

import { ethers } from 'ethers';

const DEFAULT_MAX_LOGS = 10000;

/**
 * Fetch all logs for a filter, splitting ranges that hit the log limit.
 *
 * @param {ethers.Provider} provider - Ethers v6 provider.
 * @param {object} filter - eth_getLogs filter ({address, topics, fromBlock, toBlock}).
 * @param {object} [options]
 * @param {number} [options.maxLogs=10000] - Query result truncation limit.
 * @param {number} [options.maxBatchSize=2000] - Largest block range in a single query.
 * @param {(msg: string) => void} [options.onDebug] - Optional debug logger.
 * @returns {Promise<object[]>} Aggregated logs for the full range.
 */
export async function fetchLogs(provider, filter, options = {}) {
    const { maxLogs = DEFAULT_MAX_LOGS, maxBatchSize = 2000, onDebug } = options;
    const debug = onDebug || (() => {});

    const fetchRange = async (startBlock, endBlock) => {
        const batchEnd = Math.min(startBlock + maxBatchSize - 1, endBlock);
        debug(`Querying block range: ${startBlock} to ${batchEnd}`);

        const logs = await provider.getLogs({
            ...filter,
            fromBlock: startBlock,
            toBlock: batchEnd,
        });

        let aggregated = [...logs];
        if (logs.length === maxLogs) {
            debug(`Exactly ${maxLogs} logs returned for range ${startBlock} to ${batchEnd}. Splitting further.`);
            const midpoint = Math.floor((startBlock + batchEnd) / 2);
            aggregated = [
                ...aggregated,
                ...(await fetchRange(startBlock, midpoint)),
                ...(await fetchRange(midpoint + 1, batchEnd)),
            ];
        }

        if (batchEnd < endBlock) {
            aggregated = [...aggregated, ...(await fetchRange(batchEnd + 1, endBlock))];
        }

        return aggregated;
    };

    return fetchRange(filter.fromBlock, filter.toBlock);
}
