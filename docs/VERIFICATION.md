# 検証のしかた

このアプリが「守る」と言っていることを並べ、**それぞれを何で確かめているか**を
対応させた表。テストが増えても、ここを見れば「どの約束が、どの強さで守られて
いるか」が分かる。

強さには段がある。下に行くほど強い。

| 段 | 手段 | 分かること |
|---|---|---|
| 1 | 単体テスト | **試した入力について**正しい |
| 2 | 性質テスト (乱択) / **ファジング** / モンキーテスト | 撃った標本の範囲で、性質が崩れていない |
| 3 | 差分テスト (相互オラクル) | 独立した 2 実装が食い違っていない |
| 4 | 型による構成 | その値が存在する時点で成り立つ |
| 5 | **有界モデル検査 (Kani)** | 区間の**すべての入力**について成り立つ |
| 6 | **モデル検査 (TLC / TLA+)** | 設計として、**到達しうるすべての状態**で成り立つ |
| — | miri | FFI 層に未定義動作が無い |
| — | ミューテーションテスト | 上の検査に**歯が立っている** |

---

## 計算コア (`crates/core`)

| 約束 | 手段 | どこ |
|---|---|---|
| `TaskEstimate` があれば `0 ≤ min ≤ likely ≤ max` かつ有限 | 型 + **Kani** | `estimate.rs` `a_constructed_estimate_always_satisfies_its_invariant` |
| 妥当な 3 点は必ず受け付ける (全部断る実装で通らない) | **Kani** | `estimate.rs` `any_valid_triple_is_accepted` |
| `NaN` はどの位置でも弾かれる | **Kani** | `estimate.rs` `nan_never_gets_through` |
| 日数 ↔ 年月日 が往復する | **Kani** (±200 年) | `date.rs` `civil_round_trip_is_identity` |
| 隣の日は必ず 1 日進む (月末・年末・うるう日) | **Kani** | `date.rs` `the_next_day_is_always_one_day_later` |
| 曜日は必ず `0..=6`、7 日周期 | **Kani** (`i64` 全域) | `date.rs` `the_weekday_is_always_in_range` |
| 応答バッファの宣言長 = 区画の合計 | **Kani** (受け付ける寸法すべて) | `abi.rs` `the_declared_length_always_matches_the_sections` |
| `handle` は決して panic せず、不正は status で返る | 単体 + miri + **ファジング** | `abi.rs:543`, `wasm/src/lib.rs`, `core/tests/fuzz_abi.rs` |
| 成功の応答は宣言長と一致し、確率は `[0,1]`、累積分布は単調 | **ファジング** (壊したリクエスト) | `core/tests/fuzz_abi.rs` |
| CDF は単調非減少で `[0,1]` に収まる | 性質テスト | `dist.rs` `cdf_is_monotone_and_bounded` |
| 分位関数は単調で、値域に収まる | 性質テスト | `dist.rs` `quantile_is_monotone_in_u` ほか |
| `F(F⁻¹(u)) = u` | 性質テスト | `dist.rs` `cdf_and_quantile_are_mutually_inverse` |
| 逆 CDF テーブルの単調性 | **構成による** | `dist.rs:11,117` |
| 2 つのエンジンが同じ答えを出す | 差分テスト | `convolve.rs`, `stats.rs`, `abi.rs` |
| 累積稼働量は単調非減少 | 性質テスト | `calendar.rs` `cumulative_capacity_is_monotone` |
| 春分・秋分が官報の日付と一致 | 外部仕様への固定 | `date.rs` `equinox_matches_published_dates` |

## 権限 (`crates/api`)

| 約束 | 手段 | どこ |
|---|---|---|
| 役割は全順序 (反射・反対称・推移・全比較) | **Kani** | `permission.rs` `roles_are_totally_ordered` |
| 役割を上げて、できることが減らない | **Kani** (役割 × 操作の全組) | `permission.rs` `a_stronger_role_can_never_do_less` |
| 共有されていない一般ユーザは何もできない | **Kani** | `permission.rs` `an_unshared_member_can_do_nothing_to_the_project` |
| 管理は所有者以上、書き換えは編集者以上 | **Kani** | `permission.rs` `managing_always_requires_owner` |
| **プロジェクトは実在の所有者を必ず 1 人以上持つ** | **TLC / TLA+** + 単体 + **状態つきファジング** | `spec/Permissions.tla`, `service.rs`, `service/fuzz.rs` |
| **入れ物 (プロジェクトグループ) も実在の所有者を必ず 1 人以上持つ** | **TLC / TLA+** + 単体 + **状態つきファジング** | `NoFolderLosesItsLastOwner`, `service.rs`, `service/fuzz.rs` |
| 失敗した操作・読むだけの操作は、保存先を変えない | **状態つきファジング** | `service/fuzz.rs` |
| どの操作・どんな JSON でも panic しない | **ファジング** | `service/fuzz.rs` |

