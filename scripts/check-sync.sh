#!/usr/bin/env bash
# 文書・仕様・コードが離れていないかを、**機械的に**確かめる。
#
# ここで見るのは「読めば分かる食い違い」だけ。人手のレビューや、
# モデルを回すレビューの代わりではなく、**そこへ持ち込む前に潰せるもの**を
# 潰すためのもの。速く、外部に何も問い合わせず、必ず同じ答えを返す。
#
#   ./scripts/check-sync.sh          # 見つかったら 1 で終わる
#   ./scripts/check-sync.sh --quiet  # 食い違いだけを出す
#
# CI で毎回回している。Claude Code は応答の終わりにも回す (.claude/settings.json)。
set -uo pipefail

cd "$(dirname "$0")/.."

quiet=false
[ "${1:-}" = "--quiet" ] && quiet=true

problems=0

say() { $quiet || echo "$@"; }
bad() {
  echo "ずれ: $*" >&2
  problems=$((problems + 1))
}

# ---------------------------------------------------------------- ABI の版
# JS と Rust と文書で、同じ番号を名乗っていること。
# 食い違うと、起動時の照合で黙って弾かれる側が出る。
abi_rs=$(grep -oP 'pub const VERSION: f64 = \K[0-9]+' crates/core/src/abi.rs | head -1)
abi_ts=$(grep -oP 'export const ABI_VERSION = \K[0-9]+' web/src/abi.ts | head -1)
abi_doc=$(grep -oP '^# JS ↔ WASM の ABI \(version \K[0-9]+' docs/ABI.md | head -1)
say "ABI: rust=$abi_rs ts=$abi_ts doc=$abi_doc"
if [ -z "$abi_rs" ] || [ -z "$abi_ts" ] || [ -z "$abi_doc" ]; then
  bad "ABI の版を読み取れません (rust=$abi_rs ts=$abi_ts doc=$abi_doc)"
elif [ "$abi_rs" != "$abi_ts" ] || [ "$abi_rs" != "$abi_doc" ]; then
  bad "ABI の版が揃っていません (rust=$abi_rs ts=$abi_ts doc=$abi_doc)"
fi

# --------------------------------------------------- Kani のハーネス ⇔ 文書
# docs/VERIFICATION.md は「どの約束を、どの強さで確かめているか」の対応表。
# ハーネスを足して表に書き忘れると、表が実態より小さくなる。
harnesses=$(grep -rn -A 2 '#\[kani::proof\]' --include='*.rs' crates \
  | grep -oP 'fn \K\w+' | sort -u)
say "Kani ハーネス: $(echo "$harnesses" | grep -c .) 個"
while read -r name; do
  [ -z "$name" ] && continue
  grep -q "$name" docs/VERIFICATION.md \
    || bad "Kani の $name が docs/VERIFICATION.md に載っていません"
done <<< "$harnesses"

# -------------------------------------------------- TLA+ の仕様 ⇔ 実装
# 仕様のコメントは実装の関数を名指ししている。名前が変わったまま放置すると、
# 「同じ番人が両方にある」という前提が黙って崩れる。
for fn in $(grep -oP 'Service::\K\w+' spec/*.tla | cut -d: -f2- | sort -u); do
  grep -qE "fn $fn\b" crates/api/src/service.rs \
    || bad "spec が名指しする Service::$fn が service.rs にありません"
done

# 仕様は .cfg が無いと**何も検査せずに緑になる**。
shopt -s nullglob
specs=(spec/*.tla)
if [ ${#specs[@]} -eq 0 ]; then
  bad "spec/*.tla が 1 つもありません (TLC は何も検査していません)"
fi
for spec in "${specs[@]}"; do
  cfg="${spec%.tla}.cfg"
  [ -f "$cfg" ] || bad "$spec に対応する .cfg がありません"
  grep -q '^INVARIANT' "$cfg" \
    || bad "$cfg に INVARIANT がありません (不変条件を検査していません)"
done
say "TLA+: ${#specs[@]} 個の仕様"

# ------------------------------------------------------- 文書のなかのリンク
# 相対リンクの先が無くなっていないこと。
links=0
missing=0
while read -r file link; do
  links=$((links + 1))
  target="${link%%#*}"
  [ -z "$target" ] && continue
  # 綴り (scheme) が付いているものは、この場では確かめようがない。
  # `http:` `mailto:` のほか、本文に出てくる `attachment:` もここで落ちる。
  case "$target" in *:*) continue ;; esac
  resolved="$(dirname "$file")/$target"
  if [ ! -e "$resolved" ]; then
    bad "$file の [...]($link) が指す先がありません"
    missing=$((missing + 1))
  fi
done < <(
  # `file:リンク` を**最初のコロンだけ**で割る。リンクの中にもコロンは出る
  # (`attachment:a1` や `https://…`)。
  grep -roP '\]\(\K[^)]+' --include='*.md' \
    README.md README_JP.md docs .claude dev-skills/README.md dev-skills/*/SKILL.md 2>/dev/null \
    | awk '{ i = index($0, ":"); print substr($0, 1, i - 1), substr($0, i + 1) }'
)
say "文書のリンク: $links 本 (切れ $missing)"

