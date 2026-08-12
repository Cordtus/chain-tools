#!/usr/bin/env node
import React, { useState, useEffect } from 'react';
import { render, Box, Text } from 'ink';
import { ethers } from 'ethers';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const MempoolDashboard = () => {
    const [evmData, setEvmData] = useState({
        pendingTxs: 0,
        queuedTxs: 0,
        totalEvmPool: 0,
        blockNumber: 0,
        gasPrice: '0',
        baseFee: '0',
        maxPriorityFee: '0',
        blockGasUsed: '0',
        blockGasLimit: '0',
        utilization: '0%',
        blockTime: 0,
        avgBlockTime: '0s',
        minBlockTime: null,
        maxBlockTime: null,
        stuckTxs: 0,
        recentBlocks: []
    });
    
    const [cosmosData, setCosmosData] = useState({
        pendingTxs: 0,
        blockHeight: 0,
        totalTxs: 0,
        totalBytes: 0,
        chainId: '',
        blockTxCount: 0,
        blockTime: 0,
        avgBlockTime: '0s',
        minBlockTime: null,
        maxBlockTime: null,
        validatorCount: 0,
        bondedTokens: '0',
        totalSupply: '0',
        mempoolSize: 0,
        recentBlocks: []
    });
    
    const [history, setHistory] = useState({
        evm: [],
        cosmos: []
    });
    
    const [tpsData, setTpsData] = useState({
        evmTps: 0,
        cosmosTps: 0,
        combinedTps: 0,
        evmTxCount: 0,
        cosmosTxCount: 0,
        ourEvmTxCount: 0,
        lastBlockTime: Date.now()
    });
    
    const [lastUpdate, setLastUpdate] = useState(new Date());
    const [logs, setLogs] = useState([]);
    
    const evmRpcUrl = process.env.RPC_URL || 'http://localhost:8545';
    const cosmosRpcUrl = process.env.COSMOS_RPC_URL || 'http://localhost:26657';
    const cosmosRestUrl = process.env.COSMOS_REST_URL || 'http://localhost:1317';
    const evmProvider = new ethers.JsonRpcProvider(evmRpcUrl);

    const evmPrivateKeys = [
        process.env.PRIVATE_KEY,
        process.env.PRIVATE_KEY_1,
        process.env.PRIVATE_KEY_2,
        process.env.PRIVATE_KEY_3
    ].filter(Boolean);

    const ourEvmAddresses = evmPrivateKeys.map(pk => {
        try {
            const wallet = new ethers.Wallet(pk);
            return wallet.address.toLowerCase();
        } catch {
            return null;
        }
    }).filter(Boolean);

    const addLog = (message) => {
        setLogs(prev => {
            const existingIndex = prev.findIndex(entry => entry.message === message);
            const now = new Date();

            if (existingIndex >= 0) {
                const updated = [...prev];
                const existing = updated[existingIndex];
                updated[existingIndex] = {
                    ...existing,
                    count: existing.count + 1,
                    lastTime: now
                };
                return updated;
            }

            const next = [
                ...prev,
                {
                    message,
                    count: 1,
                    lastTime: now
                }
            ];

            // Keep only the last 10 distinct messages
            return next.slice(-10);
        });
    };
    
    const fetchEvmData = async () => {
        try {
            // Get comprehensive EVM data
            const txpoolStatus = await evmProvider.send('txpool_status', []);
            const block = await evmProvider.getBlock('latest');
            const feeData = await evmProvider.getFeeData();
            
            // Get recent blocks for timing analysis
            const recentBlockPromises = [];
            for (let i = 0; i < 5; i++) {
                recentBlockPromises.push(evmProvider.getBlock(block.number - i, true));
            }
            const recentBlocks = await Promise.all(recentBlockPromises);
            
            // Calculate average block time and track min/max
            let totalBlockTime = 0;
            let currentMinBlockTime = null;
            let currentMaxBlockTime = null;
            
            for (let i = 1; i < recentBlocks.length; i++) {
                const blockTime = recentBlocks[i-1].timestamp - recentBlocks[i].timestamp;
                totalBlockTime += blockTime;
                
                if (currentMinBlockTime === null || blockTime < currentMinBlockTime) {
                    currentMinBlockTime = blockTime;
                }
                if (currentMaxBlockTime === null || blockTime > currentMaxBlockTime) {
                    currentMaxBlockTime = blockTime;
                }
            }
            const avgBlockTime = recentBlocks.length > 1 ? totalBlockTime / (recentBlocks.length - 1) : 0;
            
            // Check for stuck transactions (simplified)
            const stuckTxs = Math.max(0, parseInt(txpoolStatus.pending || '0x0', 16) - 10);
            
            // Parse txpool status (hex values)
            const pendingCount = parseInt(txpoolStatus.pending || '0x0', 16);
            const queuedCount = parseInt(txpoolStatus.queued || '0x0', 16);
            
            const newEvmData = {
                pendingTxs: pendingCount,
                queuedTxs: queuedCount,
                totalEvmPool: pendingCount + queuedCount,
                blockNumber: block.number,
                gasPrice: ethers.formatUnits(feeData.gasPrice || 0, 'gwei'),
                baseFee: ethers.formatUnits(feeData.baseFeePerGas || 0, 'gwei'),
                maxPriorityFee: ethers.formatUnits(feeData.maxPriorityFeePerGas || 0, 'gwei'),
                blockGasUsed: block.gasUsed.toString(),
                blockGasLimit: block.gasLimit.toString(),
                utilization: ((block.gasUsed * 100n) / block.gasLimit).toString() + '%',
                blockTime: block.timestamp,
                avgBlockTime: avgBlockTime.toFixed(1) + 's',
                minBlockTime: currentMinBlockTime !== null ? 
                    (evmData.minBlockTime === null ? currentMinBlockTime : Math.min(evmData.minBlockTime, currentMinBlockTime)) : 
                    evmData.minBlockTime,
                maxBlockTime: currentMaxBlockTime !== null ? 
                    (evmData.maxBlockTime === null ? currentMaxBlockTime : Math.max(evmData.maxBlockTime, currentMaxBlockTime)) : 
                    evmData.maxBlockTime,
                stuckTxs: Math.max(0, stuckTxs),
                recentBlocks: recentBlocks.slice(0, 10).map(b => ({
                    number: b.number,
                    txCount: b.transactions.length,
                    gasUsed: b.gasUsed.toString(),
                    timestamp: b.timestamp
                }))
            };
            
            setEvmData(newEvmData);
            
            // Calculate EVM TPS from recent blocks
            let evmTps = 0;
            let ourEvmTxCount = 0;

            if (recentBlocks.length > 1) {
                const totalTxs = recentBlocks.reduce((sum, b) => sum + b.transactions.length, 0);
                const timeSpan = (recentBlocks[0].timestamp - recentBlocks[recentBlocks.length-1].timestamp);
                if (timeSpan > 0) {
                    evmTps = (totalTxs / timeSpan).toFixed(2);
                }

                if (ourEvmAddresses.length > 0) {
                    for (const b of recentBlocks) {
                        for (const tx of b.transactions) {
                            if (tx.from && ourEvmAddresses.includes(tx.from.toLowerCase())) {
                                ourEvmTxCount++;
                            }
                        }
                    }
                }
            }
            
            // Update history and TPS data
            setHistory(prev => ({
                ...prev,
                evm: [...prev.evm.slice(-30), { time: Date.now(), value: newEvmData.pendingTxs }]
            }));
            
            setTpsData(prev => ({
                ...prev,
                evmTps: evmTps,
                evmTxCount: recentBlocks.reduce((sum, b) => sum + b.transactions.length, 0),
                ourEvmTxCount
            }));
            
        } catch (error) {
            addLog(`EVM fetch error: ${error.message}`);
            // Fallback to old method if txpool not available
            try {
                const pending = await evmProvider.send('eth_getBlockTransactionCountByNumber', ['pending']);
                const latest = await evmProvider.send('eth_getBlockTransactionCountByNumber', ['latest']);
                const pendingCount = Math.max(0, parseInt(pending, 16) - parseInt(latest, 16));
                
                const block = await evmProvider.getBlock('latest');
                const feeData = await evmProvider.getFeeData();
                
                const newEvmData = {
                    pendingTxs: pendingCount,
                    queuedTxs: 0,
                    totalEvmPool: pendingCount,
                    blockNumber: block.number,
                    gasPrice: ethers.formatUnits(feeData.gasPrice || 0, 'gwei'),
                    baseFee: ethers.formatUnits(feeData.baseFeePerGas || 0, 'gwei'),
                    blockGasUsed: block.gasUsed.toString(),
                    blockGasLimit: block.gasLimit.toString(),
                    utilization: ((block.gasUsed * 100n) / block.gasLimit).toString() + '%'
                };
                
                setEvmData(newEvmData);
                setHistory(prev => ({
                    ...prev,
                    evm: [...prev.evm.slice(-30), { time: Date.now(), value: newEvmData.pendingTxs }]
                }));
                
            } catch (fallbackError) {
                addLog(`EVM fallback error: ${fallbackError.message}`);
            }
        }
    };
    
    const fetchCosmosData = async () => {
        try {
            // Get comprehensive Cosmos data
            const [mempoolResponse, statusResponse, blockResponse, validatorsResponse] = await Promise.all([
                fetch(`${cosmosRpcUrl}/num_unconfirmed_txs`),
                fetch(`${cosmosRpcUrl}/status`),
                fetch(`${cosmosRpcUrl}/block`),
                fetch(`${cosmosRestUrl}/cosmos/staking/v1beta1/validators?pagination.limit=200`).catch(() => null)
            ]);
            
            const mempoolData = await mempoolResponse.json();
            const statusData = await statusResponse.json();
            const blockData = await blockResponse.json();
            const validatorsData = validatorsResponse ? await validatorsResponse.json() : null;
            
            // Get recent blocks for timing analysis
            const currentHeight = parseInt(statusData.result?.sync_info?.latest_block_height || '0');
            const recentBlockPromises = [];
            for (let i = 0; i < 5; i++) {
                recentBlockPromises.push(
                    fetch(`${cosmosRpcUrl}/block?height=${currentHeight - i}`)
                        .then(r => r.json())
                        .catch(() => null)
                );
            }
            const recentBlocksData = await Promise.all(recentBlockPromises);
            const recentBlocks = recentBlocksData.filter(b => b).map(b => ({
                height: parseInt(b.result?.block?.header?.height || '0'),
                txCount: b.result?.block?.data?.txs?.length || 0,
                time: new Date(b.result?.block?.header?.time).getTime()
            }));
            
            // Calculate average block time and track min/max
            let avgBlockTime = 0;
            let currentMinBlockTime = null;
            let currentMaxBlockTime = null;
            
            if (recentBlocks.length > 1) {
                let totalTime = 0;
                for (let i = 1; i < recentBlocks.length; i++) {
                    const blockTime = (recentBlocks[i-1].time - recentBlocks[i].time) / 1000;
                    totalTime += blockTime;
                    
                    if (currentMinBlockTime === null || blockTime < currentMinBlockTime) {
                        currentMinBlockTime = blockTime;
                    }
                    if (currentMaxBlockTime === null || blockTime > currentMaxBlockTime) {
                        currentMaxBlockTime = blockTime;
                    }
                }
                avgBlockTime = totalTime / (recentBlocks.length - 1);
            }
            
            // Get supply info for better chain insight  
            let totalSupply = '0';
            try {
                const supplyResponse = await fetch(`${cosmosRestUrl}/cosmos/bank/v1beta1/supply/atest`);
                const supplyData = await supplyResponse.json();
                totalSupply = (parseInt(supplyData.amount?.amount || '0') / 1e18).toFixed(2) + 'M';
            } catch (e) {
                // Ignore supply fetch errors
            }
            
            const newCosmosData = {
                pendingTxs: parseInt(mempoolData.result?.n_txs || '0'),
                blockHeight: parseInt(statusData.result?.sync_info?.latest_block_height || '0'),
                totalTxs: parseInt(mempoolData.result?.total || '0'),
                totalBytes: parseInt(mempoolData.result?.total_bytes || '0'),
                chainId: statusData.result?.node_info?.network || '',
                blockTxCount: blockData.result?.block?.data?.txs?.length || 0,
                blockTime: new Date(blockData.result?.block?.header?.time).getTime(),
                avgBlockTime: avgBlockTime.toFixed(1) + 's',
                minBlockTime: currentMinBlockTime !== null ? 
                    (cosmosData.minBlockTime === null ? currentMinBlockTime : Math.min(cosmosData.minBlockTime, currentMinBlockTime)) : 
                    cosmosData.minBlockTime,
                maxBlockTime: currentMaxBlockTime !== null ? 
                    (cosmosData.maxBlockTime === null ? currentMaxBlockTime : Math.max(cosmosData.maxBlockTime, currentMaxBlockTime)) : 
                    cosmosData.maxBlockTime,
                validatorCount: validatorsData?.validators?.length || 0,
                bondedTokens: validatorsData?.validators?.reduce((sum, v) => sum + parseInt(v.tokens || '0'), 0) / 1e18 || 0,
                totalSupply,
                mempoolSize: parseInt(mempoolData.result?.total_bytes || '0'),
                recentBlocks
            };
            
            setCosmosData(newCosmosData);
            
            // Calculate Cosmos TPS from recent blocks
            let cosmosTps = 0;
            if (recentBlocks.length > 1) {
                const totalTxs = recentBlocks.reduce((sum, b) => sum + b.txCount, 0);
                const timeSpan = (recentBlocks[0].time - recentBlocks[recentBlocks.length-1].time) / 1000;
                if (timeSpan > 0) {
                    cosmosTps = (totalTxs / timeSpan).toFixed(2);
                }
            }
            
            // Update history and TPS data
            setHistory(prev => ({
                ...prev,
                cosmos: [...prev.cosmos.slice(-30), { time: Date.now(), value: newCosmosData.pendingTxs }]
            }));
            
            setTpsData(prev => ({
                ...prev,
                cosmosTps: cosmosTps,
                cosmosTxCount: recentBlocks.reduce((sum, b) => sum + b.txCount, 0),
                combinedTps: (parseFloat(prev.evmTps) + parseFloat(cosmosTps)).toFixed(2)
            }));
            
        } catch (error) {
            addLog(`Cosmos fetch error: ${error.message}`);
        }
    };
    
    const createSparkline = (data, width = 40) => {
        if (data.length < 2) return '▄'.repeat(width);
        
        const values = data.map(d => d.value);
        const max = Math.max(...values, 1);
        const min = Math.min(...values);
        const range = max - min || 1;
        
        const chars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
        
        return data.slice(-width).map(d => {
            const normalized = range > 0 ? (d.value - min) / range : 0;
            const charIndex = Math.floor(normalized * (chars.length - 1));
            return chars[charIndex];
        }).join('');
    };
    
    const getStatusColor = (pending) => {
        if (pending > 50) return 'red';
        if (pending > 20) return 'yellow';
        return 'green';
    };
    
    const getStatusEmoji = (pending) => {
        if (pending > 50) return '';
        if (pending > 20) return '';
        return '';
    };
    
    useEffect(() => {
        const interval = setInterval(async () => {
            await Promise.all([fetchEvmData(), fetchCosmosData()]);
            setLastUpdate(new Date());
        }, 1500);
        
        // Initial fetch
        fetchEvmData();
        fetchCosmosData();
        
        return () => clearInterval(interval);
    }, []);
    
    const totalPending = (evmData.totalEvmPool || evmData.pendingTxs) + cosmosData.pendingTxs;
    
    return React.createElement(Box, { flexDirection: "column", padding: 1 },
        React.createElement(Box, { borderStyle: "double", borderColor: "cyan", flexDirection: "column", padding: 1 },
            React.createElement(Box, { justifyContent: "center" },
                React.createElement(Text, { bold: true, color: "cyan" }, " DUAL MEMPOOL MONITOR - COSMOS EVM ")
            ),
            React.createElement(Box, { justifyContent: "center", marginBottom: 1 },
                React.createElement(Text, { dimColor: true }, lastUpdate.toLocaleTimeString())
            )
        ),
        
        // EVM Section
        React.createElement(Box, { borderStyle: "single", borderColor: "blue", flexDirection: "column", padding: 1, marginTop: 1 },
            React.createElement(Box, null,
                React.createElement(Text, { bold: true, color: "blue" }, " EVM MEMPOOL"),
                React.createElement(Text, { color: getStatusColor(evmData.totalEvmPool || evmData.pendingTxs), marginLeft: 2 },
                    `${getStatusEmoji(evmData.totalEvmPool || evmData.pendingTxs)} ${evmData.pendingTxs} pending`,
                    evmData.queuedTxs > 0 && React.createElement(Text, { color: "yellow" }, ` + ${evmData.queuedTxs} queued`)
                )
            ),
            
            React.createElement(Box, { marginTop: 1 },
                React.createElement(Box, { width: "50%" },
                    React.createElement(Text, null, "Block: ", React.createElement(Text, { color: "green" }, evmData.blockNumber))
                ),
                React.createElement(Box, { width: "50%" },
                    React.createElement(Text, null, "Gas Price: ", React.createElement(Text, { color: "yellow" }, evmData.gasPrice), " gwei")
                )
            ),
            
            React.createElement(Box, null,
                React.createElement(Box, { width: "33%" },
                    React.createElement(Text, null, "Base Fee: ", React.createElement(Text, { color: "yellow" }, evmData.baseFee), " gwei")
                ),
                React.createElement(Box, { width: "33%" },
                    React.createElement(Text, null, "Priority: ", React.createElement(Text, { color: "yellow" }, evmData.maxPriorityFee), " gwei")
                ),
                React.createElement(Box, { width: "34%" },
                    React.createElement(Text, null, "Block Util: ", React.createElement(Text, { color: "magenta" }, evmData.utilization))
                )
            ),
            
            React.createElement(Box, null,
                React.createElement(Box, { width: "25%" },
                    React.createElement(Text, null, "Avg: ", React.createElement(Text, { color: "cyan" }, evmData.avgBlockTime))
                ),
                React.createElement(Box, { width: "25%" },
                    React.createElement(Text, null, "Min: ", React.createElement(Text, { color: "green" }, evmData.minBlockTime?.toFixed(1) + 's' || 'N/A'))
                ),
                React.createElement(Box, { width: "25%" },
                    React.createElement(Text, null, "Max: ", React.createElement(Text, { color: "red" }, evmData.maxBlockTime?.toFixed(1) + 's' || 'N/A'))
                ),
                React.createElement(Box, { width: "25%" },
                    React.createElement(Text, null, "Stuck: ", React.createElement(Text, { color: evmData.stuckTxs > 0 ? "red" : "green" }, evmData.stuckTxs))
                )
            ),
            
            React.createElement(Box, { marginTop: 1 },
                React.createElement(Text, null, "Pending History: "),
                React.createElement(Text, { color: "blue" }, createSparkline(history.evm, 50))
            )
        ),
        
        // Cosmos Section
        React.createElement(Box, { borderStyle: "single", borderColor: "magenta", flexDirection: "column", padding: 1, marginTop: 1 },
            React.createElement(Box, null,
                React.createElement(Text, { bold: true, color: "magenta" }, " COSMOS MEMPOOL"),
                React.createElement(Text, { color: getStatusColor(cosmosData.pendingTxs), marginLeft: 2 },
                    `${getStatusEmoji(cosmosData.pendingTxs)} ${cosmosData.pendingTxs} pending`
                )
            ),
            
            React.createElement(Box, { marginTop: 1 },
                React.createElement(Box, { width: "50%" },
                    React.createElement(Text, null, "Height: ", React.createElement(Text, { color: "green" }, cosmosData.blockHeight))
                ),
                React.createElement(Box, { width: "50%" },
                    React.createElement(Text, null, "Chain: ", React.createElement(Text, { color: "cyan" }, cosmosData.chainId))
                )
            ),
            
            React.createElement(Box, null,
                React.createElement(Box, { width: "33%" },
                    React.createElement(Text, null, "Block Txs: ", React.createElement(Text, { color: "yellow" }, cosmosData.blockTxCount))
                ),
                React.createElement(Box, { width: "33%" },
                    React.createElement(Text, null, "Pool Bytes: ", React.createElement(Text, { color: "yellow" }, (cosmosData.mempoolSize / 1024).toFixed(1) + 'KB'))
                ),
                React.createElement(Box, { width: "34%" },
                    React.createElement(Text, null, "Avg: ", React.createElement(Text, { color: "cyan" }, cosmosData.avgBlockTime))
                )
            ),
            
            React.createElement(Box, null,
                React.createElement(Box, { width: "25%" },
                    React.createElement(Text, null, "Min: ", React.createElement(Text, { color: "green" }, cosmosData.minBlockTime?.toFixed(1) + 's' || 'N/A'))
                ),
                React.createElement(Box, { width: "25%" },
                    React.createElement(Text, null, "Max: ", React.createElement(Text, { color: "red" }, cosmosData.maxBlockTime?.toFixed(1) + 's' || 'N/A'))
                ),
                React.createElement(Box, { width: "25%" },
                    React.createElement(Text, null, "Validators: ", React.createElement(Text, { color: "cyan" }, cosmosData.validatorCount))
                ),
                React.createElement(Box, { width: "25%" },
                    React.createElement(Text, null, "Supply: ", React.createElement(Text, { color: "cyan" }, cosmosData.totalSupply))
                )
            ),
            
            React.createElement(Box, { marginTop: 1 },
                React.createElement(Text, null, "Pending History: "),
                React.createElement(Text, { color: "magenta" }, createSparkline(history.cosmos, 50))
            )
        ),
        
        // Combined Status with TPS
        React.createElement(Box, { borderStyle: "single", borderColor: "white", flexDirection: "column", padding: 1, marginTop: 1 },
            React.createElement(Box, { justifyContent: "space-between" },
                React.createElement(Text, { bold: true }, " COMBINED METRICS & TPS"),
                React.createElement(Text, { color: getStatusColor(totalPending) },
                    `Total Pending: ${totalPending}`
                )
            ),
            
            React.createElement(Box, { marginTop: 1, justifyContent: "space-between" },
                React.createElement(Text, null, "EVM TPS: ", 
                    React.createElement(Text, { color: "cyan" }, tpsData.evmTps)
                ),
                React.createElement(Text, null, "Cosmos TPS: ", 
                    React.createElement(Text, { color: "magenta" }, tpsData.cosmosTps)
                ),
                React.createElement(Text, null, "Combined TPS: ", 
                    React.createElement(Text, { color: "green", bold: true }, tpsData.combinedTps)
                )
            ),
            
            React.createElement(Box, { marginTop: 1, justifyContent: "space-between" },
                React.createElement(Text, null, "EVM Txs (5 blocks): ", 
                    React.createElement(Text, { color: "blue" }, `${tpsData.evmTxCount} total, ${tpsData.ourEvmTxCount} ours`)
                ),
                React.createElement(Text, null, "Cosmos Txs (5 blocks): ", 
                    React.createElement(Text, { color: "magenta" }, tpsData.cosmosTxCount)
                ),
                React.createElement(Text, { color: totalPending > 100 ? "red" : totalPending > 50 ? "yellow" : "green" }, 
                    `Load: ${totalPending > 100 ? "HIGH" : totalPending > 50 ? "MED" : "LOW"}`
                )
            ),
            
            React.createElement(Box, { marginTop: 1, justifyContent: "center" },
                React.createElement(Text, { dimColor: true }, "Press Ctrl+C to exit | Updates every 1.5s | TPS = successful transactions per second")
            )
        ),

        // Logs Section
        React.createElement(Box, { borderStyle: "single", borderColor: "gray", flexDirection: "column", padding: 1, marginTop: 1 },
            React.createElement(Box, { justifyContent: "space-between" },
                React.createElement(Text, { bold: true }, " LOGS "),
                React.createElement(Text, { dimColor: true }, "latest issues (deduped)")
            ),
            logs.length === 0
                ? React.createElement(Text, { dimColor: true }, "No recent errors")
                : logs.map((entry, index) =>
                    React.createElement(Text, { key: index, color: "red" },
                        `[${entry.count}x] ${entry.message}`
                    )
                )
        )
    );
};

// Only render if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
    render(React.createElement(MempoolDashboard));
}
