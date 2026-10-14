# `portal.so` provenance

`tests/common/mod.rs` loads this binary into litesvm at `portal::ID`, so it must stay in sync
with the `portal` crate pinned in `svm/Cargo.toml`.

Built reproducibly from the same upstream commit that dependency resolves to:

```sh
git clone https://github.com/eco/eco-routes-svm.git
cd eco-routes-svm
git checkout 4fba2d395f795cb046a0c55792fc54f4f6a4fda4
solana-verify build --library-name portal \
  --base-image solanafoundation/solana-verifiable-build:4.1.1
cp target/deploy/portal.so <this directory>/portal.so
```

`portal`'s `Cargo.toml` pins `[package.metadata.solana] tools-version = "v1.52"`, so this build
compiles with the same platform-tools (SBF rustc 1.89.0-dev) that `anchor build` uses.

| | |
| --- | --- |
| source | `eco/eco-routes-svm` rev `4fba2d395f795cb046a0c55792fc54f4f6a4fda4` (tag `deploy/v3.0.0`) |
| declared portal ID | `EcoN71qfZMZtxwqW1Ps1kzbNKyfpCEd1izZhh58PqsDb` |
| size | 394184 bytes |
| sha256 (file) | `90ef761f9d064620fd93e2176c9e973f48362504c7ba2581ca65be645b1cb959` |
| `solana-verify get-executable-hash` | `c2f85cf9d748f78c9020605ad487751d3b7de14bfc360680d85b02b975db87af` |

Built **without** `--features mainnet` on purpose: `integration-tests` depends on `portal` and
`eco-swap-gateway` without that feature, so the harness uses the non-mainnet
`eco_svm_std::CHAIN_ID`. A mainnet-built fixture would disagree with it. This is therefore *not*
the binary deployed to mainnet — that one is built with `--features mainnet`.

Rebuild this whenever the `portal` pin in `svm/Cargo.toml` moves, and update the table.
