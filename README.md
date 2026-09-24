# Effort Estimator

*English · [日本語](README_JP.md)*

> [!WARNING]
> **This project is still under development.**
> The design still moves around, and files saved today may stop loading in a later
> version. It is not something to rely on for real work yet.

A tool that turns **three-point estimates** (minimum / most likely / maximum) and a
**per-person working calendar** into a **probability distribution of total effort** and a
**finish date for each task**.

Adding up the most-likely value of every task almost always underestimates. Delays
accumulate; things finishing early rarely do. This tool treats each task as a probability
distribution, computes the distribution of their sum, and answers "how many person-days at
P80", "when will it be done", and "what is the chance it is finished by this date".

The deliverable is **a single HTML file**. Download it, double-click it, and it works. No
server, no install, no network.

```
Task                      Min  Likely   Max
Design phase
  Requirements              5      8     20
  Architecture              3      5     12
Build phase
  API implementation        2      3      5
  UI implementation        10     15     40
  Batch jobs                2      4      9
Test and release            3      6     14
                              ─────────────
Sum of most-likely                41 person-days
Total effort, P80               53.5 person-days   ← this is what you can promise
Finish date, P80              2026-12-11           ← holidays and meetings included
```

(The sample data is in English. Switching the display language does not change it.)

## What it does

- Treats **three-point estimates** as PERT (beta) or triangular distributions and computes
  the distribution of their sum
- Organises tasks by **parent/child (WBS), priority and group**, with filtering
- **People**: per-weekday working hours and breaks for each person, assigned to tasks
- **Working calendar**: Japanese public holidays, working on a day off, meetings and time
  off (5-minute steps, biweekly and other repeats, shared by several people)
- **Finish-date probabilities**: read "when will it be done" per task and overall, as a
  band chart and as a table
- **Actuals fold back in**: start dates, progress and completion dates redraw the forecast
- **Comments**: Markdown on projects and tasks, with file attachments (1 MB each, 5 per
  comment) — people with view-only access can write them
- **Several projects**: create as many as you like, switch between them, duplicate them
- **Accounts and permissions**: owner / editor / viewer per project
- **Saving and handing over**: one project (`.mhc.json`) or all of them at once
  (`.mhcall.json`), CSV import and export, automatic saving into the browser
- Japanese / English, and dark mode following the OS setting

## Getting it

