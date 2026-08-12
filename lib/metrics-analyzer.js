import { ethers } from 'ethers';
import fs from 'fs';
import dotenv from 'dotenv';

dotenv.config();

class MetricsAnalyzer {
    constructor() {
        this.rpcUrl = process.env.RPC_URL || 'http://localhost:8545';
        this.provider = new ethers.JsonRpcProvider(this.rpcUrl);
        
        this.metrics = {
            // Basic stats
            totalTransactions: 0,
            successfulTransactions: 0,
            failedTransactions: 0,
            
            // Block analysis
            blocksAnalyzed: 0,
            transactionsInBlocks: 0,
            totalGasUsed: BigInt(0),
            totalGasLimit: BigInt(0),
            averageGasPrice: BigInt(0),
            
            // Mempool tracking
            maxPendingTransactions: 0,
            avgPendingTransactions: 0,
            pendingSnapshots: [],
            
            // Performance metrics
            blockUtilization: 0,
            gasEfficiency: 0,
            inclusionRate: 0,
            
            // Transaction details
            transactionHashes: [],
            failureReasons: {},
            blockNumbers: new Set(),
            
            // Timing
            startTime: null,
            endTime: null,
            startBlock: null,
            endBlock: null
        };
    }
    
    async initialize() {
        this.metrics.startTime = Date.now();
        this.metrics.startBlock = await this.provider.getBlockNumber();
        console.log(`Metrics tracking initialized at block ${this.metrics.startBlock}`);
    }
    
    recordTransaction(txHash, success, error = null) {
        this.metrics.totalTransactions++;
        
        if (success) {
            this.metrics.successfulTransactions++;
            this.metrics.transactionHashes.push(txHash);
        } else {
            this.metrics.failedTransactions++;
            
            // Categorize failure reasons
            const reason = this.categorizeError(error);
            this.metrics.failureReasons[reason] = (this.metrics.failureReasons[reason] || 0) + 1;
        }
    }
    
    categorizeError(error) {
        if (!error) return 'unknown';
        
        const message = error.message || error;
        
        if (message.includes('invalid nonce') || message.includes('invalid sequence')) {
            return 'nonce_sequence_error';
        } else if (message.includes('tx already in mempool')) {
            return 'duplicate_transaction';
        } else if (message.includes('insufficient funds')) {
            return 'insufficient_balance';
        } else if (message.includes('gas')) {
            return 'gas_related';
        } else if (message.includes('timeout')) {
            return 'timeout';
        } else {
            return 'other';
        }
    }
    
    async trackMempool() {
        try {
            // Get pending transaction count
            const pendingCount = await this.provider.send('eth_getBlockTransactionCountByNumber', ['pending']);
            const pendingTxs = parseInt(pendingCount, 16);
            
            this.metrics.pendingSnapshots.push({
                timestamp: Date.now(),
                count: pendingTxs
            });
            
            this.metrics.maxPendingTransactions = Math.max(this.metrics.maxPendingTransactions, pendingTxs);
        } catch (error) {
            console.warn('Failed to track mempool:', error.message);
        }
    }
    
