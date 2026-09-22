#!/usr/bin/env bash
# 開発日誌。踏んだ穴・読み違い・設計判断を貯めて、昇格させるための道具。
#
#   ./scripts/journal.sh new [要約]  雛形を追記して開く
#   ./scripts/journal.sh open        昇格: 未 の一覧
#   ./scripts/journal.sh stats       分類ごとの件数
#
# 書くだけでは効かない。**段 3 (機械の検査) に上げて初めて守られる。**
set -euo pipefail

cd "$(dirname "$0")/.."
JOURNAL="docs/JOURNAL.md"

ensure() {
  [ -f "$JOURNAL" ] && return
  mkdir -p "$(dirname "$JOURNAL")"
  cat > "$JOURNAL" <<'HEADER'
# 開発日誌

踏んだ穴・読み違い・設計判断を追記していく。新しいものが上。

`昇格:` は次の 5 つのどれか。

| 値 | 意味 |
|---|---|
| `未` | まだ何にもしていない |
| `rules` | AGENTS.md か .claude/rules/ に書いた |
| `機械` | テスト / lint / check-sync.sh にした。**ここまで来て初めて守られる** |
| `skill` | dev-skills/ に移した |
| `一過性` | 上げる価値が無いと判断した |

ふつうのバグは書かない (回帰テストを添えれば、テストが記録になる)。

---

HEADER
}

new_entry() {
  ensure
  local summary="${1:-<<<一行の要約>>>}"
  local today
  today="$(date +%Y-%m-%d)"
  local entry
  entry=$(cat <<ENTRY
## ${today} — ${summary}

- 分類: <<<ci / 環境 / 読み違い / 設計 / 検証 / リリース / UI>>>
- 症状: <<<何が起きたか。どう誤解したか>>>
- 原因: <<<なぜそうなったか>>>
- 手当て: <<<その場で何をしたか>>>
- 昇格: 未

ENTRY
)
  # 見出しの直後 (--- の次) に差し込む。追記だけで、既存は触らない。
  local tmp
  tmp="$(mktemp)"
  awk -v entry="$entry" '
    !inserted && /^---$/ { print; print ""; print entry; inserted = 1; next }
    { print }
    END { if (!inserted) { print ""; print entry } }
  ' "$JOURNAL" > "$tmp"
  mv "$tmp" "$JOURNAL"
  echo "$JOURNAL に雛形を足しました。"
  # `[ … ] && …` を最後に置くと、偽のときに関数が 1 を返して set -e が効く。
  if [ -n "${EDITOR:-}" ]; then
    "$EDITOR" "$JOURNAL"
  fi
}

open_items() {
  ensure
  local n
  n=$(grep -c '^- 昇格: 未\b' "$JOURNAL" || true)
  echo "昇格していないもの: ${n} 件"
  [ "$n" -eq 0 ] && return 0
  echo
  # 見出しと昇格行を対にして出す。
  awk '
    /^## / { title = $0 }
    /^- 昇格: 未/ { print "  " title }
  ' "$JOURNAL"
  echo
  echo "「この決めごとを破ったコードは grep で見つかるか」を考える。"
  echo "見つかるなら scripts/check-sync.sh に入れて 昇格: 機械 にする。"
}

stats() {
  ensure
  echo "== 分類ごと"
  grep -oP '^- 分類: \K.*' "$JOURNAL" | tr '/' '\n' | sed 's/^ *//; s/ *$//' \
    | grep -v '^$' | sort | uniq -c | sort -rn
  echo
  echo "== 昇格の段"
  grep -oP '^- 昇格: \K\S+' "$JOURNAL" | sort | uniq -c | sort -rn
}

case "${1:-open}" in
  new) shift; new_entry "${1:-}" ;;
  open) open_items ;;
  stats) stats ;;
  *) echo "使い方: $0 {new [要約]|open|stats}" >&2; exit 2 ;;
esac