### ファジングが見つけた筋

`service/fuzz.rs` は、でたらめな操作の列を `dispatch` に流し、毎歩ごとに
上の約束を確かめる。**番人を 1 つずつ外すと落ちる**ことを確かめてある
(`set_group_access` の配下プロジェクトの輪だけは、入れ物の番人と同値なので
外しても落ちない)。入れたその日に 2 つ見つかった:

1. 人・グループ・構成員を消す操作 (`delete_user` / `delete_user_group` /
   `set_group_member`) が**入れ物の所有者**を見ておらず、所有者の居ない
   入れ物を作れた。仕様にも入れ物の所有者が無かったので、TLC も突けなかった
2. `MemoryStore::from_json` が、オブジェクトでない JSON (`1` など) で panic した。
   WASM は `panic = "abort"` なので、アプリごと止まる

### TLC が見つけた 3 つの筋

どれも「操作の順序」で破れるもので、単体テストでは思いつかれていなかった。
反例はそのまま回帰テストに写してある (`service.rs` の「不変条件: 所有者」)。

1. グループに所有権を預けたまま、**最後のメンバーが抜ける**
   (`set_group_member`)
2. 入れ物から継いだ所有権だけを頼りに、**その入れ物から出る**
   (`update_project` の `group_id`)
3. 入れ物の所有者を、**構成員の居ないグループに付け替える**
   (`set_group_access` — 「付与が 1 つ残っている」ことしか見ていなかった)

## 保存先 (`Store` の実装すべて)

保存先は 3 つになる (メモリ・SQL・DynamoDB) が、**どれも同じ約束を守る**。
実装ごとにテストを書くと食い違いに気づけないので、検査は
`crates/api/src/store/conformance.rs` に 1 組だけ置き、
**同じものをすべての実装に当てる**。新しい保存先を足すときは、
書く前にこれを通すこと。

| 約束 | 手段 | どこ |
|---|---|---|
| `put_*` は upsert。同じ id で二重に増えない | 適合テスト | `put_is_upsert` |
| `remove_*` は「本当に消したか」を返す | 適合テスト | `remove_reports_whether_it_existed` |
| 無い id は `None` / 空。エラーにしない | 適合テスト | `missing_ids_are_none` |
| アカウントを消すと、その宛先の権限と所属も消える | 適合テスト | `removing_a_user_takes_its_grants_with_it` |
| グループを消すと、そのグループ宛ての権限も消える | 適合テスト | `removing_a_user_group_takes_its_grants_with_it` |
| **プロジェクト群を消しても、配下のプロジェクトは消さない** | 適合テスト | `removing_a_project_group_keeps_its_projects` |
| プロジェクトを消すと、コメントと添付も消える | 適合テスト | `removing_a_project_takes_its_comments_with_it` |
| 一覧は中身 (`Document`) を読まない | 型 + 適合テスト | `project_metas_has_no_document` |
| コメントは `(created_at, id)` の順。**並べるのは Store** | 適合テスト | `comments_come_back_oldest_first` |
| 添付は `put_comment` で全置換。並びは入れた順 | 適合テスト | `put_comment_replaces_the_whole_attachment_list` |
| **件数は数え直さない。** 渡された値をそのまま持つ | 適合テスト | `counts_are_stored_as_given` |
| 権限は `(種別, id)` の順で返る | 適合テスト | `access_order_is_normalized` |
| グループのメンバーは id の順で返る | 適合テスト | `group_members_are_normalized` |

当てている実装:

| 実装 | どこ |
|---|---|
| `MemoryStore` (ローカル版・WASM のなか) | `store/mod.rs` `the_memory_store_keeps_the_contract` |
| `SqlStore` (SQLite / PostgreSQL) | `server/tests/store_conformance.rs` |

最後の 2 つは、この表を作るまで**実装ごとに違っていた**。`MemoryStore`
だけが `put_project` で件数を数え直し、権限の並びは `SqlStore` だけが
正規化していた。同じ操作でローカル版とサーバ版の応答が違う状態だった。