# -------------------------------------------- 保存データと表の版 ⇔ 移行の段
# `STORE_VERSION` を上げたら、サーバの表にも段が要る (その逆も)。
store_version=$(grep -oP 'pub const STORE_VERSION: u32 = \K[0-9]+' crates/api/src/store/mod.rs)
schema_steps=$(grep -cP '^\s+// 版 [0-9]+:' crates/server/src/store/schema.rs)
say "保存データの版=$store_version / 表の段=$schema_steps"
# **読み取れないことを「ずれ無し」と読まない。** ファイルを動かしたときに
# 黙って検査が消えるのを防ぐ (実際に store.rs → store/mod.rs で起きた)。
if [ -z "$store_version" ]; then
  bad "STORE_VERSION を読み取れません (crates/api/src/store/mod.rs)"
elif [ "$store_version" -gt "$schema_steps" ]; then
  bad "保存データの版 ($store_version) に対して、表の段 ($schema_steps) が足りません"
fi

# ------------------------------------------------ 次に持っていく道具 (skills)
# `dev-skills/` は次のプロジェクトへ持っていく置き場。Claude Code は
# frontmatter の `name` で呼ぶので、**ディレクトリ名とずれると呼べなくなる**。
# ずれても何も起きないまま気づけない種類の食い違いなので、機械で見る。
skills=0
for dir in dev-skills/*/; do
  name="$(basename "$dir")"
  skills=$((skills + 1))
  if [ ! -f "$dir/SKILL.md" ]; then
    bad "dev-skills/$name に SKILL.md がありません"
    continue
  fi
  declared=$(grep -m1 -oP '^name: \K\S+' "$dir/SKILL.md")
  if [ -z "$declared" ]; then
    bad "dev-skills/$name/SKILL.md の frontmatter に name がありません"
  elif [ "$declared" != "$name" ]; then
    bad "dev-skills/$name/SKILL.md が name: $declared を名乗っています"
  fi
done
say "skills: $skills 個"

# ------------------------------------------------------- 日誌の昇格の段
# `昇格:` は未昇格を数える手がかり。綴りを間違えると**静かに数から漏れる**。
# 段は最初の語だけを見る (後ろに置き場所を書いてよい)。
journal="docs/JOURNAL.md"
if [ -f "$journal" ]; then
  entries=$(grep -cP '^## [0-9]{4}-' "$journal")
  promoted=$(grep -cP '^- 昇格: ' "$journal")
  say "日誌: $entries 件 (昇格の行 $promoted 本)"
  if [ "$entries" -ne "$promoted" ]; then
    bad "日誌の項目 ($entries) と 昇格: の行 ($promoted) の数が合いません"
  fi
  while read -r stage; do
    case "$stage" in
      未 | rules | 機械 | skill | 一過性) ;;
      *) bad "日誌に知らない昇格の段があります: $stage" ;;
    esac
  done < <(grep -oP '^- 昇格: \K\S+' "$journal" | sort -u)
fi

# ----------------------------------------------------------------------
if [ "$problems" -eq 0 ]; then
  say "ずれはありません。"
  exit 0
fi
echo "ずれが $problems 件あります。" >&2
exit 1
