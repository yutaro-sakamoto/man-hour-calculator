#!/usr/bin/env bash
# 応答の終わりに、貯めた知見を昇格し忘れていないかを見る (Stop フック)。
#
# 見るのは 2 つ。
#   1. 昇格していないものが溜まりすぎていないか (既定 5 件)
#   2. **同じ分類ばかり溜まっていないか** (既定 3 件)。同じところで繰り返し
#      転んでいる合図なので、rules か機械の検査にまとめる頃合い
#
# **どちらも超えるまで何も言わない。** 毎回出ると読まれなくなる。
# モデルを使わない (grep と awk だけ)。止めずに additionalContext を出すだけ。
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

JOURNAL="docs/JOURNAL.md"
THRESHOLD="${JOURNAL_OPEN_THRESHOLD:-5}"
CLUSTER="${JOURNAL_CLUSTER_THRESHOLD:-3}"

[ -f "$JOURNAL" ] || exit 0

# grep は 0 件のときも "0" を出して 1 で終わる。`|| echo 0` と書くと
# "0\n0" が入って比較が壊れる。代入の失敗だけを拾う。
open=$(grep -c '^- 昇格: 未' "$JOURNAL" 2> /dev/null) || open=0

# 未昇格の項目の分類だけを、項目ごとに対にして取り出す。
classes=$(awk '
  /^## / { cls = "" }
  /^- 分類: / { line = $0; sub(/^- 分類: /, "", line); cls = line }
  /^- 昇格: 未/ { if (cls != "") print cls }
' "$JOURNAL" | tr '/' '\n' | sed 's/^ *//; s/ *$//' | grep -v '^$' | sort | uniq -c | sort -rn)

# 閾値を超えた分類だけを残す。
hot=$(echo "$classes" | awk -v n="$CLUSTER" '$1 >= n { $1 = $1 " 件:"; print "  " $0 }')

# どちらも静かなら、何も言わない。
if [ "$open" -lt "$THRESHOLD" ] && [ -z "$hot" ]; then
  exit 0
fi

titles=$(awk '/^## / { t = $0 } /^- 昇格: 未/ { print "  " t }' "$JOURNAL" | head -10)

message="開発日誌に、まだ昇格していない知見が ${open} 件あります。

${titles}"

if [ -n "$hot" ]; then
  message="${message}

**同じところで繰り返し転んでいます。**

${hot}

この分類は、取り決め (.claude/rules/) か機械の検査にまとめられませんか。
雛形は \`./scripts/journal.sh promote rules <名前>\` で出ます。"
fi

message="${message}

段 3 (テスト / lint / scripts/check-sync.sh) に上げられるものはないか見てください。
上げる価値が無いものは \`昇格: 一過性\` にして閉じます。
詳しくは AGENTS.md の「学んだことを持ち越す」。"

if command -v jq > /dev/null 2>&1; then
  jq -n --arg msg "$message" '{
    hookSpecificOutput: { hookEventName: "Stop", additionalContext: $msg }
  }'
else
  python3 - "$message" <<'PY'
import json, sys
print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "Stop",
        "additionalContext": sys.argv[1],
    }
}, ensure_ascii=False))
PY
fi
exit 0
