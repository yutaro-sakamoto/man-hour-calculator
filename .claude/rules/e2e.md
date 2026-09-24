---
paths:
  - "e2e/**"
---

# E2E は配布物そのものを試す

`dist/app.html` を **`file://` で開く**。http サーバを立てない。
「HTML 1 枚をダブルクリックすれば動く」という配布の形そのものが要件なので、
サーバ経由にすると要件を検査できなくなる。**速くするために変えない。**

`open()` (`tests/support.js`) が、外部へのリクエストとページ内の例外を
数えている。ここが 0 でなくなったら落ちる。新しい spec も必ずこれで開く。

## どの spec が何を見ているか

| spec | 見ているもの |
|---|---|
| `app.spec.js` | 機能ひとつずつの筋書き |
| `monkey.spec.js` | 筋書きの無い乱択の操作 |
| `xss.spec.js` / `security.spec.js` | 攻める側 (XSS・CSP・タブナビング・原型の汚染・CSV) |
| `a11y.spec.js` | axe と窓のフォーカス |
| `l10n.spec.js` | 英語の画面の日本語の残り |
| `chaos.spec.js` | localStorage が壊れているとき |
| `performance.spec.js` | 上限いっぱいの大きさと、繰り返し (ソーク) |
| `compat.spec.js` | 狭い画面とタッチ |

- **`page.evaluate` の中は CSP の外。** そこで `eval` しても止まらないので、
  CSP が効いているかはそこで試さない (`<script>` を差し込んで試す)
- axe は `<script>` で差し込むと CSP が止める。`page.evaluate` で読み込む
- ブラウザの違いは `MHC_BROWSERS=chromium,firefox,webkit` で足せる (CI は Chromium だけ)
- **落ちたら、まず入力を作った側を疑う。** 性能の検査が作った `min > likely` の
  タスクを、アプリの不具合と読み違えかけた。直す前に、その入力が本当に
  ありうるものかを確かめる

## モンキーテスト

`tests/monkey.spec.js` は筋書きを持たず、見えている押せるもの・書けるものを
種で決まる乱数で触り続ける。落ちたら、そこまでの操作が全部エラーに載る。

- 窓 (`.modal-card`) が開いていたら、その中だけを候補にする。外まで候補に
  すると半分近くが「覆われていて押せない」で時間切れになる
- 外へのリンクと別ページへのリンクは候補から外す (利用者が選んだ遷移は、
  「勝手に通信しない」の違反ではない)
- 候補の画面を足したら、`MHC_MONKEY_STEPS=1000` で一度深く回す

## 書くとき

- 位置ではなく**名前**で引く (`title`、`data-*`)。列が 1 つ増えるたびに
  壊れる書き方にしない
- 値を確かめるときは、表示の文字列ではなく `data-*` の素の値を見る
- `recompute()` で計算が一巡するのを待つ。`waitForTimeout` で誤魔化さない
- 確認ダイアログが出る操作は `page.once("dialog", …)` を先に置く

## 回す前に

```sh
cargo xtask build       # dist/app.html を作り直す
cd e2e && npx playwright test
```

**`dist/` を作り直さずに回さない。** 直したはずのものが直っていないように
見えて、時間を溶かす。
