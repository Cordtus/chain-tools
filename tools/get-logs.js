#!/usr/bin/env node
/**
 * CLI wrapper for the truncation-safe eth_getLogs fetcher.
 *
 * Fetches all logs in a block range, binary-splitting any sub-range that
 * returns exactly the 10,000-log limit. Output is JSON to stdout.
 *
 * Usage:
 *   node tools/get-logs.js -r <RPC_URL> -c <CONTRACT> -b <start> -e <end> [--topics t1,t2] [--debug]
 */
import { ethers } from 'ethers';
import { parseArgs } from 'util';
import { fetchLogs } from '../lib/get-logs.js';

const args = parseArgs({
    args: process.argv.slice(2),
    options: {
        rpcUrl: { type: 'string', short: 'r' },
        contractAddress: { type: 'string', short: 'c' },
        startBlock: { type: 'string', short: 'b' },
        endBlock: { type: 'string', short: 'e' },
        topics: { type: 'string', short: 't' },
        debug: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
    },
    strict: false,
});

if (args.values.help || !args.values.rpcUrl || !args.values.startBlock || !args.values.endBlock) {
    console.log(`
Fetch all logs for a block range without hitting the 10,000-log truncation limit.

Usage: node tools/get-logs.js -r <RPC_URL> -c <CONTRACT> -b <start> -e <end> [--topics t1,t2]

Options:
  -r, --rpcUrl <url>      RPC endpoint (required)
  -c, --contractAddress   Contract address filter (optional)
  -b, --startBlock <n>    First block (required)
  -e, --endBlock <n>      Last block (required)
  -t, --topics <list>     Comma-separated topic0 hashes (optional)
      --debug             Log each sub-range query
  -h, --help              Show this help

Example:
  node tools/get-logs.js -r http://localhost:8545 -c 0xAbc... -b 100 -e 200
`);
    process.exit(args.values.help ? 0 : 1);
}

const provider = new ethers.JsonRpcProvider(args.values.rpcUrl);
const filter = {
    fromBlock: parseInt(args.values.startBlock),
    toBlock: parseInt(args.values.endBlock),
};
if (args.values.contractAddress) filter.address = args.values.contractAddress;
if (args.values.topics) filter.topics = args.values.topics.split(',');

const logs = await fetchLogs(provider, filter, {
    onDebug: args.values.debug ? (msg) => console.error(msg) : undefined,
});

console.log(JSON.stringify({ count: logs.length, logs }, null, 2));
