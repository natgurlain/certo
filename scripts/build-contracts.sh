#!/usr/bin/env bash
# Build all contract wasm into res/ (real contract, mock token, weakened guard
# variants) and write res/SHA256SUMS. Needs Rust with the wasm32-unknown-unknown
# target. Uses the flags `cargo near build` applies: `--cfg near` (near-sdk
# then calls the on-chain host functions for sha256, ed25519_verify, panics;
# without it the SDK compiles pure-Rust fallbacks into the wasm) and
# `-C link-arg=-s`. Paths are remapped so the wasm embeds no local directories.
#
# Every wasm is then lowered to the MVP feature set with binaryen `wasm-opt`
# (pinned below, fetched by npx on first use; set WASM_OPT to use another
# wasm-opt of the same version) and validated as MVP. Recent rustc ships a
# wasm32 std built with post-MVP features (sign-ext, bulk-memory,
# nontrapping float-to-int) that `-C target-cpu=mvp` does not remove; older
# nearcore (2.10.0, the sandbox the demo uses) rejects such wasm with
# `PrepareError: Deserialization`. docs/CONTRACT_NOTES.md has the details.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
T=wasm32-unknown-unknown
GUARDS="1 2 3 4 5 6 7 8 16"
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
export RUSTFLAGS="--cfg near -C link-arg=-s --remap-path-prefix=$CARGO_HOME_DIR=/cargo --remap-path-prefix=$ROOT=/src ${RUSTFLAGS:-}"

BINARYEN_VERSION=132.0.0
WASM_OPT="${WASM_OPT:-npx --yes -p binaryen@$BINARYEN_VERSION wasm-opt}"
POST_MVP="--enable-bulk-memory --enable-bulk-memory-opt --enable-sign-ext --enable-nontrapping-float-to-int --enable-mutable-globals --enable-multivalue --enable-reference-types"
LOWER="--signext-lowering --llvm-memory-copy-fill-lowering --llvm-nontrapping-fptoint-lowering --strip-target-features -O2"
# lower <in.wasm> <out.wasm>: rewrite post-MVP instructions as MVP ones, then fail unless the result validates as MVP
lower() {
  $WASM_OPT $POST_MVP $LOWER "$1" -o "$2"
  $WASM_OPT --mvp-features --enable-mutable-globals -q "$2" -o /dev/null
}

rustup target list --installed 2>/dev/null | grep -q "^$T$" || rustup target add "$T"
echo "rustc: $(rustc --version)"
echo "wasm-opt: $($WASM_OPT --version)"

mkdir -p res/guards
cargo build --locked --quiet --release --target "$T" --target-dir target/wasm -p certo -p mock-usdc
lower target/wasm/$T/release/certo.wasm res/certo.wasm
lower target/wasm/$T/release/mock_usdc.wasm res/mock_usdc.wasm

for g in $GUARDS; do
  cargo build --locked --quiet --release --target "$T" --target-dir "target/wasm-no_g$g" -p certo --features "no_g$g"
  lower "target/wasm-no_g$g/$T/release/certo.wasm" "res/guards/certo_no_g$g.wasm"
done

if command -v sha256sum >/dev/null; then SHA="sha256sum"; else SHA="shasum -a 256"; fi
( cd res && $SHA certo.wasm mock_usdc.wasm guards/certo_no_g*.wasm > SHA256SUMS )
cat res/SHA256SUMS
