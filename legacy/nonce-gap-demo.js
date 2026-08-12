import { ethers } from 'ethers';
import dotenv from 'dotenv';

dotenv.config();

class NonceGapDemo {
    constructor() {
        this.provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
        this.wallet = new ethers.Wallet(process.env.PRIVATE_KEY, this.provider);
    }
    
    async createGappedTx(nonce) {
        const feeData = await this.provider.getFeeData();
        const network = await this.provider.getNetwork();
        
        const tx = {
            to: this.wallet.address,
            value: Math.floor(Math.random() * 1000),
            gasLimit: 21000,
            maxFeePerGas: (feeData.gasPrice || 1000000000n) * 20n,
            maxPriorityFeePerGas: (feeData.gasPrice || 1000000000n) * 20n,
            nonce: nonce,
            chainId: Number(network.chainId)
        };
        
        const signedTx = await this.wallet.signTransaction(tx);
        const txResponse = await this.provider.broadcastTransaction(signedTx);
        return txResponse.hash;
    }
    
    async clearStuck() {
        const latest = await this.provider.getTransactionCount(this.wallet.address, 'latest');
        const pending = await this.provider.getTransactionCount(this.wallet.address, 'pending');
        
        if (pending > latest) {
            console.log(`Clearing ${pending - latest} stuck transactions...`);
            for (let nonce = latest; nonce < pending; nonce++) {
                try {
                    await this.createGappedTx(nonce);
                    await new Promise(resolve => setTimeout(resolve, 500));
                } catch (error) {
                    // Continue trying
                }
            }
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
    
    async run() {
        console.log('Please start the mempool viewer in a separate terminal:');
        console.log('  node mempool-viewer.js');
        console.log('Press Enter when mempool viewer is running...');
        
        // Wait for user confirmation
        process.stdin.setRawMode(true);
        await new Promise(resolve => {
            process.stdin.once('data', () => {
                process.stdin.setRawMode(false);
                resolve();
            });
        });
        
        await this.clearStuck();
        
        const startNonce = await this.provider.getTransactionCount(this.wallet.address, 'pending');
        console.log(`\nStarting nonce gap demo from nonce ${startNonce}`);
        
        console.log('\nStep 1: Creating 3 gapped transactions...');
        const gaps = [];
        for (let i = 1; i <= 3; i++) {
            const gappedNonce = startNonce + i;
            console.log(`Creating gap: nonce ${gappedNonce}`);
            const hash = await this.createGappedTx(gappedNonce);
            gaps.push({ nonce: gappedNonce, hash });
            await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
        console.log('\nStep 2: Observing queued transactions...');
        console.log('(Check mempool viewer - should show 3 queued txs)');
        await new Promise(resolve => setTimeout(resolve, 10000));
        
        console.log('\nStep 3: Filling gap at nonce 0 to clear queue...');
        const fillHash = await this.createGappedTx(startNonce);
        console.log(`Filled nonce ${startNonce}: ${fillHash}`);
        
        console.log('\nStep 4: Watching queue clear...');
        console.log('(Check mempool viewer - queued txs should process)');
        await new Promise(resolve => setTimeout(resolve, 8000));
        
        const finalNonce = await this.provider.getTransactionCount(this.wallet.address, 'pending');
        console.log(`\nDemo complete! Final nonce: ${finalNonce}`);
        
        process.exit(0);
    }
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const demo = new NonceGapDemo();
    demo.run().catch(console.error);
}