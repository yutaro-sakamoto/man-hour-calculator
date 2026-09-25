# このリポジトリで回すものを、ここから一通り呼べるようにしてある。
#
#   make help      使い方の一覧 (各ターゲットの `##` の説明から組み立てる)
#   make check     変更のたびに回す速い一式
#   make ci        CI と同じものを手元で一通り
#
# 中身はどれも既存の道具 (cargo / npm / scripts/*.sh / spec/check.sh) を呼ぶだけで、
# 手順そのものはそれぞれの側に置いてある。ここは入口をそろえるための薄い層。
# ターゲットを足したら `##` で説明を書く (`make help` に出ない
# ターゲットは、無いのと同じ)。`scripts/check-sync.sh` が、文書が名指しする
# `make …` がここにあるかを見ている。

# コマンドの途中で落ちたら、そこで止める。
SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help
MAKEFLAGS += --no-print-directory

# ---- 変えられるもの (`make fuzz-deep FUZZ_ITERS=50000` のように渡す) -----
# 説明は行末の `##`。make は `#` の前の空白まで値に含めるので、使う側では
# 必ず $(strip …) を通す (通さないと "20000   " が数として読めず、Rust の
# ファジングが黙って既定の回数に戻った)。
FUZZ_ITERS   ?= 20000                 ## ファジングの回数 (fuzz-deep)
MONKEY_STEPS ?= 1000                  ## モンキーテストの手数 (monkey-deep)
BROWSERS     ?= chromium              ## E2E を回すブラウザ (例: chromium,firefox,webkit)
E2E_ARGS     ?=                       ## Playwright に渡す引数 (例: tests/a11y.spec.js)
DB           ?= sqlite:mhc.db         ## サーバの保存先 (serve)
LISTEN       ?= 127.0.0.1:8080        ## サーバの待ち受け (serve)

comma := ,
fuzz_iters   := $(strip $(FUZZ_ITERS))
monkey_steps := $(strip $(MONKEY_STEPS))
browsers     := $(strip $(BROWSERS))
e2e_args     := $(strip $(E2E_ARGS))
db           := $(strip $(DB))
listen       := $(strip $(LISTEN))

WEB_DEPS := web/node_modules/.package-lock.json
E2E_DEPS := e2e/node_modules/.package-lock.json

##@ 使い方

.PHONY: help
help: ## この一覧を出す
	@if [ -t 1 ]; then b=$$'\033[1m' c=$$'\033[36m' y=$$'\033[33m' r=$$'\033[0m'; \
	 else b= c= y= r=; fi; \
	awk -v b="$$b" -v c="$$c" -v r="$$r" 'BEGIN { FS = ":.*## " } \
	  /^##@/ { printf "\n%s%s%s\n", b, substr($$0, 5), r; next } \
	  /^[a-zA-Z0-9_-]+:.*## / { printf "  %s%-16s%s %s\n", c, $$1, r, $$2 }' \
	  $(MAKEFILE_LIST); \
	printf "\n%s変えられるもの%s (例: make fuzz-deep FUZZ_ITERS=50000)\n" "$$b" "$$r"; \
	awk -v y="$$y" -v r="$$r" '/^[A-Z_0-9]+ +\?=.*## / { \
	  name = $$1; value = $$0; sub(/^[^=]*= */, "", value); sub(/ *##.*/, "", value); \
	  text = $$0; sub(/.*## /, "", text); \
	  printf "  %s%-13s%s %-22s %s\n", y, name, r, "(" value ")", text }' \
	  $(MAKEFILE_LIST)

##@ 準備

$(WEB_DEPS): web/package-lock.json
	npm --prefix web ci
$(E2E_DEPS): e2e/package-lock.json
	npm --prefix e2e ci

.PHONY: setup
setup: $(WEB_DEPS) $(E2E_DEPS) ## 依存を入れる (web と e2e の npm ci)

.PHONY: setup-browsers
setup-browsers: $(E2E_DEPS) ## E2E のブラウザを入れる (BROWSERS で選ぶ。取りに行くので重い)
	cd e2e && npx playwright install $(subst $(comma), ,$(browsers))

##@ ビルド

.PHONY: build
build: $(WEB_DEPS) ## 配布物を組み立てる → dist/app.html, dist/index.html
	cargo xtask build

.PHONY: build-debug
build-debug: $(WEB_DEPS) ## 最適化を省いて速く組み立てる (手元の確認用)
	cargo xtask build --debug

.PHONY: dist
dist: $(WEB_DEPS) ## 配る形で組み立てる (wasm-opt 必須・サイズ上限を見る。CI と同じ)
	cargo xtask build --require-wasm-opt

