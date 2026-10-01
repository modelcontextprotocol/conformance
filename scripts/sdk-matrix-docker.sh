#!/usr/bin/env bash
# Run scripts/sdk-matrix.mjs inside the docker/sdk-matrix toolchain image, so
# every SDK in KNOWN_SDKS can be built locally without installing six
# toolchains. Builds the image on first use; SDK clones, builds and package
# caches persist in a named volume so reruns are fast.
#
#   scripts/sdk-matrix-docker.sh --mode client --scenario auth/metadata-default
#   scripts/sdk-matrix-docker.sh --sdks rust-sdk,csharp-sdk --mode server --scenario tools-list
#   scripts/sdk-matrix-docker.sh --ref 488 --mode client --suite auth
#
# Everything after the wrapper's own options is passed to sdk-matrix.mjs
# (see `node scripts/sdk-matrix.mjs --help`). Results land in
# ./sdk-matrix-results unless you pass -o (paths are relative to the checkout,
# which is mounted at /work).
#
# Wrapper options (must come first):
#   --rebuild             Rebuild the image even if it exists
#   --image NAME          Image tag (default: conformance-sdk-matrix)
#   --volume NAME         Cache volume (default: conformance-sdk-matrix-cache)
#   --docker-arg ARG      Extra `docker run` argument (repeatable)
#
# Registry mirrors (all optional; the default is each ecosystem's public
# registry). Each flag copies one config file into the container for that run:
#   --npmrc FILE          npm/pnpm .npmrc
#   --cargo-config FILE   cargo config.toml (e.g. [source.crates-io] replace-with)
#   --pip-conf FILE       pip.conf         --uv-config FILE      uv.toml
#   --nuget-config FILE   NuGet.Config     --gemrc FILE          .gemrc
#   --bundle-config FILE  bundler config
#   --env NAME[=VALUE]    Forward an environment variable (repeatable), e.g.
#                         --env GOPROXY --env UV_INDEX_URL --env NPM_CONFIG_REGISTRY
#
# The container gets outbound network only (no published ports) and no
# credentials: this script never mounts SSH keys, git credential helpers, gh
# config or tokens. If a mirror needs authentication, pass exactly the config
# file or variable that carries it, knowing it will be visible to the SDK
# builds inside the container.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"

image="${SDK_MATRIX_IMAGE:-conformance-sdk-matrix}"
volume="${SDK_MATRIX_VOLUME:-conformance-sdk-matrix-cache}"
rebuild=0
docker_args=()
cfg_mounts=()

add_cfg() { # <flag> <file> <name-in-container>
  local file="$2"
  if [ ! -f "$file" ]; then
    echo "$1: no such file: $file" >&2
    exit 2
  fi
  file="$(cd "$(dirname "$file")" && pwd)/$(basename "$file")"
  cfg_mounts+=(-v "$file:/etc/sdk-matrix/$3:ro")
}

while [ $# -gt 0 ]; do
  case "$1" in
    --rebuild) rebuild=1; shift ;;
    --image) image="$2"; shift 2 ;;
    --volume) volume="$2"; shift 2 ;;
    --docker-arg) docker_args+=("$2"); shift 2 ;;
    --npmrc) add_cfg "$1" "$2" npmrc; shift 2 ;;
    --cargo-config) add_cfg "$1" "$2" cargo-config.toml; shift 2 ;;
    --pip-conf) add_cfg "$1" "$2" pip.conf; shift 2 ;;
    --uv-config) add_cfg "$1" "$2" uv.toml; shift 2 ;;
    --nuget-config) add_cfg "$1" "$2" NuGet.Config; shift 2 ;;
    --gemrc) add_cfg "$1" "$2" gemrc; shift 2 ;;
    --bundle-config) add_cfg "$1" "$2" bundle-config; shift 2 ;;
    --env) docker_args+=(-e "$2"); shift 2 ;;
    --) shift; break ;;
    *) break ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required" >&2
  exit 2
fi

if [ "$rebuild" = 1 ] || ! docker image inspect "$image" >/dev/null 2>&1; then
  echo "Building $image (this takes a few minutes the first time)..." >&2
  docker build -t "$image" \
    --build-arg "UID=$(id -u)" --build-arg "GID=$(id -g)" \
    "$repo/docker/sdk-matrix"
fi

# Label the run with the checkout's ref: inside the container a worktree's
# .git may not resolve, so read it here.
ref="$(git -C "$repo" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
sha="$(git -C "$repo" rev-parse --short=12 HEAD 2>/dev/null || echo unknown)"

tty_args=()
if [ -t 0 ] && [ -t 1 ]; then tty_args=(-it); fi

# Rootless Docker maps the invoking host user to uid 0 inside the container, so
# there the image's uid-matched user would NOT own the bind mount; run as
# container-root instead (which is the unprivileged host user).
user_args=()
if docker info -f '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless; then
  user_args=(--user 0:0)
fi

name="conformance-sdk-matrix-$$"
echo "Running in container $name (volume $volume); results under $repo/sdk-matrix-results unless -o is given" >&2
# ${arr[@]+"${arr[@]}"}: empty-array-safe expansion for bash 3.2 (macOS) under set -u.
exec docker run --rm --name "$name" ${tty_args[@]+"${tty_args[@]}"} ${user_args[@]+"${user_args[@]}"} \
  -v "$repo:/work" \
  -v "$volume:/cache" \
  -e "SDK_MATRIX_HARNESS_REF=$ref" \
  -e "SDK_MATRIX_HARNESS_SHA=$sha" \
  ${cfg_mounts[@]+"${cfg_mounts[@]}"} \
  ${docker_args[@]+"${docker_args[@]}"} \
  "$image" "$@"