    async analyzeBlocks() {
        this.metrics.endTime = Date.now();
        this.metrics.endBlock = await this.provider.getBlockNumber();
        
        console.log(`Analyzing blocks ${this.metrics.startBlock} to ${this.metrics.endBlock}...`);
        
        let totalGasUsed = BigInt(0);
        let totalGasLimit = BigInt(0);
        let totalGasPriceSum = BigInt(0);
        let transactionCount = 0;
        let ourTransactionsInBlocks = 0;
        
        // Analyze blocks in the test period
        for (let blockNum = this.metrics.startBlock; blockNum <= this.metrics.endBlock; blockNum++) {
            try {
                const block = await this.provider.getBlock(blockNum, true);
                if (!block) continue;
                
                this.metrics.blocksAnalyzed++;
                this.metrics.blockNumbers.add(blockNum);
                
                if (block.transactions && block.transactions.length > 0) {
                    for (const tx of block.transactions) {
                        if (typeof tx === 'object' && tx.hash) {
                            transactionCount++;
                            totalGasUsed += BigInt(tx.gasUsed || 0);
                            totalGasLimit += BigInt(tx.gasLimit || 0);
                            
                            if (tx.gasPrice) {
                                totalGasPriceSum += BigInt(tx.gasPrice);
                            }
                            
                            // Check if this is one of our transactions
                            if (this.metrics.transactionHashes.includes(tx.hash)) {
                                ourTransactionsInBlocks++;
                            }
                        }
                    }
                }
                
                // Add block gas used
                if (block.gasUsed) {
                    // Note: block.gasUsed is total for all transactions in block
                }
                
            } catch (error) {
                console.warn(`Failed to analyze block ${blockNum}:`, error.message);
            }
        }
        
        this.metrics.transactionsInBlocks = ourTransactionsInBlocks;
        this.metrics.totalGasUsed = totalGasUsed;
        this.metrics.totalGasLimit = totalGasLimit;
        
        if (transactionCount > 0) {
            this.metrics.averageGasPrice = totalGasPriceSum / BigInt(transactionCount);
        }
        
        // Calculate derived metrics
        this.calculateDerivedMetrics();
    }
    
    calculateDerivedMetrics() {
        // Inclusion rate: what percentage of our successful transactions made it into blocks
        if (this.metrics.successfulTransactions > 0) {
            this.metrics.inclusionRate = (this.metrics.transactionsInBlocks / this.metrics.successfulTransactions) * 100;
        }
        
        // Gas efficiency: how much of allocated gas was actually used
        if (this.metrics.totalGasLimit > 0) {
            this.metrics.gasEfficiency = Number(this.metrics.totalGasUsed * BigInt(100) / this.metrics.totalGasLimit);
        }
        
        // Average pending transactions
        if (this.metrics.pendingSnapshots.length > 0) {
            const sum = this.metrics.pendingSnapshots.reduce((acc, snap) => acc + snap.count, 0);
            this.metrics.avgPendingTransactions = sum / this.metrics.pendingSnapshots.length;
        }
        
        // Block utilization (rough estimate)
        const testDuration = (this.metrics.endTime - this.metrics.startTime) / 1000; // seconds
        const expectedBlocks = testDuration / 2; // ~2 second block times
        const actualBlocks = this.metrics.endBlock - this.metrics.startBlock + 1;
        this.metrics.blockUtilization = (actualBlocks / expectedBlocks) * 100;
    }
    
