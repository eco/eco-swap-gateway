# `portal.so` provenance

`tests/common/mod.rs` loads this binary into litesvm at `portal::ID`, so it must stay in sync
with the `portal` crate pinned in `svm/Cargo.toml`.

Built reproducibly from the same upstream commit that dependency resolves to:

```sh
git clone https://github.com/eco/eco-routes-svm.git
cd eco-routes-svm
git checkout aa8059ee67ac116d47693ec83926078276c083f7
solana-verify build --library-name portal \
  --base-image solanafoundation/solana-verifiable-build:4.1.1
cp target/deploy/portal.so <this directory>/portal.so
```

`portal`'s `Cargo.toml` pins `[package.metadata.solana] tools-version = "v1.52"`, so this build
compiles with the same platform-tools (SBF rustc 1.89.0-dev) that `anchor build` uses.

| | |
| --- | --- |
| source | `eco/eco-routes-svm` rev `aa8059ee67ac116d47693ec83926078276c083f7` |
| declared portal ID | `EcoowmRRrMyYtQCuh5fCvMDWcD6B9ZDZkpgedf2bWKXi` |
| size | 383384 bytes |
| sha256 (file) | `22352a4d3581b49946061a85f8b762ea23aa0591b23fbf4fa4fe5c74425824c4` |
| `solana-verify get-executable-hash` | `344a1881f7f6ea0c9b70cf26c1ead498d610f446567ecd3560e8159b634129c7` |

Built **without** `--features mainnet` on purpose: `integration-tests` depends on `portal` and
`eco-swap-gateway` without that feature, so the harness uses the non-mainnet
`eco_svm_std::CHAIN_ID`. A mainnet-built fixture would disagree with it. This is therefore *not*
the binary deployed to mainnet — that one is built with `--features mainnet`.

Rebuild this whenever the `portal` pin in `svm/Cargo.toml` moves, and update the table.
