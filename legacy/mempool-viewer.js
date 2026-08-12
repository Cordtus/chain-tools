import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

class MempoolViewer {
    constructor() {
        this.provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
        this.metrics = {
            pending: 0,
            queued: 0,
            blockNumber: 0,
            gasPrice: '0'
        };
    }
    
    async getPoolStatus() {
        try {
            const status = await this.provider.send('txpool_status', []);
            const block = await this.provider.getBlock('latest');
            const feeData = await this.provider.getFeeData();
            
            this.metrics = {
                pending: parseInt(status.pending || '0x0', 16),
                queued: parseInt(status.queued || '0x0', 16),
                blockNumber: block.number,
                gasPrice: ethers.formatUnits(feeData.gasPrice || 0, 'gwei')
            };
        } catch (error) {
            console.error('Failed to get txpool status:', error.message);
        }
    }
    
    clearScreen() {
        process.stdout.write('\x1B[2J\x1B[0f');
    }
    
    display() {
        this.clearScreen();
        
        console.log('┌─────────────────────────────────────────┐');
        console.log('│              MEMPOOL VIEWER             │');
        console.log('├─────────────────────────────────────────┤');
        console.log(`│ Block: ${this.metrics.blockNumber.toString().padEnd(8)} Gas: ${this.metrics.gasPrice.padEnd(8)} gwei │`);
        console.log(`│ Pending: ${this.metrics.pending.toString().padEnd(6)} Queued: ${this.metrics.queued.toString().padEnd(6)}     │`);
        console.log('└─────────────────────────────────────────┘');
        
        const total = this.metrics.pending + this.metrics.queued;
        const status = total > 10 ? '🔴 HIGH' : total > 3 ? '🟡 MED' : '🟢 LOW';
        console.log(`\nMempool: ${status} (${total} total txs)`);
        console.log('Press Ctrl+C to stop...\n');
    }
    
    async start() {
        console.log('Starting mempool viewer...\n');
        
        const interval = setInterval(async () => {
            await this.getPoolStatus();
            this.display();
        }, 1000);
        
        process.on('SIGINT', () => {
            clearInterval(interval);
            console.log('\nStopped.');
            process.exit(0);
        });
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const viewer = new MempoolViewer();
    viewer.start().catch(console.error);
}