Every `v*.*.*` tag builds a [Release](https://github.com/yutaro-sakamoto/man-hour-calculator/releases)
carrying:

- **the single HTML file** — download, double-click, done
- **the server as a standalone binary** — Linux and Windows, x86_64 and arm64 (Linux also
  ships a statically linked musl build)
- **an SBOM** (CycloneDX) for both the Rust and the npm side, a `cargo audit` report, a
  dependency and licence inventory, and `SHA256SUMS`
- **signed build provenance** (SLSA). Verify with
  `gh attestation verify <file> --repo yutaro-sakamoto/man-hour-calculator`

The server binaries are built with `cargo auditable`, so the dependency list travels
*inside* the binary: `cargo audit bin mhc-server` reads it back on your machine.

## Using it

There is an introduction page at
**<https://yutaro-sakamoto.github.io/man-hour-calculator/>**; "Try it now" opens the tool.

What opens is the **local version**. Everything runs in your browser and stays there. What
you enter is kept in that browser, so it is gone if you clear site data or move to another
device — use the file export to keep a copy.

The tool itself is one self-contained HTML file, so saving it means it keeps working
offline. To share work across people, run the server (below).

To build it yourself, see the next section.

## Building

```sh
cargo xtask build          # → dist/app.html (the tool) and dist/index.html (the intro page)
```

You need:

- Rust 1.92 or newer (`rust-toolchain.toml` takes care of `wasm32-unknown-unknown` too)
- Node.js 22 or newer (used to build the frontend; `xtask` runs `npm ci` the first time)
- Optional: `wasm-opt` from [binaryen](https://github.com/WebAssembly/binaryen)

  It makes the WASM about 30% smaller. The build works without it. We pass `-all` to
  `wasm-opt`, because binaryen's default feature set rejects instructions that rustc emits
  by default for wasm32, such as sign-ext (which features are allowed changes between
  versions, so allowing everything breaks less often than listing flags). CI passes
  `--require-wasm-opt` so that an unoptimised build never ships quietly.

There are **no Rust dependencies**. The Node dependencies are build-time only (TypeScript,
esbuild, ESLint, Prettier) and none of them end up in what is shipped.

### Or use the dev container

`.devcontainer/` has all of the above already in it — the toolchain, Node 22, the right
binaryen, a C compiler for the bundled SQLite, and Playwright's Chromium. Open the repo in
a dev container and `cargo xtask build && cargo test --workspace` works with nothing else
to install. CI builds the same container and runs a smoke test inside it, so what is
written here and what actually works do not drift apart.

## Checking

```sh
cargo test --workspace                                  # Rust: unit, property, two-engine cross-check
cargo clippy --workspace --all-targets -- -D warnings
npm --prefix web run check                              # format / lint / types / unit tests
cd e2e && npm ci && npx playwright test                 # end-to-end over file://
```

The end-to-end tests open `dist/app.html` **over `file://`**. That checks the premise
itself — one HTML file, working offline — on every run: if a single external request goes
out, the test fails.

### Keeping the docs and the spec honest

```sh
./scripts/check-sync.sh
```

Checks the mechanical things: that the ABI version agrees in all three places,
that every Kani harness appears in the verification table, that the functions
the TLA+ spec names still exist, that no document links to a file that is gone.
CI runs it on every pull request.

Conventions for working on this repository with a coding agent are in
[AGENTS.md](AGENTS.md). Pitfalls, misreadings and design decisions are collected
in [docs/JOURNAL.md](docs/JOURNAL.md) and promoted — a note becomes a rule,
a rule becomes a machine check. The ones worth carrying to the next project
live in [dev-skills/](dev-skills/) as Claude Code skills.

### How much of it is actually tested

```sh
./scripts/coverage.sh        # statement (C0) and branch (C1) coverage, Rust and TypeScript
```

| | C0 (lines) | C1 (branches) | other |
|---|---|---|---|
| Rust (`cargo llvm-cov --branch`) | 90% | 75% | |
| TypeScript (Node built-in) | 90% | 85% | functions 77% |

CI fails if any of these drops below its threshold. The thresholds live in
`scripts/coverage.sh` and `web/package.json`. Rust branch coverage is a nightly feature,
so the script installs and uses a pinned nightly.

Node's built-in coverage only counts files that the tests actually load, so `ui/` and
`charts/` (which need a DOM) are out of scope — what is left is the pure modules, which is
a range worth putting a number on.

### Are functions getting too tangled

```sh
./scripts/complexity.sh      # per-function complexity, highest first
```

The limits are enforced by the ordinary lint: `cargo clippy` / `npm run check` fail above them.

| | metric | limit | where |
|---|---|---|---|
| Rust | cognitive complexity | 16 | `clippy.toml` |
| TypeScript | cyclomatic complexity | 25 | `web/eslint.config.js` |

Each limit is the maximum found when it was introduced, and it does not go up: split the
function instead.

Coverage says which lines run, not whether anything checks them. For that there is
**mutation testing**: change one thing and see whether a test notices.

```sh
cargo mutants -p mhc-core -p mhc-api --timeout 60
```

### Throwing garbage at it

Inputs and orderings nobody would think of are generated by machine. Every generator is
seeded, so a failure always reproduces. They run as part of the ordinary test suites
(`cargo test`, `npm test`, Playwright), so CI runs them on every pull request.

| | target | checks |
|---|---|---|
| stateful fuzzing | random operation sequences through the API (`dispatch`) | owners never vanish, failed calls change nothing, no panics |
| fuzzing | the numeric ABI and the WASM bridge (including broken UTF-8) | no panics, responses keep their shape |
| fuzzing | comment Markdown, imported files, CSV | no dangerous links, no hangs, round trips hold |
| monkey testing | the shipped page itself | no exceptions, no network traffic, input never runs as script |

```sh
MHC_FUZZ_ITERS=20000 cargo test --release fuzz      # raise the count for a deeper run
MHC_MONKEY_STEPS=1000 npx playwright test monkey    # from e2e/
```

### From the attacker's side

Tests that assume a hostile caller are part of the ordinary suites too.

- **Server**: every route in the route table is called with someone else's ids from an
  unrelated account and must neither succeed nor change anything (BOLA/IDOR).
  Authentication happens before the body is read, and every response carries defensive
  headers (clickjacking, MIME sniffing, caching). SQL metacharacters, path tricks,
  oversized bodies and 16 concurrent writers are tried as well
- **Shipped page**: the HTML carries a CSP. Inline scripts are named by their SHA-256 at
  build time and nothing else runs. Names exported to CSV never become spreadsheet
  formulas. ESLint forbids `innerHTML` and `eval`
- **Accessibility**: axe finds zero WCAG 2.2 AA issues (light/dark × Japanese/English)

There is also fault injection (a failing store or localStorage never leaves a half-done
change), migration tests (every past save format and database opens), golden tests (the
same input gives the same numbers across versions), contract tests between the UI and the
API, performance and soak tests, and a narrow-screen check. The full map is in
[docs/VERIFICATION.md](docs/VERIFICATION.md).

```sh
MHC_UPDATE_GOLDEN=1 cargo test golden store_formats   # when a golden file changes on purpose
```

CI runs it nightly at 03:00 JST across four parallel shards (and on demand via
`workflow_dispatch`). If the catch rate — `caught / (caught + missed)` — drops below the
bar, it files an issue listing every mutant that got away. Those are lines the tests walk
through without checking anything.

## How it works

```
              ┌───────────── dist/app.html (one file) ─────────────┐
 cargo xtask  │  <style> …CSS… </style>                            │
    build ──▶ │  <script> const WASM_BASE64 = "AGFzbQ…";  …JS…      │
              │  WebAssembly.instantiate(atob(WASM_BASE64))         │
              └────────────────────────────────────────────────────┘
                          ▲                      ▲
              crates/wasm — a thin FFI      web/ — TypeScript
              layer (the only unsafe)       bundled by esbuild
                          ▲
              crates/core — the computation (#![forbid(unsafe_code)])
```

We never call `fetch()`, because a page opened over `file://` has its `fetch()` blocked by
CORS. The WASM is embedded in the HTML as a base64 string.

### The client and the API

The UI knows **one interface, and only that**. Behind it sits either

- `LocalApiClient` — the WASM inside the same HTML file
- `HttpApiClient` — an internal or cloud server

and both end up in the same implementation in `crates/api`. Permission checks and the
invariants ("there is always at least one owner") live in exactly one place, so the UI and
the server can never disagree about what is allowed.

**Computation does not live on the server.** The estimate is computed by the WASM bundled
with the client, so a server only has to hold data and check permissions. See `docs/API.md`.

### The project list

With several projects, the hard part is knowing which one is in trouble. So the list puts
**the status in the first column and the ones needing attention first**.

| Status | Meaning |
|---|---|
| **Late** | Has a due date. Will not make it even at P50 |
| **Behind pace** | No due date. Effort consumed exceeds reported progress by 10pt or more |
| At risk | Has a due date. Makes it at P50 but not at P80 |
| Needs recompute | Content changed and has not been recomputed (numbers are hidden) |
| On track / In progress / Done / No tasks | Everything else |

Status is **never shown by colour alone**. An icon and a word always come with it, so it
reads the same if you cannot tell the colours apart, or print it in black and white.

The judgement lives in exactly one place on the Rust side (`crates/api/src/health.rs`); the
UI only lays out the result. Only projects you may see are listed, and the API decides that
too.

The numbers are computed by the client once, when saving, and sent along with the save.
Recomputing every project's content on every listing would be expensive. If the content
changed and has not been recomputed, we **hide the old numbers and say "needs recompute"**
instead.

### The server (for a team)

You do not need it on your own. For a team, it is **one binary to start**.

```sh
cargo xtask build                          # build the UI first
cargo build --profile server -p mhc-server
./target/server/mhc-server                 # → prints an admin account and a token, once
```

SQLite and the UI are inside the binary, so there is no database to set up and no web
server to run beside it. Storage is SQLite or PostgreSQL; authentication is a token, a
trusted header, or none. See `docs/SERVER.md`.

| Directory | Contents |
|---|---|
| `crates/api` | API types, permissions and behaviour, shared by client and server |
| `crates/server` | The server. One binary, storing into SQLite or PostgreSQL |
| `crates/core` | Distributions, RNG, the two engines, dates, holidays, people, calendars, actuals, statistics, ABI |
| `crates/wasm` | The FFI layer that exposes computation and the API to WebAssembly |
| `crates/xtask` | The build tool that bundles `web` and assembles `dist/` |
| `web` | The TypeScript frontend, and the introduction page for GitHub Pages |
| `e2e` | Playwright tests over `file://` |
| `docs/ABI.md` | Layout of the computation buffers between JS and WASM |
| `docs/API.md` | How client and server are split, and the permission model |
| `docs/openapi.yaml` | The HTTP shape of the API |
| `docs/SERVER.md` | Running the server: authentication, storage, operations |
| `docs/AWS.md` | Putting it on API Gateway + Lambda + DynamoDB |

### From people and effort to dates

The calendar holds, **for each person separately**, how much effort (in person-days) they
can put in on each calendar day, and keeps the running total.

```
working minutes = length of that weekday's working hours
                − break minutes
                − minutes where a meeting covers the working hours
                  (overlaps counted once)
effort          = working minutes ÷ 60 ÷ hours per person-day
weekends and holidays → 0 (unless marked as working that day)
```

Working hours are held as "from this time to that time" so that a 5-minute meeting can be
subtracted correctly. For someone working 9:00–18:00, a meeting from 8:00 to 9:00 takes
nothing away.

Meanwhile the core returns the distribution of "cumulative effort up to task i **within the
same assignee**". Tasks belonging to one person run in order; different people run in
parallel. Put those two together and you can read

```
P(task i is finished by day d)
    = P(cumulative effort within the assignee ≤ that person's cumulative capacity by d)
```

with no extra simulation.

A group spanning several people (a parent task, or the whole project) is finished when
**everyone involved has finished their own part**, so it is the product of the per-person
probabilities. Tasks are treated as independent, so the sums held by different people are
independent too, and the product is exact — no simulation of a maximum is needed.

A parent task is finished when all of its leaves are, and keeping the depth-first order
means we only have to pick out "the last task under it, per person".

### Folding in actuals

For a task with progress `p` and effort already spent `spent`, we split the original
three-point estimate `(a, m, b)` into **what is left** and **the total**.

```
remaining = (1 − p)·(a, m, b)
total     = spent + remaining
```

**The schedule consumes the remaining part.** Feeding the total into the schedule would
mean paying for finished work again out of future capacity, and a task that is 80% done
would not move its finish date at all. The distribution of the total is the distribution of
the remaining shifted by the spent effort (a constant offset, so the shape is unchanged).

The formula was chosen so the boundaries behave plainly. At `p = 0` the remaining is the
original estimate; at `p = 1` the remaining is 0 and the total collapses onto `spent`; at
exactly the planned pace (`spent = p·m`) the total does not move. The further behind, the
higher the total; the further along, the narrower the remaining. It is more conservative
than EVM, which assumes the observed pace continues, and it does not swing the original
estimate around while progress is still shallow.

Spent effort is measured on the assignee's calendar, from the start date to the reference
date. When there is no start date, or the start date falls outside the computed range, we
cannot measure it; then we assume the work went **as estimated** and use
`spent = p × E[original]` (the expected value). Using the expected value keeps the expected
total from moving:

```
E[total] = p·E[original] + (1 − p)·E[original] = E[original]
```

Nothing is known about the consumption, so there is no reason for the expectation to move.
The width does shrink to `1 − p` of the original, so tail values such as P80 come down —
the part that is finished cannot surprise us any more.

### Distributions

- **PERT (beta)** — the standard choice in practice. The mean is `(a + λm + b) / (λ + 2)`
  (with the default `λ = 4`, the familiar `(a + 4m + b) / 6`). There is no closed-form
  inverse, so we integrate the beta PDF numerically into a CDF grid and precompute an
  inverse-CDF table from it. Building it from a cumulative sum guarantees, by construction,
  that the table is monotone and that its ends are exactly `a` and `b`.
- **Triangular** — both the CDF and its inverse are closed-form. Heavier ends mean more
  spread than PERT.

### Two engines

| | Monte Carlo | Numeric convolution |
|---|---|---|
| What it does | Sample each task, sum, repeat | Convolve each task's distribution on a shared grid |
| Randomness | xoshiro256++ (fully reproducible from a fixed seed) | None |
| Error | Sampling error remains | Discretisation only; deterministic |
| Cumulative sums | Counts per-assignee indices per trial | Re-convolves per assignee, writing out the intermediate steps |

**They are implemented separately so that each is the other's oracle.** A bug in one does
not exist in the other, so the test "both engines agree on P50 / P80 / P90 and on each
task's cumulative sum, within 1% of the range" effectively backs the numerical core.

## How quality is built in

- `crates/core` is `#![forbid(unsafe_code)]`. The only `unsafe` is in the FFI layer in
  `crates/wasm`
- `TaskEstimate` is a smart constructor (parse, don't validate). If a value exists, the type
  guarantees `0 ≤ min ≤ likely ≤ max` and that all of them are finite
- `compute` never panics. Invalid input comes back as a status code
- TypeScript runs with `strict` plus `noUncheckedIndexedAccess` and
  `exactOptionalPropertyTypes`. ESLint runs the type-aware `strictTypeChecked` set
- JSON and CSV read from outside are checked field by field, and anything bad falls back to
  a default
- A task with nobody assigned is not quietly pushed onto someone; it is collected under an
  "unassigned" placeholder person, and shown as such
- Japanese public holidays, including equinoxes from an approximation formula, are pinned
  against the published dates by a test
- **Bounded model checking with [Kani](https://model-checking.github.io/kani/)** proves 11
  invariants over *every* input in a range, not just sampled ones — the date round-trip,
  the estimate invariant, the response-buffer layout, and the permission ordering
- **[TLA+](https://lamport.azurewebsites.net/tla/tla.html) with TLC** model-checks the
  access design: every reachable state must leave each project with at least one real
  owner. It found holes the unit tests did not
- **`cargo miri`** runs the FFI layer under strict provenance, so the one place that
  handles raw pointers from JavaScript is checked for undefined behaviour
- `docs/VERIFICATION.md` traces each promise to how it is checked, and says how strong
  that check is

## What is next

- Deploying to AWS (API Gateway + Lambda + DynamoDB). The design and the steps are written
  up in `docs/AWS.md`; what is left is the `Store` implementation and the outer handler
- Correlation between tasks (a single-factor Gaussian copula). The ABI has room reserved

## License

MIT
