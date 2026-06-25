# Swap Intent Helper

Cross-chain helper contracts that atomically compose a DEX swap with intent creation and funding via the [Eco Routes](https://github.com/eco/eco-routes) protocol.

## Security

The contracts in this repository are **deployed on-chain and custody user funds.** A
vulnerability that becomes public before it is fixed can be exploited immediately and
irreversibly — public disclosure of an unpatched bug is itself the attack.

**If you find a security vulnerability, report it privately. Do not open a public pull
request, push a branch, or open a public issue.** Report it through the
[**Security tab → "Report a vulnerability"**](https://github.com/eco/eco-swap-gateway/security),
which opens a private advisory visible only to you and the maintainers. Because it is
often unclear whether affected code is already deployed, treat **any** security fix as
sensitive until a maintainer confirms the code is not deployed.

See [`SECURITY.md`](./SECURITY.md) for the full policy, including specific instructions
for AI coding agents. This applies to humans and automated tools alike.

## Structure

| Directory | Chain | Description |
|-----------|-------|-------------|
| `svm/` | Solana | Anchor program that wraps a DEX swap + Portal publish/fund |
| `evm/` | EVM | Solidity contracts (planned) |
