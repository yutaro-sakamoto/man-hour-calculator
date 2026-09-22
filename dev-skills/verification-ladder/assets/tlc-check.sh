#!/usr/bin/env bash
# TLA+ の仕様を TLC で検査する。tla2tools.jar は版を固定して取りに行く。
#
# **`.cfg` に INVARIANT が無いと、TLC は何も検査せずに緑になる。**
# `scripts/check-sync.sh` 側でも見張ること。
set -euo pipefail

cd "$(dirname "$0")"

VERSION="1.7.4"
JAR=".tla/tla2tools-${VERSION}.jar"

if [ ! -f "$JAR" ]; then
  mkdir -p .tla
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors -o "$JAR" \
    "https://github.com/tlaplus/tlaplus/releases/download/v${VERSION}/tla2tools.jar"
fi

failed=0
for spec in *.tla; do
  cfg="${spec%.tla}.cfg"
  [ -f "$cfg" ] || { echo "error: $spec に $cfg がありません" >&2; failed=1; continue; }
  echo "==> $spec"
  # -deadlock: 行き止まりは仕様の書き間違いのことが多いので見る
  java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC \
    -config "$cfg" -workers auto -deadlock "$spec" || failed=1
done
exit "$failed"