    generateReport() {
        const duration = (this.metrics.endTime - this.metrics.startTime) / 1000;
        const tps = this.metrics.totalTransactions / duration;
        const successTps = this.metrics.successfulTransactions / duration;
        
        console.log('\n' + '='.repeat(60));
        console.log('              COMPREHENSIVE METRICS REPORT');
        console.log('='.repeat(60));
        
        console.log('\n--- TRANSACTION SUMMARY ---');
        console.log(`Test Duration: ${duration.toFixed(2)}s`);
        console.log(`Blocks Analyzed: ${this.metrics.startBlock} → ${this.metrics.endBlock} (${this.metrics.blocksAnalyzed} blocks)`);
        console.log(`Total Transactions Attempted: ${this.metrics.totalTransactions}`);
        console.log(`Successful Transactions: ${this.metrics.successfulTransactions}`);
        console.log(`Failed Transactions: ${this.metrics.failedTransactions}`);
        console.log(`Success Rate: ${((this.metrics.successfulTransactions / this.metrics.totalTransactions) * 100).toFixed(2)}%`);
        console.log(`Average TPS (Attempted): ${tps.toFixed(2)}`);
        console.log(`Average TPS (Successful): ${successTps.toFixed(2)}`);
        
        console.log('\n--- BLOCK & GAS ANALYSIS ---');
        console.log(`Our Transactions in Blocks: ${this.metrics.transactionsInBlocks}`);
        console.log(`Block Inclusion Rate: ${this.metrics.inclusionRate.toFixed(2)}%`);
        console.log(`Total Gas Used: ${this.metrics.totalGasUsed.toString()}`);
        console.log(`Total Gas Limit: ${this.metrics.totalGasLimit.toString()}`);
        console.log(`Gas Efficiency: ${this.metrics.gasEfficiency.toFixed(2)}%`);
        console.log(`Average Gas Price: ${ethers.formatUnits(this.metrics.averageGasPrice.toString(), 'gwei')} gwei`);
        
        console.log('\n--- MEMPOOL ANALYSIS ---');
        console.log(`Max Pending Transactions: ${this.metrics.maxPendingTransactions}`);
        console.log(`Avg Pending Transactions: ${this.metrics.avgPendingTransactions.toFixed(2)}`);
        console.log(`Mempool Snapshots Taken: ${this.metrics.pendingSnapshots.length}`);
        
        console.log('\n--- FAILURE ANALYSIS ---');
        console.log('Failure Categories:');
        Object.entries(this.metrics.failureReasons).forEach(([reason, count]) => {
            const percentage = ((count / this.metrics.failedTransactions) * 100).toFixed(1);
            console.log(`  ${reason}: ${count} (${percentage}%)`);
        });
        
        console.log('\n--- PERFORMANCE INSIGHTS ---');
        
        if (this.metrics.failureReasons.nonce_sequence_error) {
            const nonceErrors = this.metrics.failureReasons.nonce_sequence_error;
            const nonceErrorRate = (nonceErrors / this.metrics.totalTransactions) * 100;
            console.log(`  Nonce Sequencing: ${nonceErrorRate.toFixed(1)}% of transactions failed due to nonce issues`);
            
            if (nonceErrorRate > 10) {
                console.log('   Recommendation: Lower TPS or improve nonce management');
            }
        }
        
        if (this.metrics.inclusionRate < 90) {
            console.log(`  Low Inclusion Rate: Only ${this.metrics.inclusionRate.toFixed(1)}% of successful transactions found in blocks`);
            console.log('   This may indicate transactions are still pending or block analysis was incomplete');
        }
        
        if (this.metrics.maxPendingTransactions > 100) {
            console.log(`  High Mempool Pressure: Peak ${this.metrics.maxPendingTransactions} pending transactions`);
            console.log('   Network may be overwhelmed at peak TPS');
        }
        
        console.log('\n--- NETWORK STRESS ASSESSMENT ---');
        const stressLevel = this.calculateStressLevel();
        console.log(`Network Stress Level: ${stressLevel}`);
        
        console.log('='.repeat(60));
    }
    
    calculateStressLevel() {
        const successRate = (this.metrics.successfulTransactions / this.metrics.totalTransactions) * 100;
        const nonceErrorRate = ((this.metrics.failureReasons.nonce_sequence_error || 0) / this.metrics.totalTransactions) * 100;
        
        if (successRate > 90 && nonceErrorRate < 5) {
            return 'LOW - Network handling load well';
        } else if (successRate > 70 && nonceErrorRate < 15) {
            return 'MEDIUM - Some congestion, manageable';
        } else if (successRate > 50) {
            return 'HIGH - Significant network stress';
        } else {
            return 'EXTREME - Network overwhelmed';
        }
    }
    
