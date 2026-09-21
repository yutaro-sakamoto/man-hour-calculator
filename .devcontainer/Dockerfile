# 開発環境。いままで口伝だったものを全部ここに入れる。
#
# Rust の版は `rust-toolchain.toml` が決める (バージョンの出どころを 1 つに
# 保つため、ここには書かない)。ベースイメージの rustup が起動時に解決する。
FROM mcr.microsoft.com/devcontainers/rust:1-1-bookworm

# SQLite を同梱ビルドするのに C コンパイラが要る。`build-essential` は
# ベースイメージに入っているが、明示しておく (入れ替わったときに気づける)。
RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential pkg-config \
    && rm -rf /var/lib/apt/lists/*

# wasm-opt は binaryen から入れる。**apt のものは使えない** — 古くて、
# rustc が既定で出す sign-ext 命令を検証で弾く。
ARG BINARYEN_VERSION=123
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) target="x86_64-linux" ;; \
      arm64) target="aarch64-linux" ;; \
      *) echo "binaryen の配布が無い arch: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL --retry 5 --retry-delay 2 --retry-all-errors -o /tmp/binaryen.tar.gz \
      "https://github.com/WebAssembly/binaryen/releases/download/version_${BINARYEN_VERSION}/binaryen-version_${BINARYEN_VERSION}-${target}.tar.gz"; \
    tar xzf /tmp/binaryen.tar.gz -C /opt; \
    mv "/opt/binaryen-version_${BINARYEN_VERSION}" /opt/binaryen; \
    rm /tmp/binaryen.tar.gz; \
    ln -s /opt/binaryen/bin/wasm-opt /usr/local/bin/wasm-opt; \
    wasm-opt --version
