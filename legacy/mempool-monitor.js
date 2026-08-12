import { ethers } from 'ethers';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

class MempoolMonitor {
    constructor() {
        this.evmRpcUrl = process.env.RPC_URL || 'http://localhost:8545';
        this.cosmosRpcUrl = process.env.COSMOS_RPC_URL || 'http://localhost:26657';
        this.cosmosRestUrl = process.env.COSMOS_REST_URL || 'http://localhost:1317';
        this.evmProvider = new ethers.JsonRpcProvider(this.evmRpcUrl);
        
        this.metrics = {
            evm: {
                pendingTxs: 0,
                blockNumber: 0,
                gasPrice: '0',
                baseFee: '0',
                pendingTxHashes: []
            },
            cosmos: {
                pendingTxs: 0,
                blockHeight: 0,
                totalTxs: 0,
                proposer: ''
            },
            timestamp: Date.now()
        };
        
        this.history = {
            evmPending: [],
            cosmosPending: [],
            maxHistory: 60 // Keep 60 data points
        };
        
        this.testLogs = [];
        this.maxLogs = 8; // Fixed number of log lines
        this.logFile = path.join(process.cwd(), 'test-logs.json');
        this.lastLogCheck = 0;
    }
    
    loadTestLogs() {
        try {
            if (fs.existsSync(this.logFile)) {
                const stat = fs.statSync(this.logFile);
                if (stat.mtime.getTime() > this.lastLogCheck) {
                    const logs = JSON.parse(fs.readFileSync(this.logFile, 'utf8'));
                    this.testLogs = logs.slice(-this.maxLogs);
                    this.lastLogCheck = stat.mtime.getTime();
                }
            }
        } catch (error) {
            // Keep existing logs if file read fails
        }
    }
    
    addTestLog(message) {
        const timestamp = new Date().toLocaleTimeString();
        this.testLogs.push({ timestamp, message });
        if (this.testLogs.length > this.maxLogs) {
            this.testLogs.shift();
        }
    }
    
    async getEvmMempoolInfo() {
        try {
            // Get EVM app-side mempool status using txpool_status
            const txpoolStatus = await this.evmProvider.send('txpool_status', []);
            
            // Get current block info
            const block = await this.evmProvider.getBlock('latest');
            const feeData = await this.evmProvider.getFeeData();
            
            // Parse txpool status (hex values)
            const pendingCount = parseInt(txpoolStatus.pending || '0x0', 16);
            const queuedCount = parseInt(txpoolStatus.queued || '0x0', 16);
            
            this.metrics.evm = {
                pendingTxs: pendingCount,
                queuedTxs: queuedCount,
                totalEvmPool: pendingCount + queuedCount,
                blockNumber: block.number,
                gasPrice: ethers.formatUnits(feeData.gasPrice || 0, 'gwei'),
                baseFee: ethers.formatUnits(feeData.baseFeePerGas || 0, 'gwei'),
                blockGasUsed: block.gasUsed.toString(),
                blockGasLimit: block.gasLimit.toString(),
                blockUtilization: ((block.gasUsed * 100n) / block.gasLimit).toString() + '%'
            };
            
            return this.metrics.evm;
        } catch (error) {
            console.error('EVM mempool error:', error.message);
            // Fallback to old method if txpool not available
            try {
                const pending = await this.evmProvider.send('eth_getBlockTransactionCountByNumber', ['pending']);
                const latest = await this.evmProvider.send('eth_getBlockTransactionCountByNumber', ['latest']);
                const pendingCount = Math.max(0, parseInt(pending, 16) - parseInt(latest, 16));
                
                const block = await this.evmProvider.getBlock('latest');
                const feeData = await this.evmProvider.getFeeData();
                
                this.metrics.evm = {
                    pendingTxs: pendingCount,
                    queuedTxs: 0,
                    totalEvmPool: pendingCount,
                    blockNumber: block.number,
                    gasPrice: ethers.formatUnits(feeData.gasPrice || 0, 'gwei'),
                    baseFee: ethers.formatUnits(feeData.baseFeePerGas || 0, 'gwei'),
                    blockGasUsed: block.gasUsed.toString(),
                    blockGasLimit: block.gasLimit.toString(),
                    blockUtilization: ((block.gasUsed * 100n) / block.gasLimit).toString() + '%'
                };
                
                return this.metrics.evm;
            } catch (fallbackError) {
                console.error('EVM fallback error:', fallbackError.message);
                return null;
            }
        }
    }
    
