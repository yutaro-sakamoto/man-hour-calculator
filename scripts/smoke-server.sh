#!/usr/bin/env bash
# 組み立てたサーバのバイナリを実際に起動し、通しで確かめて止める。
#
#   ./scripts/smoke-server.sh [バイナリ] [待ち受け]    (make smoke)
#
# 起動 → 管理者とトークンが出る → 認証が要る → トークンで通る → 作って
# 読み返せる → 画面が同じバイナリから返る、を見る。CI の server ジョブと
# Dev Container のジョブが同じものを呼ぶ (筋書きを 2 か所に書かない)。
set -euo pipefail

cd "$(dirname "$0")/.."

binary="${1:-./target/server/mhc-server}"
listen="${2:-127.0.0.1:8080}"
base="http://$listen"
work="$(mktemp -d)"

if [ ! -x "$binary" ]; then
  echo "$binary がありません。make server-bin を先に" >&2
  exit 1
fi

"$binary" --db "sqlite:$work/smoke.db" --listen "$listen" > "$work/server.log" 2>&1 &
pid=$!
# 落ちても止めても、起動したサーバと作ったものは片付ける。
trap 'kill "$pid" 2> /dev/null || true; rm -rf "$work"' EXIT

for _ in $(seq 30); do
  curl -sf "$base/healthz" > /dev/null && break
  sleep 1
done
cat "$work/server.log"
token=$(grep -oP 'トークン: \K[0-9a-f]{64}' "$work/server.log")
test -n "$token"

# 応答はいったんファイルに落としてから調べる。
# curl をそのまま grep -q に繋ぐと、大きな本文のときに grep が先に
# 閉じて curl が「書けなかった」(23) と言って落ちる。
auth="Authorization: Bearer $token"

# 認証が要ること
test "$(curl -s -o /dev/null -w '%{http_code}' "$base/v1/projects")" = 401
# トークンで通ること
curl -sf -H "$auth" -o "$work/me.json" "$base/v1/me"
grep -q '"systemRole":"admin"' "$work/me.json"
# 作って読み返せること
curl -sf -X POST -H "$auth" -H 'Content-Type: application/json' \
  -d '{"id":"p1","name":"CI"}' -o /dev/null "$base/v1/projects"
curl -sf -H "$auth" -o "$work/projects.json" "$base/v1/projects"
grep -q '"name":"CI"' "$work/projects.json"
# 画面が同じバイナリから返ること (案内ページではなく本物)
curl -sf -o "$work/ui.html" "$base/"
grep -q '工数見積もり / Effort Estimator' "$work/ui.html"

echo "スモークテストを通りました ($binary)"
