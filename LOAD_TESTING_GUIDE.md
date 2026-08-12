#  Heavy Load RPC Testing Guide

## Why Heavy Load Testing Matters

Standard RPC tests often query low-activity contracts or use artificial patterns that don't reflect real-world load. This guide shows how to generate **actual production-level load** on RPC endpoints.

## Key Concepts for Maximum Load

### 1. **High-Activity Contracts**
Query contracts with thousands of daily transactions:
- **DEX Routers** (Uniswap, PancakeSwap) - Thousands of swaps per hour
- **Stablecoins** (USDT, USDC) - Millions of transfers daily  
- **Wrapped Tokens** (WETH, WMATIC) - High deposit/withdrawal volume
- **NFT Marketplaces** (OpenSea, Blur) - Diverse event types

### 2. **Data Scatter Patterns**
Maximum load comes from scattered data across blocks:
- **No Topic Filters** - Returns ALL events (maximum scatter)
- **Multiple Topics** - Query different event types simultaneously
- **No Address Filter** - Query ALL contracts (chaos mode)

### 3. **Parallel Queries**
Multiply load by running concurrent requests:
- Query multiple contracts simultaneously
- Split block ranges across parallel requests
- Combine different event types in parallel

## Load Profiles

###  Light Load
- Moderate activity contracts
- Single event type queries
- Suitable for baseline testing

###  Medium Load  
- Active DeFi protocols
- Multiple event types
- Good for sustained load testing

###  Heavy Load
- Highest volume contracts (Uniswap, USDC, USDT)
- All events without filtering
- Maximum data transfer

###  Chaos Mode
- Queries WITHOUT address filter
- Returns events from ALL contracts
- Can overwhelm nodes - use carefully!

## Usage Examples

### Basic Heavy Load Test
```bash
# Auto-detect chain and use heaviest contracts
node tools/heavy-stress-test.js -r https://eth-mainnet.g.alchemy.com/v2/YOUR-KEY -a -l heavy
```

### Parallel Queries for 5x Load
```bash
# Run 5 parallel queries on Polygon USDC
node tools/heavy-stress-test.js \
  -r https://polygon-rpc.com \
  -c 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 \
  -p 5
```

### Chaos Mode (Extreme Load)
```bash
# Query ALL contracts - use with extreme caution!
node tools/heavy-stress-test.js -r https://rpc.url -s chaos -i 10 -m 5
```

### Custom Topics for Scatter
```bash
# Query multiple event types for maximum scatter
node tools/heavy-stress-test.js \
  -r https://rpc.url \
  -c 0xContract \
  -t 0xddf252ad,0x8c5be1e5,0xe1fffcc4
```

## Pre-Configured High-Load Contracts by Chain

### Ethereum Mainnet
| Contract | Type | Daily Events | Address |
|----------|------|--------------|---------|
| Uniswap V3 Router | DEX | ~500K+ | 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45 |
| USDT | Stablecoin | ~1M+ | 0xdAC17F958D2ee523a2206206994597C13D831ec7 |
| USDC | Stablecoin | ~800K+ | 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 |
| OpenSea Seaport | NFT | ~200K+ | 0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC |
| WETH | Wrapped | ~300K+ | 0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2 |

### Polygon
| Contract | Type | Daily Events | Address |
|----------|------|--------------|---------|
| USDC.e | Stablecoin | ~2M+ | 0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174 |
| QuickSwap | DEX | ~300K+ | 0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff |
| Aave V3 | Lending | ~150K+ | 0x794a61358D6845594F94dc1DB02A252b5b4814aD |

### Arbitrum
| Contract | Type | Daily Events | Address |
|----------|------|--------------|---------|
| GMX | Perp DEX | ~200K+ | 0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a |
| USDC Native | Stablecoin | ~500K+ | 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 |

### BSC
| Contract | Type | Daily Events | Address |
|----------|------|--------------|---------|
| PancakeSwap V2 | DEX | ~1M+ | 0x10ED43C718714eb63d5aA57B78B54704E256024E |
| BUSD | Stablecoin | ~800K+ | 0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56 |

## Load Testing Strategies

### 1. **Scatter Strategy** (Default)
```javascript
// Queries all events without topic filtering
filter = {
  address: contractAddress,
  fromBlock: 1000000,
  toBlock: 1001000
  // No topics = returns ALL event types
}
```

### 2. **Multi-Topic Strategy**
```javascript
// Query multiple event types simultaneously
filter = {
  address: contractAddress,
  topics: [
    [
      "0xddf252ad...", // Transfer
      "0x8c5be1e5...", // Approval  
      "0xe1fffcc4...", // Deposit
      "0x7fcf532c..."  // Withdrawal
    ]
  ]
}
```

### 3. **High-Frequency Strategy**
```javascript
// Focus on most common events
filter = {
  address: usdcAddress,
  topics: ["0xddf252ad..."] // Transfer events only
}
```

### 4. **Chaos Strategy** 
```javascript
// Query WITHOUT address filter - ALL contracts!
filter = {
  // No address = query ALL contracts
  topics: ["0xddf252ad..."], // Limit to transfers to avoid total chaos
  fromBlock: latestBlock - 10,
  toBlock: latestBlock
}
```

## Important Event Signatures

```
Transfer (ERC20/721): 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
Approval (ERC20/721): 0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925
Swap (Uniswap V2/V3): 0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822
Deposit (WETH): 0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c
Withdrawal (WETH): 0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65
```

## Performance Expectations

### Light Load (single query, moderate contract)
- ~100-500 logs per query
- ~50-200ms response time
- ~10-50 KB data transfer

### Heavy Load (parallel queries, high-activity contract)
- ~5,000-10,000 logs per query
- ~500-2000ms response time  
- ~1-5 MB data transfer

### Chaos Mode (all contracts, no filter)
- Can return 10,000 logs (limit) instantly
- Response times vary wildly (500ms - timeout)
- Can overwhelm node memory
- USE WITH EXTREME CAUTION

## Tips for Maximum Load

1. **Use Known Heavy Contracts**: Query Uniswap, USDC, USDT for guaranteed high volume
2. **Remove Topic Filters**: No topics = return ALL events = maximum data
3. **Parallel Queries**: Use -p 5 or -p 10 for 5x-10x load multiplication
4. **Large Block Ranges**: Start with -i 500 for bigger initial chunks
5. **Minimal Delay**: Use -d 100 for rapid-fire requests (respect rate limits)
6. **Chaos Mode**: Last resort - queries ALL contracts (can crash nodes)

## Safety Considerations

- **Rate Limits**: Most providers limit requests/second
- **Cost**: Heavy queries consume more compute units
- **Timeouts**: Large queries may timeout (>30 seconds)
- **Memory**: Chaos mode can cause out-of-memory errors
- **Be Respectful**: Don't intentionally DoS public endpoints

## Monitoring Load Impact

Watch for these indicators of heavy load:
- Response times increasing progressively
- Timeout errors
- Rate limit errors (429 status)
- Truncated responses (exactly 10,000 logs)
- Memory errors from the provider

## QuickNode-Specific Testing

QuickNode endpoints can handle heavy load well. For maximum stress:

```bash
# QuickNode heavy test with parallel queries
node tools/heavy-stress-test.js \
  -r https://your-endpoint.quiknode.pro/YOUR-KEY \
  -a \              # Auto-detect chain
  -l heavy \        # Use heaviest contracts
  -p 5 \            # 5 parallel queries
  -i 500 \          # Large initial range
  -d 200 \          # Fast iterations
  -m 50             # Many iterations
```

This will generate substantial load to properly test the endpoint's capacity.