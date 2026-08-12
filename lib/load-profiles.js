export const LOAD_PROFILES = {
  // Ethereum Mainnet
  ethereum: {
    heavy: [
      {
        name: "Uniswap V3 Router",
        address: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        description: "DEX router",
        topics: [
          "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822", // Swap event
        ]
      },
      {
        name: "USDT Token",
        address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        description: "Stablecoin",
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", // Transfer event
        ]
      },
      {
        name: "USDC Token",
        address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        description: "Stablecoin",
        topics: [
          "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", // Transfer event
        ]
      },
      {
        name: "OpenSea Seaport",
        address: "0x00000000000000ADc04C56Bf30aC9d3c0aAF14dC",
        description: "NFT marketplace",
        topics: [] // All events for maximum scatter
      },
      {
        name: "Wrapped Ether",
        address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        description: "Wrapped ETH",
        topics: [
          "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c", // Deposit
          "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65", // Withdrawal
        ]
      }
    ],
    medium: [
      {
        name: "ENS Registrar",
        address: "0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85",
        description: "ENS domain registrations",
        topics: []
      },
      {
        name: "1inch Router V5",
        address: "0x1111111254EEB25477B68fb85Ed929f73A960582",
        description: "DEX aggregator",
        topics: []
      }
    ],
    light: [
      {
        name: "DAI Token",
        address: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
        description: "Stablecoin",
        topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
      }
    ]
  },
  
  // Polygon
  polygon: {
    heavy: [
      {
        name: "USDC.e Token",
        address: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
        description: "Bridged USDC",
        topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
      },
      {
        name: "QuickSwap Router",
        address: "0xa5E0829CaCEd8fFDD4De3c43696c57F7D7A678ff",
        description: "DEX router",
        topics: []
      },
      {
        name: "Aave V3 Pool",
        address: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
        description: "Lending protocol",
        topics: []
      }
    ],
    medium: [
      {
        name: "WMATIC Token",
        address: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
        description: "Wrapped MATIC",
        topics: []
      }
    ],
    light: [
      {
        name: "USDT Token",
        address: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
        description: "Tether on Polygon",
        topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
      }
    ]
  },
  
  // Arbitrum
  arbitrum: {
    heavy: [
      {
        name: "GMX",
        address: "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a",
        description: "Perp DEX",
        topics: []
      },
      {
        name: "Uniswap V3 Router",
        address: "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
        description: "DEX router",
        topics: []
      },
      {
        name: "USDC Native",
        address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
        description: "Native USDC on Arbitrum",
        topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
      }
    ],
    medium: [
      {
        name: "SushiSwap Router",
        address: "0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506",
        description: "DEX router",
        topics: []
      }
    ],
    light: [
      {
        name: "WETH",
        address: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
        description: "Wrapped ETH on Arbitrum",
        topics: []
      }
    ]
  },
  
  // Base
  base: {
    heavy: [
      {
        name: "USDbC",
        address: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
        description: "Stablecoin",
        topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
      },
      {
        name: "Aerodrome Router",
        address: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",
        description: "DEX router",
        topics: []
      }
    ],
    medium: [
      {
        name: "WETH",
        address: "0x4200000000000000000000000000000000000006",
        description: "Wrapped ETH on Base",
        topics: []
      }
    ],
    light: [
      {
        name: "DAI",
        address: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
        description: "DAI on Base",
        topics: []
      }
    ]
  },
  
  // BSC (Binance Smart Chain)
  bsc: {
    heavy: [
      {
        name: "PancakeSwap Router V2",
        address: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
        description: "DEX router",
        topics: []
      },
      {
        name: "BUSD Token",
        address: "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56",
        description: "Binance USD stablecoin",
        topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
      },
      {
        name: "WBNB",
        address: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c",
        description: "Wrapped BNB",
        topics: []
      }
    ],
    medium: [
      {
        name: "USDT",
        address: "0x55d398326f99059fF775485246999027B3197955",
        description: "Tether on BSC",
        topics: []
      }
    ],
    light: [
      {
        name: "USDC",
        address: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
        description: "USDC on BSC",
        topics: []
      }
    ]
  },
  
  // Avalanche C-Chain
  avalanche: {
    heavy: [
      {
        name: "Trader Joe Router",
        address: "0x60aE616a2155Ee3d9A68541Ba4544862310933d4",
        description: "DEX router",
        topics: []
      },
      {
        name: "USDC.e",
        address: "0xA7D7079b0FEaD91F3e65f86E8915Cb59c1a4C664",
        description: "Bridged USDC",
        topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
      }
    ],
    medium: [
      {
        name: "WAVAX",
        address: "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7",
        description: "Wrapped AVAX",
        topics: []
      }
    ],
    light: [
      {
        name: "USDT.e",
        address: "0xc7198437980c041c805A1EDcbA50c1Ce5db95118",
        description: "Bridged Tether",
        topics: []
      }
    ]
  },

  // Optimism
  optimism: {
    heavy: [
      {
        name: "USDC",
        address: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
        description: "Native USDC on Optimism",
        topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
      },
      {
        name: "Velodrome Router",
        address: "0xa062aE8A9c5e11aaA026fc2670B0D65cCc8B2858",
        description: "DEX router",
        topics: []
      }
    ],
    medium: [
      {
        name: "WETH",
        address: "0x4200000000000000000000000000000000000006",
        description: "Wrapped ETH on Optimism",
        topics: []
      }
    ],
    light: [
      {
        name: "OP Token",
        address: "0x4200000000000000000000000000000000000042",
        description: "Optimism governance token",
        topics: []
      }
    ]
  }
};

