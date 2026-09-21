#!/usr/bin/env bash
# 箱を作ったあとの支度。開いてすぐ全部の検証が回せる状態にする。
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> rust toolchain"
# rust-toolchain.toml に書いてある版・component・target を取りに行かせる。
rustup show

echo "==> npm (web)"
npm --prefix web ci

echo "==> npm (e2e)"
npm --prefix e2e ci

# Playwright は CI と同じ Chromium を使う。`--with-deps` で足りない
# 共有ライブラリも入る (これが無いと起動だけ失敗する)。
echo "==> playwright chromium"
npx --prefix e2e playwright install --with-deps chromium

echo
echo "支度ができました。次のどれかから:"
echo "  cargo xtask build                 # dist/app.html と dist/index.html を作る"
echo "  cargo test --workspace            # Rust の単体テスト"
echo "  npm --prefix web run check        # 整形・lint・型・TS のテスト"
echo "  cd e2e && npx playwright test     # file:// のまま通しで確かめる"
