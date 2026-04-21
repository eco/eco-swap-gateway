export const ecoSwapGatewayAbi = [
  {
    name: "swapAndCreateIntent",
    type: "function",
    inputs: [
      { name: "inputToken", type: "address" },
      { name: "inputAmount", type: "uint256" },
      { name: "outputToken", type: "address" },
      {
        name: "swapCalls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "data", type: "bytes" },
          { name: "value", type: "uint256" },
        ],
      },
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "destination", type: "uint64" },
          { name: "routeTemplate", type: "bytes" },
          { name: "tokensAmountOffset", type: "uint32" },
          { name: "calldataAmountOffset", type: "uint32" },
          { name: "rewardDeadline", type: "uint64" },
          { name: "rewardCreator", type: "address" },
          { name: "rewardProver", type: "address" },
          { name: "flatFee", type: "uint256" },
          { name: "feeNumerator", type: "uint256" },
          { name: "feeDenominator", type: "uint256" },
          { name: "sourceDecimals", type: "uint8" },
          { name: "destinationDecimals", type: "uint8" },
          { name: "allowPartial", type: "bool" },
          { name: "routeType", type: "uint8" },
        ],
      },
      { name: "sweepRecipient", type: "address" },
    ],
    outputs: [{ name: "intentHash", type: "bytes32" }],
    stateMutability: "payable",
  },
  {
    name: "swapAndSelectIntent",
    type: "function",
    inputs: [
      { name: "inputToken", type: "address" },
      { name: "inputAmount", type: "uint256" },
      { name: "outputToken", type: "address" },
      {
        name: "swapCalls",
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "data", type: "bytes" },
          { name: "value", type: "uint256" },
        ],
      },
      { name: "destination", type: "uint64" },
      {
        name: "baseReward",
        type: "tuple",
        components: [
          { name: "deadline", type: "uint64" },
          { name: "creator", type: "address" },
          { name: "prover", type: "address" },
          { name: "nativeAmount", type: "uint256" },
          {
            name: "tokens",
            type: "tuple[]",
            components: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
            ],
          },
        ],
      },
      {
        name: "buckets",
        type: "tuple[]",
        components: [
          { name: "routeHash", type: "bytes32" },
          { name: "rewardAmount", type: "uint256" },
        ],
      },
      { name: "sweepRecipient", type: "address" },
    ],
    outputs: [{ name: "intentHash", type: "bytes32" }],
    stateMutability: "payable",
  },
  {
    name: "IntentCreated",
    type: "event",
    inputs: [
      { name: "intentHash", type: "bytes32", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "swapOutput", type: "uint256", indexed: false },
    ],
  },
  {
    name: "IntentSelected",
    type: "event",
    inputs: [
      { name: "intentHash", type: "bytes32", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "swapOutput", type: "uint256", indexed: false },
      { name: "bucketIndex", type: "uint256", indexed: false },
      { name: "rewardAmount", type: "uint256", indexed: false },
      { name: "bucketsHash", type: "bytes32", indexed: false },
    ],
  },
] as const;
