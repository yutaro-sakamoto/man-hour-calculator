#!/usr/bin/env bash
# 応答の終わりに、文書・仕様・コードのずれを見る (Claude Code の Stop フック)。
#
# **ずれが無ければ何も言わない。** 毎回口を出すと読まれなくなる。
# モデルは一切使わないので費用もかからない (grep と awk だけ)。
#
# 出すのは `additionalContext` だけで、止めはしない。作業の途中で一時的に
# ずれるのはふつうのことなので、止めると邪魔になる。
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" || exit 0

# 変更が何も無いなら見る必要がない。
if git diff --quiet HEAD 2>/dev/null && [ -z "$(git ls-files --others --exclude-standard 2>/dev/null)" ]; then
  exit 0
fi

problems=$(./scripts/check-sync.sh --quiet 2>&1)
[ -z "$problems" ] && exit 0

message="文書・仕様・コードにずれがあります。同じ変更のなかで直してください。

$problems

詳しくは AGENTS.md の「文書と仕様を実態から離さない」。"

# jq があれば使う。無ければ素朴に組み立てる (依存を増やさない)。
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