    saveDetailedReport(filename) {
        const report = {
            timestamp: new Date().toISOString(),
            testConfiguration: {
                duration: (this.metrics.endTime - this.metrics.startTime) / 1000,
                startBlock: this.metrics.startBlock,
                endBlock: this.metrics.endBlock,
                rpcEndpoint: this.rpcUrl
            },
            transactionMetrics: {
                total: this.metrics.totalTransactions,
                successful: this.metrics.successfulTransactions,
                failed: this.metrics.failedTransactions,
                successRate: (this.metrics.successfulTransactions / this.metrics.totalTransactions) * 100,
                avgTPS: this.metrics.totalTransactions / ((this.metrics.endTime - this.metrics.startTime) / 1000)
            },
            blockAnalysis: {
                blocksAnalyzed: this.metrics.blocksAnalyzed,
                ourTransactionsInBlocks: this.metrics.transactionsInBlocks,
                inclusionRate: this.metrics.inclusionRate,
                blockUtilization: this.metrics.blockUtilization
            },
            gasMetrics: {
                totalGasUsed: this.metrics.totalGasUsed.toString(),
                totalGasLimit: this.metrics.totalGasLimit.toString(),
                gasEfficiency: this.metrics.gasEfficiency,
                averageGasPrice: {
                    wei: this.metrics.averageGasPrice.toString(),
                    gwei: ethers.formatUnits(this.metrics.averageGasPrice.toString(), 'gwei')
                }
            },
            mempoolAnalysis: {
                maxPending: this.metrics.maxPendingTransactions,
                avgPending: this.metrics.avgPendingTransactions,
                snapshotCount: this.metrics.pendingSnapshots.length,
                snapshots: this.metrics.pendingSnapshots
            },
            failureAnalysis: this.metrics.failureReasons,
            recommendations: this.generateRecommendations()
        };
        
        fs.writeFileSync(filename, JSON.stringify(report, null, 2));
        console.log(`\nDetailed metrics saved to ${filename}`);
    }
    
    generateRecommendations() {
        const recommendations = [];
        const successRate = (this.metrics.successfulTransactions / this.metrics.totalTransactions) * 100;
        const nonceErrorRate = ((this.metrics.failureReasons.nonce_sequence_error || 0) / this.metrics.totalTransactions) * 100;
        
        if (nonceErrorRate > 20) {
            recommendations.push('Implement better nonce management or reduce TPS to prevent sequence errors');
        }
        
        if (successRate < 80) {
            recommendations.push('Consider lowering transaction rate to improve success rate');
        }
        
        if (this.metrics.maxPendingTransactions > 200) {
            recommendations.push('High mempool pressure detected - network may be overwhelmed');
        }
        
        if (this.metrics.inclusionRate < 70) {
            recommendations.push('Low block inclusion rate - transactions may be getting dropped');
        }
        
        if (this.metrics.gasEfficiency < 50) {
            recommendations.push('Poor gas efficiency - optimize gas limits');
        }
        
        if (recommendations.length === 0) {
            recommendations.push('Performance looks good - network handling load well');
        }
        
        return recommendations;
    }
    
    async startMempoolMonitoring(intervalMs = 5000) {
        console.log(`Starting mempool monitoring every ${intervalMs}ms`);
        
        const monitor = setInterval(async () => {
            await this.trackMempool();
        }, intervalMs);
        
        // Return cleanup function
        return () => {
            clearInterval(monitor);
            console.log('Mempool monitoring stopped');
        };
    }
}

export default MetricsAnalyzer;

// CLI usage
if (import.meta.url === `file://${process.argv[1]}`) {
    const analyzer = new MetricsAnalyzer();
    
    console.log('Metrics Analyzer - analyzing last test results...');
    
    // Example: analyze recent blocks for transaction inclusion
    await analyzer.initialize();
    await analyzer.analyzeBlocks();
    
    // Generate sample report
    analyzer.metrics.totalTransactions = 4159;
    analyzer.metrics.successfulTransactions = 18;
    analyzer.metrics.failedTransactions = 4141;
    analyzer.metrics.failureReasons = {
        'nonce_sequence_error': 3800,
        'duplicate_transaction': 200,
        'other': 141
    };
    
    analyzer.generateReport();
    analyzer.saveDetailedReport(`metrics-report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
}