## FFI (`crates/wasm`)

| 約束 | 手段 | どこ |
|---|---|---|
| 生ポインタの読み替えに未定義動作が無い | **miri** (`-Zmiri-strict-provenance`) | `cargo +nightly miri test -p mhc-wasm` |
| でたらめな入力で落ちず、エラーで返る | 単体 | `lib.rs` `a_garbage_request_comes_back_as_an_error_not_a_crash` |
| UTF-8 として壊れたバイト列でも、応答は必ず JSON | **ファジング** (miri の下でも回る) | `lib.rs` `random_bytes_at_the_bridge_come_back_as_json` |
| 確保の上限を超えたら `null` を返す | 単体 | `lib.rs` `oversized_and_zero_allocations_return_null` |

## 配布物

| 約束 | 手段 | どこ |
|---|---|---|
| 1 枚の HTML で、外部通信が 0 件 | E2E (`file://`) + **モンキーテスト** | `e2e/tests/app.spec.js`, `monkey.spec.js` |
| でたらめに操作し続けても、例外も外部通信も起きない | **モンキーテスト** (種で再現) | `e2e/tests/monkey.spec.js` |
| HTML の文字列を組み立てない | **lint** (`innerHTML` ほかを禁止) | `web/eslint.config.js` |
| 自由記入欄に書いた HTML は、どの画面でも文字のまま | E2E (全欄に書いて全画面を回る) | `e2e/tests/xss.spec.js` |
| コメントの本文から危ないリンクを作らない / 長い本文で固まらない | **ファジング** | `web/src/fuzz.test.ts` |
| 読み込んだファイルは深さ優先の並びに整い、輪は切れる | 単体 + **ファジング** | `web/src/model/project.test.ts`, `fuzz.test.ts` |
| CSV は書き出して読み戻すと同じ形に戻る | **ファジング** | `web/src/fuzz.test.ts` |

---

## 回し方

```sh
cargo test --workspace                     # 1〜3 段 (Store の適合テスト、ファジングも含む)
npm --prefix web test                      # 画面側の単体とファジング
cd e2e && npx playwright test              # E2E・モンキーテスト・XSS
cargo kani --workspace                     # 5 段 (11 ハーネス、約 45 秒)
cargo +nightly miri test -p mhc-wasm       # FFI (約 2 分)
./spec/check.sh                            # 6 段 (TLC)
cargo mutants -p mhc-core -p mhc-api       # 上の検査に歯があるか
./scripts/check-sync.sh                    # この表と実態がずれていないか
```

最後の 1 つは**この文書そのものを見張る**もの。ハーネスを足して表に
書き忘れる、ABI の版が 3 か所で食い違う、リンクの先が消える、といった
「読めば分かる食い違い」を機械で潰す。モデルを使わないので一瞬で終わる。

ファジングとモンキーテストは既定では軽く回す (`cargo test` と `npm test` を
重くしないため)。深く回すときは回数を上げる。種は固定なので、回数を上げても
既定の標本はそのまま含まれる。

```sh
MHC_FUZZ_ITERS=20000 cargo test --release fuzz      # Rust のファジング
MHC_FUZZ_ITERS=20000 npm --prefix web test          # 画面側のファジング
MHC_MONKEY_STEPS=1000 npx playwright test monkey    # モンキーテスト (e2e/ で)
```

CI では `miri` `kani` `TLA+` と、上のずれの検査が pull request ごとに、
ミューテーションテストが毎日 03:00 (JST) に回る。Claude Code で作業して
いるときは、応答の終わりにもずれの検査が回る (`.claude/settings.json`)。

## まだ届いていないところ

- **浮動小数の計算そのもの** は Kani の対象外にしてある。比較と構成
  (`TaskEstimate`) までは証明しているが、PERT の逆関数やモンテカルロの
  収束は、SMT で解くより性質テストと差分テストのほうが実際的。
- **TLA+ の対象は権限の設計だけ。** 計算の進み方やカレンダーは
  モデル化していない。
- `crates/server` の SQL 層は、実際の PostgreSQL と SQLite に対する
  CI ジョブで見ている (形式的な検証はしていない)。適合テストは SQLite に
  対してだけ回している。PostgreSQL は CI の専用ジョブで `tests/api.rs` を
  通しており、そこまで二重に回してはいない。
- **同時に書いたときの振る舞いは `Store` の約束に入っていない。**
  直列化は呼び出し側の仕事 (サーバは書き込みロック)。
