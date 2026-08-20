# `portal.so` provenance

`tests/common/mod.rs` loads this binary into litesvm at `portal::ID`, so it must stay in sync
with the `portal` crate pinned in `svm/Cargo.toml`.

Built reproducibly from the same upstream commit that dependency resolves to:

```sh
git clone --depth 1 --branch v2.0.0 https://github.com/eco/eco-routes-svm.git
cd eco-routes-svm   # 3bace91f32a3e1c0dfb715992ac0ce8165bed67b
solana-verify build --library-name portal \
  --base-image solanafoundation/solana-verifiable-build:2.3.8
cp target/deploy/portal.so <this directory>/portal.so
```

| | |
| --- | --- |
| source | `eco/eco-routes-svm` tag `v2.0.0` = `3bace91f32a3e1c0dfb715992ac0ce8165bed67b` |
| declared portal ID | `EcooswwC1NggsckZyF5SeAL9WsgJs3UhPbrqY1apV73F` |
| size | 433520 bytes |
| sha256 (file) | `5274b54b3458e02e117ce2c2856899310ac78c332f43e9bb5913b6eb1f8d4ecd` |
| `solana-verify get-executable-hash` | `6e721de3261d54d1c30820ae9b44bd539fbb9a347861a511ff78fd34b77160e2` |

Built **without** `--features mainnet` on purpose: `integration-tests` depends on `portal` and
`eco-swap-gateway` without that feature, so the harness uses the non-mainnet
`eco_svm_std::CHAIN_ID`. A mainnet-built fixture would disagree with it. This is therefore *not*
the binary deployed to mainnet — that one is built with `--features mainnet` and hashes to
`8909965ebbab6192753d0c5a51d8ea747f327906005576d06ee3d6c5a3a4c539`.

Rebuild this whenever the `portal` pin in `svm/Cargo.toml` moves, and update the table.
