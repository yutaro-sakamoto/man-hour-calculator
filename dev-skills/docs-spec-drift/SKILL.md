---
name: docs-spec-drift
description: 文書・形式仕様・コードが離れていかないように、ずれを機械で検出する仕組みを作る。grep と awk だけで動く check-sync.sh、Claude Code の Stop フックでの自動実行、機械で見つけられないぶんを読む専用サブエージェント、/sync コマンド。ドキュメントが腐る、TLA+ 仕様と実装がずれる、ABI の版が食い違う、といった問題を防ぐときに読む。docs drift, spec sync, consistency check, hook, ABI version, stale documentation.
---

# 文書・仕様・コードのずれを見張る

書いた決めごとは、見張りが無いと 3 週間で死ぬ。**ずれを人の記憶ではなく
機械に見させる。**

3 層に分ける。下ほど安く、上ほど賢い。

| 層 | 何 | 費用 | いつ |
|---|---|---|---|
| 1 | `scripts/check-sync.sh` | grep と awk だけ。一瞬、無料 | CI 毎回 + 応答の終わりに自動 |
| 2 | 専用サブエージェント (読むだけ) | 小さいモデル | `/sync deep` と言われたときだけ |
| 3 | 人の目 | — | 1 と 2 を通してから |

**層 1 で見つかるものを層 2 に持ち込まない。** 安いところで全部潰す。

## 層 1: `check-sync.sh`

骨は `assets/check-sync.sh`。方針:

- **外部に何も問い合わせない。必ず同じ答えを返す。** 速いので毎回回せる
- 見るのは「**読めば分かる食い違い**」だけ。意味の正しさは見ない
- `--quiet` を付けると食い違いだけ出す (フックから呼ぶため)

### 何を見るか (効いた順)

**1. 同じ番号を複数箇所が名乗っているもの。**
ABI の版が Rust / TypeScript / 文書の 3 か所にある。食い違うと起動時の照合で
黙って弾かれる側が出る。

```sh
abi_rs=$(grep -oP 'pub const VERSION: f64 = \K[0-9]+' crates/core/src/abi.rs | head -1)
abi_ts=$(grep -oP 'export const ABI_VERSION = \K[0-9]+' web/src/abi.ts | head -1)
abi_doc=$(grep -oP '^# .* \(version \K[0-9]+' docs/ABI.md | head -1)
```

**2. 一覧に載せ忘れ。**
Kani のハーネスを足して `docs/VERIFICATION.md` の表に書き忘れると、
表が実態より小さくなる。ソースから名前を集めて、文書に出るかを見る。

```sh
harnesses=$(grep -rn -A 2 '#\[kani::proof\]' --include='*.rs' crates | grep -oP 'fn \K\w+' | sort -u)
```

**3. 仕様が名指しする実装が実在するか。**
TLA+ のコメントが `Service::set_group_member` のように実装を名指ししている。
名前が変わったまま放置すると「同じ番人が両方にある」前提が黙って崩れる。

**4. 検査が空になっていないか。**
TLA+ の `.cfg` に `INVARIANT` が無いと、TLC は**何も検査せずに緑になる**。
これがいちばん怖い失敗。

**5. 文書の相対リンクの先が消えていないか。**

**6. 版と移行の段が揃っているか。**
`STORE_VERSION` を上げたら、スキーマの移行にも段が要る (その逆も)。

**7. 名前で呼ばれるものの名前。**
スキルの frontmatter の `name` がディレクトリ名とずれると、**呼べないまま
何も起きない**。「破れても静かなもの」ほど機械で見る価値がある。

```sh
declared=$(grep -m1 -oP '^name: \K\S+' "$dir/SKILL.md")
[ "$declared" = "$(basename "$dir")" ] || bad "…"
```

**8. 決まった語彙 (enum) の綴り。**
日誌の `昇格:` のように、**その語で数えているもの**は綴りを間違えると
静かに数から漏れる。値の集合を `case` で固定する。

```sh
case "$stage" in
  未 | rules | 機械 | skill | 一過性) ;;
  *) bad "知らない昇格の段があります: $stage" ;;
esac
```