    async getCosmosMempoolInfo() {
        try {
            // Get mempool info
            const mempoolResponse = await fetch(`${this.cosmosRpcUrl}/num_unconfirmed_txs`);
            const mempoolData = await mempoolResponse.json();
            
            // Get latest block info
            const statusResponse = await fetch(`${this.cosmosRpcUrl}/status`);
            const statusData = await statusResponse.json();
            
            // Get block info
            const blockResponse = await fetch(`${this.cosmosRpcUrl}/block`);
            const blockData = await blockResponse.json();
            
            this.metrics.cosmos = {
                pendingTxs: parseInt(mempoolData.result?.n_txs || '0'),
                blockHeight: parseInt(statusData.result?.sync_info?.latest_block_height || '0'),
                totalTxs: parseInt(mempoolData.result?.total || '0'),
                totalBytes: parseInt(mempoolData.result?.total_bytes || '0'),
                proposer: blockData.result?.block?.header?.proposer_address || '',
                chainId: statusData.result?.node_info?.network || '',
                blockTxCount: blockData.result?.block?.data?.txs?.length || 0
            };
            
            return this.metrics.cosmos;
        } catch (error) {
            console.error('Cosmos mempool error:', error.message);
            return null;
        }
    }
    
    updateHistory() {
        const timestamp = Date.now();
        
        // Add current metrics to history
        this.history.evmPending.push({
            timestamp,
            value: this.metrics.evm.pendingTxs
        });
        
        this.history.cosmosPending.push({
            timestamp,
            value: this.metrics.cosmos.pendingTxs
        });
        
        // Trim history to max size
        if (this.history.evmPending.length > this.history.maxHistory) {
            this.history.evmPending.shift();
        }
        if (this.history.cosmosPending.length > this.history.maxHistory) {
            this.history.cosmosPending.shift();
        }
    }
    
    clearScreen() {
        process.stdout.write('\x1B[2J\x1B[0f');
    }
    
    drawSparkline(data, width = 40) {
        if (data.length < 2) return '▄'.repeat(width);
        
        const values = data.map(d => d.value);
        const max = Math.max(...values);
        const min = Math.min(...values);
        const range = max - min || 1;
        
        const chars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
        
        return data.slice(-width).map(d => {
            const normalized = (d.value - min) / range;
            const charIndex = Math.floor(normalized * (chars.length - 1));
            return chars[charIndex];
        }).join('');
    }
    
