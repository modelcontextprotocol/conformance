# Toolchain image for running the conformance SDK matrix locally with the same
# coverage as the sdk-matrix GitHub Actions workflow: Node (harness +
# typescript-sdk), uv/Python (python-sdk), Go (go-sdk), rustup (rust-sdk),
# .NET SDK (csharp-sdk), Ruby + Bundler (ruby-sdk) and a JDK (java/kotlin).
#
# Everything is installed from each toolchain's default public source. Package
# registries used at *run* time (npm, PyPI, crates.io, NuGet, RubyGems, the Go
# module proxy) are also the public defaults; scripts/sdk-matrix-docker.sh can
# forward a mirror configuration into the container for environments that
# need one. Nothing environment-specific is baked into the image.
#
# Build:  docker build -t conformance-sdk-matrix --build-arg UID=$(id -u) --build-arg GID=$(id -g) docker/sdk-matrix
# Run:    scripts/sdk-matrix-docker.sh --mode client --scenario initialize
FROM ubuntu:24.04

ARG NODE_MAJOR=22
# Empty means "latest stable" as published by go.dev at build time.
ARG GO_VERSION=""
# csharp-sdk pins its SDK band in global.json (rollForward: minor); 10.0 today.
ARG DOTNET_CHANNEL=10.0
ARG RUST_TOOLCHAIN=stable
ARG UID=1000
ARG GID=1000

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git gnupg jq unzip xz-utils tzdata procps \
      build-essential pkg-config libssl-dev zlib1g-dev libyaml-dev libffi-dev \
      libicu74 \
      python3 python3-venv python3-dev \
      ruby-full ruby-bundler \
      openjdk-21-jdk-headless \
 && rm -rf /var/lib/apt/lists/*

# Node.js (official tarball) + corepack, which provides the pnpm that
# typescript-sdk's packageManager field pins.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; case "$arch" in amd64) node_arch=x64;; arm64) node_arch=arm64;; *) echo "unsupported arch $arch"; exit 1;; esac; \
    base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"; \
    file="$(curl -fsSL "$base/SHASUMS256.txt" | awk -v a="linux-${node_arch}.tar.xz" '$2 ~ a {print $2; exit}')"; \
    curl -fsSL "$base/$file" -o /tmp/node.tar.xz; \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner; \
    rm /tmp/node.tar.xz; \
    corepack enable; \
    node --version; npm --version

# uv (python-sdk); uv fetches a matching CPython on demand.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# Go (go-sdk)
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    v="${GO_VERSION:-$(curl -fsSL 'https://go.dev/VERSION?m=text' | head -n1)}"; \
    case "$v" in go*) ;; *) v="go$v";; esac; \
    curl -fsSL "https://go.dev/dl/${v}.linux-${arch}.tar.gz" | tar -xz -C /usr/local; \
    /usr/local/go/bin/go version
ENV PATH=/usr/local/go/bin:$PATH

# Rust (rust-sdk). rust-sdk pins its own channel in rust-toolchain.toml, which
# rustup installs on first use; the entrypoint moves RUSTUP_HOME onto the cache
# volume so that download happens once.
ENV RUSTUP_HOME=/opt/rust/rustup \
    CARGO_HOME=/opt/rust/cargo
RUN set -eux; \
    curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain "${RUST_TOOLCHAIN}" --no-modify-path; \
    chmod -R a+rwX /opt/rust; \
    /opt/rust/cargo/bin/cargo --version
ENV PATH=/opt/rust/cargo/bin:$PATH

# .NET SDK (csharp-sdk)
RUN set -eux; \
    curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh; \
    bash /tmp/dotnet-install.sh --channel "${DOTNET_CHANNEL}" --install-dir /opt/dotnet; \
    rm /tmp/dotnet-install.sh; \
    ln -s /opt/dotnet/dotnet /usr/local/bin/dotnet; \
    dotnet --version
ENV DOTNET_ROOT=/opt/dotnet \
    DOTNET_CLI_TELEMETRY_OPTOUT=1 \
    DOTNET_NOLOGO=1 \
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    DOTNET_GENERATE_ASPNET_CERTIFICATE=false

# Non-root user matching the host uid/gid so files written to the bind-mounted
# checkout stay owned by the invoking user.
RUN set -eux; \
    if id ubuntu >/dev/null 2>&1; then userdel -r ubuntu || true; fi; \
    if ! getent group "${GID}" >/dev/null; then groupadd -g "${GID}" runner; fi; \
    useradd -m -u "${UID}" -g "${GID}" -s /bin/bash runner; \
    mkdir -p /work /cache; chown "${UID}:${GID}" /work /cache

COPY entrypoint.sh /usr/local/bin/sdk-matrix-entrypoint
RUN chmod 0755 /usr/local/bin/sdk-matrix-entrypoint

USER runner
WORKDIR /work
VOLUME ["/cache"]
ENV SDK_MATRIX_IN_DOCKER=1 \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=1
ENTRYPOINT ["/usr/local/bin/sdk-matrix-entrypoint"]
