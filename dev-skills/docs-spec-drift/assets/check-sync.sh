#!/usr/bin/env bash
# 文書・仕様・コードが離れていないかを、**機械的に**確かめる骨。
#
# ここで見るのは「読めば分かる食い違い」だけ。人手のレビューや、モデルを
# 回すレビューの代わりではなく、**そこへ持ち込む前に潰せるもの**を潰すもの。
# 速く、外部に何も問い合わせず、必ず同じ答えを返す。
#
#   ./scripts/check-sync.sh          # 見つかったら 1 で終わる
#   ./scripts/check-sync.sh --quiet  # 食い違いだけを出す (フックから呼ぶとき)
#
# `@@NAME@@` は差し替える箇所。シェルでは `<<<…>>>` が here-string になって
# しまうので、この綴りを使っている。
set -uo pipefail

cd "$(dirname "$0")/.."

quiet=false
[ "${1:-}" = "--quiet" ] && quiet=true
problems=0
say() { $quiet || echo "$@"; }
bad() { echo "ずれ: $*" >&2; problems=$((problems + 1)); }

# ------------------------------------------------ 1. 同じ番号を名乗る複数箇所
# 食い違うと、起動時の照合で黙って弾かれる側が出る。
abi_rs=$(grep -oP 'pub const VERSION: f64 = \K[0-9]+' @@RUST_ABI@@ | head -1)
abi_ts=$(grep -oP 'export const ABI_VERSION = \K[0-9]+' @@TS_ABI@@ | head -1)
abi_doc=$(grep -oP '^# .*\(version \K[0-9]+' @@DOC_ABI@@ | head -1)
say "ABI: rust=$abi_rs ts=$abi_ts doc=$abi_doc"
# **読み取れないことを「ずれ無し」と読まない。** ファイルを動かしたときに
# 検査が黙って消えるのを防ぐ (実際に起きた)。
if [ -z "$abi_rs" ] || [ -z "$abi_ts" ] || [ -z "$abi_doc" ]; then
  bad "ABI の版を読み取れません (rust=$abi_rs ts=$abi_ts doc=$abi_doc)"
elif [ "$abi_rs" != "$abi_ts" ] || [ "$abi_rs" != "$abi_doc" ]; then
  bad "ABI の版が揃っていません (rust=$abi_rs ts=$abi_ts doc=$abi_doc)"
fi

# --------------------------------------------------- 2. 一覧への載せ忘れ
# ハーネスを足して表に書き忘れると、表が実態より小さくなる。
harnesses=$(grep -rn -A 2 '#\[kani::proof\]' --include='*.rs' @@SRC_DIR@@ \
  | grep -oP 'fn \K\w+' | sort -u)
say "Kani ハーネス: $(echo "$harnesses" | grep -c .) 個"
while read -r name; do
  [ -z "$name" ] && continue
  grep -q "$name" @@VERIFICATION_DOC@@ \
    || bad "Kani の $name が @@VERIFICATION_DOC@@ に載っていません"
done <<< "$harnesses"

# ------------------------------------------- 3. 仕様が名指しする実装の実在
# 名前が変わったまま放置すると「同じ番人が両方にある」前提が黙って崩れる。
for fn in $(grep -oP '@@TYPE@@::\K\w+' spec/*.tla | cut -d: -f2- | sort -u); do
  grep -qE "fn $fn\b" @@IMPL_FILE@@ \
    || bad "spec が名指しする @@TYPE@@::$fn が実装にありません"
done

# ------------------------------------------------- 4. 検査が空になっていないか
# **`.cfg` が無い / INVARIANT が無いと、TLC は何も検査せずに緑になる。**
shopt -s nullglob
specs=(spec/*.tla)
[ ${#specs[@]} -eq 0 ] && bad "spec/*.tla が 1 つもありません"
for spec in "${specs[@]}"; do
  cfg="${spec%.tla}.cfg"
  [ -f "$cfg" ] || bad "$spec に対応する .cfg がありません"
  grep -q '^INVARIANT' "$cfg" || bad "$cfg に INVARIANT がありません"
done
say "TLA+: ${#specs[@]} 個の仕様"

# ---------------------------------------------------- 5. 文書のリンク切れ
links=0
missing=0
while read -r file link; do
  links=$((links + 1))
  target="${link%%#*}"
  [ -z "$target" ] && continue
  # 綴り (scheme) が付いているものはこの場では確かめようがない。
  case "$target" in *:*) continue ;; esac
  [ -e "$(dirname "$file")/$target" ] || {
    bad "$file の [...]($link) が指す先がありません"
    missing=$((missing + 1))
  }
done < <(
  # `file:リンク` を**最初のコロンだけ**で割る。リンクの中にもコロンは出る。
  grep -roP '\]\(\K[^)]+' --include='*.md' README.md docs .claude 2>/dev/null \
    | awk '{ i = index($0, ":"); print substr($0, 1, i - 1), substr($0, i + 1) }'
)
say "文書のリンク: $links 本 (切れ $missing)"

# ------------------------------------------------- 6. 版と移行の段が揃うか
store_version=$(grep -oP 'pub const STORE_VERSION: u32 = \K[0-9]+' @@STORE_FILE@@)
schema_steps=$(grep -cP '^\s+// 版 [0-9]+:' @@SCHEMA_FILE@@)
say "保存データの版=$store_version / 表の段=$schema_steps"
if [ -z "$store_version" ]; then
  bad "STORE_VERSION を読み取れません (場所が変わった?)"
elif [ "$store_version" -gt "$schema_steps" ]; then
  bad "保存データの版 ($store_version) に対して、移行の段 ($schema_steps) が足りません"
fi

# ----------------------------------------------------------------------
if [ "$problems" -eq 0 ]; then
  say "ずれはありません。"
  exit 0
fi
echo "ずれが $problems 件あります。" >&2
exit 1
