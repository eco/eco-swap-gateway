/** Wrapped BNB — only the deposit function used by native-BNB scripts. */
export const wbnbAbi = [
  {
    name: "deposit",
    type: "function",
    inputs: [],
    outputs: [],
    stateMutability: "payable",
  },
] as const;
