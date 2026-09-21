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
  curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors -o "$JAR" \
    "https://github.com/tlaplus/tlaplus/releases/download/${TLA_VERSION}/tla2tools.jar"
fi

# **1 つも検査せずに緑にならないこと。** `.tla` が消えても `.cfg` が消えても、
# 素直に書くと「何もせず成功」になる。それでは見張りにならない。
shopt -s nullglob
specs=(*.tla)
if [ ${#specs[@]} -eq 0 ]; then
  echo "検査する仕様がありません (spec/*.tla)" >&2
  exit 1
fi

status=0
checked=0
for spec in "${specs[@]}"; do
  name="${spec%.tla}"
  if [ ! -f "$name.cfg" ]; then
    echo "==> $name: .cfg がありません" >&2
    status=1
    continue
  fi
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
  checked=$((checked + 1))
done

if [ "$checked" -eq 0 ]; then
  echo "1 つも検査できませんでした" >&2
  exit 1
fi
echo
echo "検査した仕様: $checked"
exit "$status"
