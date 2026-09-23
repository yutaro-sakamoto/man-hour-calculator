#!/usr/bin/env bash
# カバレッジを C0 (命令網羅) と C1 (分岐網羅) の両方で測り、基準で判定する。
#
#   ./scripts/coverage.sh           # Rust と TypeScript の両方
#   ./scripts/coverage.sh rust      # 片方だけ
#   ./scripts/coverage.sh web
#
# CI の coverage ジョブはこれをそのまま呼ぶ。基準は Rust ぶんがこのファイル、
# TypeScript ぶんが web/package.json の test:coverage にある。
#
# 行を通ったか (C0) だけでは、`if` の片側しか通っていなくても 100% になる。
# 分岐の両側を通ったか (C1) を並べて見るのはそのため。
set -euo pipefail

cd "$(dirname "$0")/.."

# ---------------------------------------------------------------- 基準
# 入れたときの実測は 行 92.4% / 分岐 78.3%。その少し下に置く。
# 上げるのは、足りないところにテストを足してから。
RUST_MIN_LINES=90
RUST_MIN_BRANCHES=75

# 分岐網羅 (`--branch`) は rustc の不安定機能なので nightly が要る。
# **版を固定する。** 分岐の数え方は nightly のあいだに変わりうるので、
# 固定しないと、コードを触っていないのに数字が動いて CI が赤くなる。
# 上げるときは実測を取り直して、上の基準の注記も書き換える。
RUST_COVERAGE_TOOLCHAIN="${RUST_COVERAGE_TOOLCHAIN:-nightly-2026-09-22}"

target="${1:-all}"
failed=0

rust() {
  # 固定した版が手元に無ければ入れる。CI もここで入る (版を書く場所を 1 つにする)。
  if ! rustup run "$RUST_COVERAGE_TOOLCHAIN" rustc --version > /dev/null 2>&1; then
    rustup toolchain install "$RUST_COVERAGE_TOOLCHAIN" --profile minimal \
      --component llvm-tools-preview || return 1
  fi

  # この関数は `rust || failed=1` の形で呼ぶので、中では set -e が効かない。
  # テストが落ちたのに先へ進んで古い計測結果で判定しないよう、1 つずつ見る。
  #
  # 内訳 (ファイルごと) をログに出す。どこが足りないかはここで見る。
  cargo "+$RUST_COVERAGE_TOOLCHAIN" llvm-cov --workspace --branch --summary-only || return 1
  # 判定は合計だけ。テストを回し直さず、同じ計測結果から JSON で出す。
  local json=target/llvm-cov-summary.json
  cargo "+$RUST_COVERAGE_TOOLCHAIN" llvm-cov report --branch --summary-only --json \
    --output-path "$json" || return 1

  local lines branches
  lines=$(jq '.data[0].totals.lines.percent' "$json")
  branches=$(jq '.data[0].totals.branches.percent' "$json")
  # **読み取れないことを「基準を満たした」と読まない。** 分岐が 0 件
  # (--branch が効いていない) も同じく失敗にする。
  if [ "$(jq '.data[0].totals.branches.count' "$json")" = 0 ]; then
    echo "Rust: 分岐が 1 件も数えられていません (--branch が効いていません)" >&2
    return 1
  fi

  printf 'Rust: C0 (行) %.2f%% (基準 %s%%) / C1 (分岐) %.2f%% (基準 %s%%)\n' \
    "$lines" "$RUST_MIN_LINES" "$branches" "$RUST_MIN_BRANCHES"
  local ok=0
  if awk -v v="$lines" -v m="$RUST_MIN_LINES" 'BEGIN { exit !(v < m) }'; then
    echo "Rust: C0 が基準を下回っています" >&2
    ok=1
  fi
  if awk -v v="$branches" -v m="$RUST_MIN_BRANCHES" 'BEGIN { exit !(v < m) }'; then
    echo "Rust: C1 が基準を下回っています" >&2
    ok=1
  fi
  return $ok
}

web() {
  # Node の組み込みだけで測る。line % が C0、branch % が C1 にあたる。
  # 基準を割ると node --test 自身が 1 で終わる。
  npm --prefix web run --silent test:coverage
}

case "$target" in
  rust) rust || failed=1 ;;
  web) web || failed=1 ;;
  all)
    rust || failed=1
    web || failed=1
    ;;
  *)
    echo "使い方: $0 [rust|web]" >&2
    exit 2
    ;;
esac

exit $failed