**9. 対になっているものの数。**
「項目 1 件につき `昇格:` の行が 1 本」のような対応は、数を比べるだけで
書き忘れが出る。

**選ぶ基準は「破れたときに静かかどうか」。** 破れば落ちるものは要らない。
ずれても何も起きないまま気づけないものだけを、ここで見る。

### 読み取れないことを「ずれ無し」と読まない

これで 1 回すり抜けた。ファイルを動かしたら grep が空になり、**検査が黙って
消えた** (`store.rs` → `store/mod.rs`)。

```sh
if [ -z "$store_version" ]; then
  bad "STORE_VERSION を読み取れません (場所が変わった?)"
elif [ "$store_version" -gt "$schema_steps" ]; then
  bad "保存データの版に対して、移行の段が足りません"
fi
```

**抽出が空だったら失敗にする。** 検査を足すたびにこの形を守る。

## 層 1.5: 応答の終わりに自動で回す (Claude Code の Stop フック)

```json
{
  "hooks": {
    "Stop": [{ "hooks": [{
      "type": "command",
      "command": "${CLAUDE_PROJECT_DIR}/.claude/hooks/sync-check.sh",
      "timeout": 30,
      "statusMessage": "文書と仕様のずれを見ています"
    }]}]
  }
}
```

フック側の設計が肝 (`assets/sync-check-hook.sh`)。

- **ずれが無ければ何も言わない。** 毎回口を出すと読まれなくなる
- **モデルを一切使わない**ので費用がかからない
- 出すのは `additionalContext` だけで、**止めない**。作業の途中で一時的に
  ずれるのはふつうのこと。止めると邪魔になる
- 変更が何も無いなら、そもそも見ない

## 層 2: 読むだけのサブエージェント

層 1 が機械的に見つけられないぶん — **説明が古い、例が動かない、表が実態と
違う、仕様がモデル化していない操作がある** — を探す。
`assets/drift-reviewer.md` をそのまま `.claude/agents/` に置ける。

設計:

- `tools: Read, Grep, Glob, Bash`。**何も書き換えない**
- `model: haiku`。読んで突き合わせるだけなので小さいモデルで足りる
- 冒頭で層 1 を回させ、**「ここで出たものは報告しなくてよい」**と明示する
- 見るところを**具体的なファイルの組で**指示する
  (`spec/X.tla` ⇔ `service.rs`、`docs/ABI.md` ⇔ `abi.rs` + `wasm.ts`)
- **過去にすり抜けた筋を書いておく。** 「入れ物自身の所有者をモデル化して
  いなかったために穴が通った。仕様が扱っていない対象に注意」のように
- **「何も見つからなければそう言う。無理に絞り出さない。推測で書かない」**
  を明示する。これが無いと毎回それらしい指摘が出て、信用できなくなる

**こちらから勝手に撒かない。** `/sync deep` のように、言われたときだけ。

## 層 2 を呼ぶコマンド

`.claude/commands/sync.md`:

```md
文書・仕様・コードのずれを見つけて直す。

まず機械の分を回す。

    ./scripts/check-sync.sh

出たものを直す。直す向きは**実態に合わせる**のが既定。ただし、
「実装が仕様から外れた」場合は**実装のほうを直す**
(仕様を実装に合わせて書き換えると、仕様が番人でなくなる)。

$ARGUMENTS に `deep` が含まれるときだけ、drift-reviewer を 1 つ起動する。
含まれないときは機械の分だけで止める。**こちらから勝手に撒かない。**
```

**「直す向き」を書いておくのが効く。** 書かないと、仕様のほうを実装に
合わせて書き換えられて、仕様が番人でなくなる。

## 同じ PR の中で直す

`AGENTS.md` に「この 3 つはコードを変えたら**同じ PR のなかで**直す」と書く。

- 検証の対応表 (`docs/VERIFICATION.md`)
- 形式仕様 (`spec/*.tla`)
- インタフェースの取り決め (`docs/ABI.md`)

## 関連

- Claude 設定全体 → [agent-ready-repo](../agent-ready-repo/)
- 何を表に載せるか → [verification-ladder](../verification-ladder/)