// Load generation strategies
export const LOAD_STRATEGIES = {
  // Query without any topic filters - returns ALL events
  scatter: {
    name: "Maximum Scatter",
    description: "Query all events without filtering",
    topics: [],
    includeAllLogs: true
  },
  
  // Query multiple topics to increase result size
  multiTopic: {
    name: "Multi-Topic",
    description: "Query multiple event types simultaneously",
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", // Transfer
      "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925", // Approval
      "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c", // Deposit
      "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65", // Withdrawal
    ]
  },
  
  // Focus on high-frequency events
  highFrequency: {
    name: "High Frequency Events",
    description: "Transfer events only",
    topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"]
  },
  
  // No address filter - query ALL contracts
  chaos: {
    name: "Chaos Mode",
    description: "Query without address filter - ALL contracts (use carefully!)",
    address: null,
    topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"], // Only transfers to limit chaos
    warning: " Queries ALL contracts; can overwhelm nodes!"
  }
};

// Helper to detect chain from RPC URL
export function detectChain(rpcUrl) {
  const patterns = {
    ethereum: [/eth-mainnet/, /ethereum/, /infura\.io\/v3/, /cloudflare-eth/],
    polygon: [/polygon/, /matic/, /polygon-mainnet/],
    arbitrum: [/arbitrum/, /arb1/, /arbitrum-mainnet/],
    base: [/base/, /base-mainnet/],
    bsc: [/bsc/, /binance/, /bnb/],
    avalanche: [/avax/, /avalanche/],
    optimism: [/optimism/, /opt-mainnet/]
  };
  
  const lower = rpcUrl.toLowerCase();
  for (const [chain, patterns] of Object.entries(patterns)) {
    if (patterns.some(pattern => pattern.test(lower))) {
      return chain;
    }
  }
  return null;
}

// Get recommended contracts for a chain
export function getRecommendedContracts(chain, intensity = 'heavy') {
  if (!chain || !LOAD_PROFILES[chain]) {
    return null;
  }
  return LOAD_PROFILES[chain][intensity] || LOAD_PROFILES[chain].heavy;
}

// Generate a filter configuration for maximum load
export function generateLoadFilter(config) {
  const { strategy = 'scatter', address, topics, fromBlock, toBlock } = config;
  const loadStrategy = LOAD_STRATEGIES[strategy] || LOAD_STRATEGIES.scatter;
  
  const filter = {
    fromBlock,
    toBlock
  };
  
  // Add address unless using chaos mode
  if (strategy !== 'chaos' && address) {
    filter.address = address;
  }
  
  // Add topics based on strategy
  if (loadStrategy.topics && loadStrategy.topics.length > 0) {
    filter.topics = [loadStrategy.topics]; // Array of arrays for OR logic
  } else if (topics && topics.length > 0) {
    filter.topics = [topics];
  }
  
  return { filter, strategy: loadStrategy };
}

// Function to generate parallel queries for increased load
export function generateParallelQueries(baseConfig, parallelCount = 3) {
  const queries = [];
  const { fromBlock, toBlock, addresses } = baseConfig;
  const blockRange = toBlock - fromBlock;
  const segmentSize = Math.floor(blockRange / parallelCount);
  
  // If multiple addresses provided, query them in parallel
  if (addresses && addresses.length > 0) {
    for (let i = 0; i < Math.min(parallelCount, addresses.length); i++) {
      queries.push({
        address: addresses[i],
        fromBlock,
        toBlock,
        topics: baseConfig.topics
      });
    }
  } else {
    // Otherwise, split block range for parallel queries
    for (let i = 0; i < parallelCount; i++) {
      const segmentFrom = fromBlock + (i * segmentSize);
      const segmentTo = i === parallelCount - 1 ? toBlock : segmentFrom + segmentSize - 1;
      queries.push({
        address: baseConfig.address,
        fromBlock: segmentFrom,
        toBlock: segmentTo,
        topics: baseConfig.topics
      });
    }
  }
  
  return queries;
}

// Export all known high-activity event signatures
export const EVENT_SIGNATURES = {
  // ERC20 Events
  Transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  Approval: "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
  
  // DEX Events
  Swap: "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
  Sync: "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1",
  Mint: "0x4c209b5fc8ad50758f13e2e1088ba56a560dff690a1c6fef26394f4c03821c4f",
  Burn: "0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496",
  
  // WETH Events
  Deposit: "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c",
  Withdrawal: "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65",
  
  // NFT Events (ERC721)
  TransferNFT: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  ApprovalNFT: "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
  ApprovalForAll: "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31",
  
  // Lending Protocol Events
  Supply: "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61",
  Borrow: "0xb3d084820fb1a9decffb176436bd02558d15fac9b0ddfed8c465bc7359d7dce0",
  Repay: "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051",
  Liquidation: "0xe413a321e8681d831f4dbccbca790d2952b56f977908e45be37335533e005286"
};