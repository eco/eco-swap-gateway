export const swapIntentAbi = [
  {
    name: "swapAndCreateIntent",
    type: "function",
    inputs: [
      { name: "inputToken", type: "address" },
      { name: "inputAmount", type: "uint256" },
      { name: "outputToken", type: "address" },
      {
        name: "calls",
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
          { name: "scalarNum", type: "uint256" },
          { name: "scalarDenom", type: "uint256" },
          { name: "allowPartial", type: "bool" },
        ],
      },
    ],
    outputs: [{ name: "intentHash", type: "bytes32" }],
    stateMutability: "nonpayable",
  },
  {
    name: "IntentCreated",
    type: "event",
    inputs: [
      { name: "intentHash", type: "bytes32", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "rewardToken", type: "address", indexed: false },
      { name: "swapOutput", type: "uint256", indexed: false },
      { name: "routeAmount", type: "uint256", indexed: false },
      { name: "destination", type: "uint64", indexed: false },
    ],
  },
] as const;