.PHONY: server
server: build ## サーバを 1 つのバイナリに組み立てる (画面を埋め込む)
	cargo build --profile server -p mhc-server

.PHONY: serve
serve: server ## サーバを起動する (DB と LISTEN で変えられる)
	./target/server/mhc-server --db $(db) --listen $(listen)

##@ 変更のたびに回すもの

.PHONY: check
check: fmt-check lint test sync ## 速い一式: 整形・lint・単体テスト・ずれの検査

.PHONY: fmt
fmt: $(WEB_DEPS) ## 整形する (Rust と TypeScript)
	cargo fmt --all
	npm --prefix web run --silent format

.PHONY: fmt-check
fmt-check: $(WEB_DEPS) ## 整形されているかを見る (書き換えない)
	cargo fmt --all --check
	npm --prefix web run --silent format:check

.PHONY: lint
lint: $(WEB_DEPS) ## lint と型検査 (clippy / ESLint / tsc)
	cargo clippy --workspace --all-targets -- -D warnings
	npm --prefix web run --silent lint
	npm --prefix web run --silent typecheck

.PHONY: test
test: test-rust test-web ## 単体テスト (Rust と TypeScript。ファジングも既定の回数で入る)

.PHONY: test-rust
test-rust: ## Rust のテスト (cargo test --workspace)
	cargo test --workspace

.PHONY: test-web
test-web: $(WEB_DEPS) ## TypeScript の単体テスト
	npm --prefix web test

.PHONY: e2e
e2e: build $(E2E_DEPS) ## 組み立て直してから E2E (file://)。E2E_ARGS で絞れる
	cd e2e && MHC_BROWSERS=$(browsers) npx playwright test $(e2e_args)

.PHONY: sync
sync: ## 文書・仕様・コード・設定のずれを見る
	./scripts/check-sync.sh

##@ 品質の数字

.PHONY: coverage
coverage: $(WEB_DEPS) ## カバレッジを C0 / C1 で測って基準で判定する
	./scripts/coverage.sh

.PHONY: complexity
complexity: $(WEB_DEPS) ## 関数ごとの複雑度を上から並べる
	./scripts/complexity.sh

.PHONY: audit
audit: $(WEB_DEPS) ## npm の依存の既知の脆弱性を見る (CI と同じ基準)
	cd web && npm audit --audit-level=moderate

##@ 深く回すもの (時間がかかる)

.PHONY: fuzz-deep
# 名前で絞らない (`cargo test fuzz` は名前に fuzz を含むテストしか拾わず、
# ABI の fuzz_abi.rs や WASM の入口の検査が漏れる)。回数を上げて全部回す。
fuzz-deep: $(WEB_DEPS) ## ファジングを FUZZ_ITERS 回まで上げて回す (Rust は release で全部)
	MHC_FUZZ_ITERS=$(fuzz_iters) cargo test --release --workspace
	MHC_FUZZ_ITERS=$(fuzz_iters) npm --prefix web test

.PHONY: monkey-deep
monkey-deep: build $(E2E_DEPS) ## モンキーテストを MONKEY_STEPS 手まで上げて回す
	cd e2e && MHC_MONKEY_STEPS=$(monkey_steps) npx playwright test tests/monkey.spec.js

.PHONY: mutants
mutants: ## ミューテーションテスト (テストに歯があるか。数十分)
	cargo mutants -p mhc-core -p mhc-api --timeout 60

.PHONY: golden-update
golden-update: ## ゴールデンを書き直す (わざと結果を変えたときだけ。差分は必ず目で見る)
	MHC_UPDATE_GOLDEN=1 cargo test -p mhc-core --test golden_compute
	MHC_UPDATE_GOLDEN=1 cargo test -p mhc-api --test store_formats
	@git --no-pager diff --stat -- crates/*/tests/fixtures

##@ 形式手法 (その層を触ったときだけ)

.PHONY: formal
formal: kani miri tla ## 3 つとも回す

.PHONY: kani
kani: ## 有界モデル検査 (cargo kani。約 45 秒)
	cargo kani --workspace

.PHONY: miri
miri: ## FFI 層の未定義動作を見る (nightly の miri。約 2 分)
	MIRIFLAGS=-Zmiri-strict-provenance cargo +nightly miri test -p mhc-wasm

.PHONY: tla
tla: ## 権限の設計を TLC で検査する
	./spec/check.sh

##@ まとめて

.PHONY: ci
ci: check coverage audit e2e formal ## CI と同じものを一通り (Dev Container と Pages を除く)

##@ 片付け

.PHONY: clean
clean: ## 組み立てたものを消す (target/ dist/ web/dist/ と E2E の結果)
	cargo clean
	rm -rf dist web/dist e2e/test-results e2e/playwright-report
