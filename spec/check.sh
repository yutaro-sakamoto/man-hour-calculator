#!/usr/bin/env bash
# TLA+ の仕様を TLC に掛ける。
#
# tla2tools.jar は取ってきて手元に置く (リポジトリには入れない)。
# 既に置いてあれば取り直さない。
set -euo pipefail

cd "$(dirname "$0")"

TLA_VERSION="${TLA_VERSION:-v1.7.4}"
JAR="${TLA_JAR:-$PWD/.tla/tla2tools.jar}"

if [ ! -f "$JAR" ]; then
  echo "==> tla2tools ${TLA_VERSION} を取得"
  mkdir -p "$(dirname "$JAR")"
  curl -fsSL -o "$JAR" \
    "https://github.com/tlaplus/tlaplus/releases/download/${TLA_VERSION}/tla2tools.jar"
fi

status=0
for spec in *.tla; do
  name="${spec%.tla}"
  [ -f "$name.cfg" ] || continue
  echo
  echo "==> $name"
  # -deadlock: このモデルは「もう何もできない」状態に達してよい
  #            (全部消したあとなど)。行き止まりは欠陥ではない。
  if java -XX:+UseParallelGC -cp "$JAR" tlc2.TLC \
      -workers auto -deadlock -config "$name.cfg" "$spec"; then
    echo "==> $name: OK"
  else
    echo "==> $name: 反例あり" >&2
    status=1
  fi
done

exit "$status"
