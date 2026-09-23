#!/usr/bin/env bash
# 関数ごとの複雑度を測って、上から並べる。
#
#   ./scripts/complexity.sh        # 上位 15 件ずつ
#   ./scripts/complexity.sh 40     # 上位 40 件ずつ
#
# **判定はここではしない。** 上限はふだんの lint が見ている:
#   Rust       … 認知的複雑度。clippy.toml の上限を clippy が見る
#   TypeScript … 循環的複雑度。web/eslint.config.js の complexity を ESLint が見る
# ここは「上限の手前にどれだけ並んでいるか」を見るためのもの。上限を
# 下げたいときや、割る関数を選ぶときに使う。CI もログに出している。
#
# Rust と TypeScript で物差しが違う (認知的 / 循環的) のは、どちらも
# 道具を増やさずに測れるものを選んだため。数字どうしは比べない。
set -euo pipefail

cd "$(dirname "$0")/.."

top="${1:-15}"
conf="$(mktemp -d)"
trap 'rm -rf "$conf"' EXIT

# `head` は読み終える前に閉じるので、pipefail の下では前段が SIGPIPE で
# 落ちたことになる (141)。最後まで読んでから切る。
first() { awk -v n="$top" 'NR <= n'; }

# 上限を 0 にして、**全部の関数**に警告を出させてから数字を拾う。
# 別の target ディレクトリを使うのは、ふだんの clippy の結果 (上限つき) と
# 取り違えないため。
echo "== Rust: 認知的複雑度 (上限 $(grep -oP '^cognitive-complexity-threshold = \K[0-9]+' clippy.toml))"
echo 'cognitive-complexity-threshold = 0' > "$conf/clippy.toml"
CLIPPY_CONF_DIR="$conf" CARGO_TARGET_DIR=target/complexity \
  cargo clippy --quiet --workspace --all-targets --message-format=json \
  -- -A clippy::all -W clippy::cognitive_complexity 2> /dev/null \
  | jq -r 'select(.reason == "compiler-message"
                  and .message.code.code == "clippy::cognitive_complexity")
           | .message as $m | $m.spans[0]
           | "\($m.message | capture("\\((?<n>[0-9]+)/").n)\t\(.file_name):\(.line_start)"' \
  | sort -u | sort -t$'\t' -k1,1nr | first

echo
echo "== TypeScript: 循環的複雑度 (上限 $(grep -oP 'complexity: \["error", \K[0-9]+' web/eslint.config.js))"
(cd web && npx eslint src --rule '{"complexity": ["warn", 0]}' --format json || true) \
  | jq -r --arg root "$PWD/" '.[] | .filePath as $f | .messages[]
           | select(.ruleId == "complexity")
           | "\(.message | capture("complexity of (?<n>[0-9]+)").n)\t\($f | ltrimstr($root)):\(.line)"' \
  | sort -t$'\t' -k1,1nr | first