    displayDashboard() {
        this.clearScreen();
        
        const now = new Date();
        
        console.log('┌─' + '─'.repeat(76) + '─┐');
        console.log('│' + ' '.repeat(25) + 'DUAL MEMPOOL MONITOR' + ' '.repeat(31) + '│');
        console.log('│' + ' '.repeat(20) + `Cosmos EVM Network - ${now.toLocaleTimeString()}` + ' '.repeat(20) + '│');
        console.log('├─' + '─'.repeat(76) + '─┤');
        
        // EVM Section
        console.log('│ EVM MEMPOOL:' + ' '.repeat(64) + '│');
        const evmTotal = (this.metrics.evm.totalEvmPool || this.metrics.evm.pendingTxs).toString();
        console.log(`│   EVM Pool: ${evmTotal.padEnd(6)} (${this.metrics.evm.pendingTxs} pending${this.metrics.evm.queuedTxs ? `, ${this.metrics.evm.queuedTxs} queued` : ''}) Block: ${this.metrics.evm.blockNumber.toString().padEnd(8)} │`);
        console.log(`│   Gas Price: ${this.metrics.evm.gasPrice.padEnd(12)} gwei   Base Fee: ${this.metrics.evm.baseFee.padEnd(12)} gwei │`);
        console.log(`│   Block Gas Used: ${this.metrics.evm.blockGasUsed?.substring(0,10).padEnd(10)} Utilization: ${this.metrics.evm.blockUtilization?.padEnd(8)} │`);
        console.log(`│   History: ${this.drawSparkline(this.history.evmPending, 50).padEnd(50)} │`);
        console.log('├─' + '─'.repeat(76) + '─┤');
        
        // Cosmos Section
        console.log('│ COSMOS MEMPOOL:' + ' '.repeat(61) + '│');
        console.log(`│   Pending Transactions: ${this.metrics.cosmos.pendingTxs.toString().padEnd(10)} Height: ${this.metrics.cosmos.blockHeight.toString().padEnd(10)} │`);
        console.log(`│   Block Tx Count: ${this.metrics.cosmos.blockTxCount.toString().padEnd(12)} Chain: ${this.metrics.cosmos.chainId.padEnd(15)} │`);
        console.log(`│   Total Bytes: ${this.metrics.cosmos.totalBytes.toString().padEnd(12)} Total Txs: ${this.metrics.cosmos.totalTxs.toString().padEnd(12)} │`);
        console.log(`│   History: ${this.drawSparkline(this.history.cosmosPending, 50).padEnd(50)} │`);
        console.log('├─' + '─'.repeat(76) + '─┤');
        
        // Test logs section
        console.log('├─' + '─'.repeat(76) + '─┤');
        console.log('│ \x1b[33mTEST ACTIVITY:\x1b[0m' + ' '.repeat(58) + '│');
        const recentLogs = this.testLogs.slice(-8); // Show last 8 logs
        
        // Always show exactly 8 lines of logs (persistent display)
        const displayLogs = [...this.testLogs];
        while (displayLogs.length < 8) {
            displayLogs.push({ timestamp: '', message: '' });
        }
        
        displayLogs.slice(0, 8).forEach(log => {
            if (log.message) {
                const logText = `\x1b[36m${log.timestamp}\x1b[0m ${log.message}`;
                const truncated = log.message.length > 60 ? log.message.substring(0, 57) + '...' : log.message;
                const display = `\x1b[36m${log.timestamp}\x1b[0m ${truncated}`;
                console.log(`│ ${display.padEnd(86)} │`);
            } else {
                console.log('│' + ' '.repeat(76) + '│');
            }
        });
        
        // Combined metrics
        const totalPending = this.metrics.evm.pendingTxs + this.metrics.cosmos.pendingTxs;
        console.log('├─' + '─'.repeat(76) + '─┤');
        console.log(`│ COMBINED: ${totalPending} pending txs | EVM: ${this.metrics.evm.pendingTxs} | Cosmos: ${this.metrics.cosmos.pendingTxs}` + ' '.repeat(25) + '│');
        console.log('└─' + '─'.repeat(76) + '─┘');
        
        // Status indicators with colors
        const evmStatus = this.metrics.evm.pendingTxs > 50 ? '\x1b[31m🔴 HIGH\x1b[0m' : this.metrics.evm.pendingTxs > 20 ? '\x1b[33m🟡 MED\x1b[0m' : '\x1b[32m🟢 LOW\x1b[0m';
        const cosmosStatus = this.metrics.cosmos.pendingTxs > 50 ? '\x1b[31m🔴 HIGH\x1b[0m' : this.metrics.cosmos.pendingTxs > 20 ? '\x1b[33m🟡 MED\x1b[0m' : '\x1b[32m🟢 LOW\x1b[0m';
        
        console.log(`\nMempool Pressure: EVM ${evmStatus} | Cosmos ${cosmosStatus}`);
        console.log('Press Ctrl+C to stop monitoring...\n');
    }
    
    async startMonitoring(intervalMs = 2000) {
        console.log(`Starting dual mempool monitoring (${intervalMs}ms interval)...`);
        
        // Initial data fetch
        await this.getEvmMempoolInfo();
        await this.getCosmosMempoolInfo();
        
        const monitor = setInterval(async () => {
            this.loadTestLogs(); // Load fresh logs from test script
            await this.getEvmMempoolInfo();
            await this.getCosmosMempoolInfo();
            this.updateHistory();
            this.displayDashboard();
        }, intervalMs);
        
        // Handle graceful shutdown
        process.on('SIGINT', () => {
            clearInterval(monitor);
            console.log('\nMempool monitoring stopped.');
            process.exit(0);
        });
        
        return monitor;
    }
}

// CLI usage
async function main() {
    const monitor = new MempoolMonitor();
    await monitor.startMonitoring(500); // Update every 500ms for fast test
}

if (import.meta.url === `file://${process.argv[1]}`) {
    main().catch(console.error);
}

export default MempoolMonitor;