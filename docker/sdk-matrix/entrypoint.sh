#!/usr/bin/env bash
# Entrypoint for the sdk-matrix image. Expects the conformance checkout at
# /work (bind mount) and a persistent volume at /cache, then runs
# scripts/sdk-matrix.mjs with the given arguments.
set -euo pipefail

WORK=/work
CACHE=/cache

if [ ! -f "$WORK/scripts/sdk-matrix.mjs" ]; then
  echo "sdk-matrix: expected a conformance checkout mounted at $WORK (scripts/sdk-matrix.mjs not found)" >&2
  exit 2
fi
if ! [ -w "$CACHE" ]; then
  echo "sdk-matrix: $CACHE is not writable by uid $(id -u); rebuild the image with --build-arg UID=$(id -u) or use a fresh volume" >&2
  exit 2
fi

# Everything a toolchain caches or installs at run time lives on the volume so
# reruns are fast: SDK clones/builds, cargo registry + pinned toolchains, Go
# module/build cache, uv's Pythons and wheels, pnpm store, NuGet packages, gems.
export HOME="$CACHE/home"
mkdir -p "$HOME"
export CARGO_HOME="$HOME/.cargo"
export RUSTUP_HOME="$CACHE/rustup"
if [ ! -d "$RUSTUP_HOME/toolchains" ]; then
  echo "sdk-matrix: seeding rustup into the cache volume (first run only)" >&2
  mkdir -p "$RUSTUP_HOME"
  cp -a /opt/rust/rustup/. "$RUSTUP_HOME/"
fi
export GEM_HOME="$HOME/.gem"
export BUNDLE_PATH="$GEM_HOME"
export PATH="$GEM_HOME/bin:$HOME/.local/bin:$PATH"
export GOPATH="$HOME/go"
export NUGET_PACKAGES="$HOME/.nuget/packages"

# Optional registry-mirror configuration forwarded by sdk-matrix-docker.sh.
# Files arrive read-only under /etc/sdk-matrix; copy them to where each tool
# looks, and remove stale copies when a file is no longer provided.
install_cfg() { # <source> <dest>
  local src="/etc/sdk-matrix/$1" dest="$2"
  if [ -f "$src" ]; then
    mkdir -p "$(dirname "$dest")"
    cp "$src" "$dest"
    chmod 0600 "$dest"
    echo "sdk-matrix: using $1 override" >&2
  else
    rm -f "$dest"
  fi
}
install_cfg npmrc "$HOME/.npmrc"
install_cfg cargo-config.toml "$CARGO_HOME/config.toml"
install_cfg pip.conf "$HOME/.config/pip/pip.conf"
install_cfg uv.toml "$HOME/.config/uv/uv.toml"
install_cfg NuGet.Config "$HOME/.nuget/NuGet/NuGet.Config"
install_cfg gemrc "$HOME/.gemrc"
install_cfg bundle-config "$HOME/.bundle/config"

git config --global --add safe.directory '*' >/dev/null 2>&1 || true

cd "$WORK"
if [ ! -d node_modules ]; then
  echo "sdk-matrix: installing harness dependencies (npm ci)" >&2
  npm ci
fi

exec node scripts/sdk-matrix.mjs --cache-dir "$CACHE/sdk-under-test" "$@"
