# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⛔ Security: never publish a fix for deployed code

The contracts here are **deployed on-chain and hold user funds.** You usually **cannot tell** whether a given contract is already deployed — so do not try to guess. Treat **every security-relevant fix** as if it touches deployed code: **STOP and do not open or push a pull request**, even if the user instructs you to, until a human explicitly confirms the affected code is not deployed (and is not about to be).

Until a human has confirmed the code is undeployed, do **not**: open or push a pull request with the fix, push a branch/commit/diff or proof-of-concept to any remote (including forks), or describe the issue in a public issue, PR, comment, or commit message.

Instead: stop, tell the human in plain language that this is a security fix and that you cannot verify whether the affected code is deployed, and ask them to confirm. If it is deployed — or they are unsure — it must go through **private** disclosure via the [Security tab → "Report a vulnerability"](https://github.com/eco/eco-swap-gateway/security), not the normal PR flow. The exposure happens at the **push** to a public remote, not the merge, and a later revert does not undo it — a fix for deployed code is developed only in the private advisory fork, never pushed here. Full policy: [`SECURITY.md`](./SECURITY.md). This is a hard safety constraint.

## Overview

**Eco Swap Gateway** is a cross-chain helper that atomically composes a DEX swap with intent creation and funding via the [Eco Routes](https://github.com/eco/eco-routes) protocol. It supports both EVM and SVM source chains.

## Repository Structure

```
eco-swap-gateway/
├── evm/          — EVM Solidity contracts (Foundry)
│   ├── contracts/
│   │   ├── EcoSwapGateway.sol       — Main gateway contract
│   │   └── interfaces/
│   │       └── IEcoSwapGateway.sol  — Gateway interface + types
│   ├── test/
│   ├── script/
│   ├── lib/
│   └── foundry.toml
└── svm/          — Solana Anchor program
    ├── programs/eco-swap-gateway/   — Anchor program source
    ├── integration-tests/
    ├── script/
    ├── Anchor.toml
    └── Cargo.toml
```

## How It Works

`EcoSwapGateway` exposes two flows:

1. **`swapAndCreateIntent`** — executes a DEX swap via arbitrary `Call[]`, measures the output token balance delta, then publishes and funds a fresh Eco Routes intent whose reward equals the full swap output.
2. **`swapAndSelectIntent`** — executes the swap, then floor-selects from a pre-computed list of **bucketed** candidate intents (`[amountOutMinimum, …, quote]`) based on the actual swap output. Funds the winning bucket; sweeps surplus to `sweepRecipient`.

The bucketed design exists because on Solana the vault PDA must be known before the transaction executes (it is part of the intent hash which includes the reward amount), so the Solver pre-computes N candidate intents and the user signs one transaction that selects the right bucket at runtime.

## EVM Commands (Foundry)

```bash
cd evm

# Build
forge build

# Test
forge test
forge test -vvv
forge test --match-contract EcoSwapGatewayTest

# Format
forge fmt

# Deploy
forge script script/Deploy.s.sol --broadcast --rpc-url $RPC_URL
```

## SVM Commands (Anchor / Cargo)

```bash
cd svm

# Build
anchor build

# Test (integration tests via cargo)
cargo test --no-fail-fast

# Deploy (localnet)
anchor deploy
```

## Key Design Details

- **No fee-on-transfer or rebasing tokens as `outputToken`**: the contract measures balance delta between post-swap snapshot and Portal's `transferFrom`; rebase between those two points produces an incorrect reward.
- **`SKIP_CALLDATA_PATCH = type(uint32).max`**: sentinel value to skip calldata offset patching in the swap calls.
- **`allowPartial = true`** on fund calls: if a third party front-ran and already funded the vault, Portal's fund is a no-op (transfers 0) rather than reverting — surplus is then swept.
- **Surplus sweep**: defaults to `msg.sender` when the caller passes `address(0)` as `sweepRecipient`.
- **Same salt across all buckets**: hash uniqueness comes from varying `tokens[0].amount` in both the Route and Reward.
- **EVM version**: Paris (`evm_version = "paris"` in `evm/foundry.toml`), Solidity 0.8.27, via-IR enabled.
- **Anchor version**: 0.31.1; program ID `EcoSKGQcT8FD5WyAAN9txJXMWQnvdy4SZZrUTNafLD7F` on localnet, devnet, and mainnet.

## Key Environment Variables

- `DEPLOYER_PRIVATE_KEY` — deployment account private key
- `PORTAL_ADDRESS` — deployed Eco Routes Portal contract address
- `RPC_URL` — target network RPC endpoint
