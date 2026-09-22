#!/usr/bin/env bash
# 応答の終わりに、昇格していない知見が溜まりすぎていないかを見る (Stop フック)。
#
# **閾値を超えるまで何も言わない。** 毎回出ると読まれなくなる。
# モデルを使わない (grep -c だけ)。止めずに additionalContext を出すだけ。
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

JOURNAL="docs/JOURNAL.md"
THRESHOLD="${JOURNAL_OPEN_THRESHOLD:-5}"

[ -f "$JOURNAL" ] || exit 0
# grep は 0 件のときも "0" を出して 1 で終わる。`|| echo 0` と書くと
# "0\n0" が入って比較が壊れる。代入の失敗だけを拾う。
open=$(grep -c '^- 昇格: 未\b' "$JOURNAL" 2> /dev/null) || open=0
[ "$open" -lt "$THRESHOLD" ] && exit 0

titles=$(awk '/^## / { t = $0 } /^- 昇格: 未/ { print "  " t }' "$JOURNAL" | head -10)
message="開発日誌に、まだ何にも昇格していない知見が ${open} 件あります。

${titles}

段 3 (テスト / lint / scripts/check-sync.sh) に上げられるものはないか見てください。
上げる価値が無いものは \`昇格: 一過性\` にして閉じます。
詳しくは docs/JOURNAL.md の冒頭。"

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
