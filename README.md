# Swap Intent Helper

Cross-chain helper contracts that atomically compose a DEX swap with intent creation and funding via the [Eco Routes](https://github.com/eco/eco-routes) protocol.

## Structure

| Directory | Chain | Description |
|-----------|-------|-------------|
| `svm/` | Solana | Anchor program that wraps a DEX swap + Portal publish/fund |
| `evm/` | EVM | Solidity contracts (planned) |
