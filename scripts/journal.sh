#!/usr/bin/env bash
# 開発日誌。踏んだ穴・読み違い・設計判断を貯めて、昇格させるための道具。
#
#   ./scripts/journal.sh new [要約]        雛形を追記して開く
#   ./scripts/journal.sh open              昇格: 未 の一覧
#   ./scripts/journal.sh stats             分類ごとの件数
#   ./scripts/journal.sh promote <種> <名>  昇格先の雛形を作る
#
# 書くだけでは効かない。**段 3 (機械の検査) に上げて初めて守られる。**
# 段 2 (rules / command / agent) と段 4 (skill) は `promote` が雛形を出す。
# 「書きたいが、どこにどう書くのか思い出せない」で止まらないようにするため。
set -euo pipefail

cd "$(dirname "$0")/.."
JOURNAL="docs/JOURNAL.md"
# 段 4 の行き先。次のプロジェクトへ持っていくものの置き場。
SKILLS_DIR="${SKILLS_DIR:-dev-skills}"

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
  n=$(grep -c '^- 昇格: 未' "$JOURNAL" || true)
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

# ---------------------------------------------------------------- 昇格の雛形
# 段 2 と段 4 の行き先は、それぞれ frontmatter の形が違う。毎回思い出すのは
# 無理なので、雛形を出す。**既にあるものは上書きしない。**
promote() {
  local kind="${1:-}" name="${2:-}"
  if [ -z "$kind" ] || [ -z "$name" ]; then
    echo "使い方: $0 promote {rules|command|agent|skill} <名前>" >&2
    return 2
  fi
  # 名前は英小文字・数字・ハイフンだけ。frontmatter の name と
  # ファイル名を揃える検査 (scripts/check-sync.sh) に合わせる。
  case "$name" in
    *[!a-z0-9-]*) echo "名前は英小文字・数字・ハイフンだけにしてください: $name" >&2; return 2 ;;
  esac

  local path
  case "$kind" in
    rules) path=".claude/rules/$name.md" ;;
    command) path=".claude/commands/$name.md" ;;
    agent) path=".claude/agents/$name.md" ;;
    skill) path="$SKILLS_DIR/$name/SKILL.md" ;;
    *) echo "知らない昇格先: $kind (rules / command / agent / skill)" >&2; return 2 ;;
  esac
  if [ -e "$path" ]; then
    echo "$path は既にあります。そちらに足してください。" >&2
    return 1
  fi
  mkdir -p "$(dirname "$path")"

  case "$kind" in
    rules)
      cat > "$path" <<RULES
---
paths:
  - "<<<効かせたいパス>>>/**"
---

# <<<見出し。「〜するとき」>>>

<<<何を守るのか。1〜2 行>>>

## <<<決めごと>>>

**<<<禁止や作法>>>。** <<<なぜそうなっているか。素直に書くと壊れる理由。>>>
理由の無い禁止は、次のセッションで「より良い方法」に置き換えられる。

## 過去に見つかった穴

<<<実際に踏んだものを、踏んだ事実ごと書く。この節がいちばん効く。>>>
RULES
      ;;
    command)
      cat > "$path" <<COMMAND
<<<この手順が何をするのか。1 行>>>

\`\`\`sh
<<<回すコマンド。コピーできる形で並べる>>>
\`\`\`

\$ARGUMENTS に \`<<<重い層の名前>>>\` が含まれるときは、<<<そこも回す>>>。

落ちたものがあれば、**何が落ちたかを出力ごと**報告する。
「たぶんこれが原因」で済ませず、実際に確かめてから直す。
COMMAND
      ;;
    agent)
      cat > "$path" <<AGENT
---
name: $name
description: <<<いつ呼ぶか。何を見て、何を見ないか>>>
tools: Read, Grep, Glob, Bash
model: haiku
---

あなたは<<<何の番人か>>>です。<<<何を探すか>>>だけを探します。

読むだけです。ファイルを書き換えないでください。

## 先に機械の分を済ませる

\`\`\`sh
./scripts/check-sync.sh
\`\`\`

**ここで出たものは報告しなくてよい** (呼び出した側にも見えています)。
あなたが探すのは、その**外側**です。

## 見るところ

1. <<<ファイルの組を具体的に>>>

## 報告のしかた

見つかったものだけを、**重い順**に並べる。1 件につき、どこ (\`ファイル:行\`)、
何と書いてあるか、実際はどうか、どちらを直すべきか。

**何も見つからなければ、そう言う。** 無理に絞り出さない。推測で書かない。
AGENT
      ;;
    skill)
      cat > "$path" <<SKILL
---
name: $name
description: <<<いつ呼ぶか。日本語の語と、探しやすい英語の語を両方入れる>>>
---

# <<<見出し>>>

<<<何のための型か。1〜2 行>>>

## <<<節>>>

<<<固有の名前を持ち込まない。差し替える箇所は <<< >>> で囲む。>>>
<<<シェルの雛形だけは @@NAME@@ (<<< は bash の here-string になるため)。>>>
SKILL
      ;;
  esac

  echo "$path を作りました。"
  echo
  echo "次に:"
  echo "  1. 中身を埋める (<<< >>> を差し替える)"
  echo "  2. 日誌の 昇格: を $kind に書き換える"
  case "$kind" in
    rules) echo "     (段 2。**段 3 に上げられないか**をもう一度考える)" ;;
    skill) echo "     (段 4。このリポジトリ固有の名前を持ち込まない)" ;;
  esac
  echo "  3. ./scripts/check-sync.sh を回す"
}

case "${1:-open}" in
  new) shift; new_entry "${1:-}" ;;
  open) open_items ;;
  stats) stats ;;
  promote) shift; promote "${1:-}" "${2:-}" ;;
  *) echo "使い方: $0 {new [要約]|open|stats|promote <種> <名前>}" >&2; exit 2 ;;
esac
