#!/bin/sh
# Connect a machine to Croft in one line:
#
#   curl -fsSL https://raw.githubusercontent.com/montytorr/croft/main/install.sh | sh -s -- --url https://your-croft
#
# This script does exactly two things: put a recent cli/croft.mjs on PATH,
# and hand off to it. Everything else -- pairing keys, the skill, the hooks,
# the scheduled jobs -- is `croft setup`'s job (cli/croft.mjs), not this
# script's; duplicating that logic here in POSIX sh would be a second place
# for it to drift out of step with the CLI it is supposed to install.
#
# From a fork or a private mirror on GitHub, name it:
#
#   curl -fsSL https://raw.githubusercontent.com/<owner>/<name>/main/install.sh \
#     | CROFT_REPO=<owner>/<name> sh -s -- --url https://your-croft
#
# CROFT_REPO is <owner>/<name> and nothing else (it becomes part of a URL whose
# answer is then run). `croft setup` reads the same variable, so the release it
# unpacks and the tag the agent-files job follows come from that repository
# too, rather than quietly from the public one.
set -eu

# Everything in one function, called on the last line: a download cut off
# halfway defines a function it never calls, instead of running half a script.
main() {
  REPO="${CROFT_REPO:-montytorr/croft}"
  BIN_DIR="$HOME/.local/bin"
  BIN="$BIN_DIR/croft"

  log() { printf '%s\n' "$*" >&2; }
  die() { log "install.sh: $*"; exit 1; }

  # One slash, and on each side only what GitHub allows in a name. Anything
  # else -- a second slash, "..", a space, a URL -- is refused, not cleaned up.
  case "$REPO" in
    */*/*|/*|*/|*..*|./*|*/.) die "CROFT_REPO=$REPO is not <owner>/<name>" ;;
    */*) ;;
    *) die "CROFT_REPO=$REPO is not <owner>/<name>" ;;
  esac
  case "$REPO" in
    *[!A-Za-z0-9_./-]*) die "CROFT_REPO=$REPO is not <owner>/<name>" ;;
  esac
  export CROFT_REPO="$REPO"

  command -v node >/dev/null 2>&1 || die "node is not on PATH — install Node 22 or newer first"

  # node --version prints "vX.Y.Z"; strip the leading v and compare the major.
  node_major=$(node --version | sed 's/^v//' | cut -d. -f1)
  case "$node_major" in
    ''|*[!0-9]*) die "could not read node's version from 'node --version'" ;;
  esac
  if [ "$node_major" -lt 22 ]; then
    die "node $(node --version) is too old — croft needs Node 22 or newer"
  fi

  # The latest release's tag, or main if the API is unreachable (rate limited,
  # offline mirror, a fork with no releases yet) -- a fetch from main is a
  # working install, just not a pinned one, and that beats refusing outright.
  tag=""
  if command -v curl >/dev/null 2>&1; then
    tag=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
      | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -n1)
  fi
  ref="${tag:-main}"
  [ -n "$tag" ] || log "could not resolve the latest release; installing cli/croft.mjs from $ref instead"

  url="https://raw.githubusercontent.com/$REPO/$ref/cli/croft.mjs"

  mkdir -p "$BIN_DIR"
  tmp="$BIN.download"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$tmp" || die "could not download $url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$tmp" "$url" || die "could not download $url"
  else
    die "need curl or wget to download croft"
  fi
  chmod +x "$tmp"
  mv "$tmp" "$BIN"

  log "installed $BIN ($ref)"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) log "note: $BIN_DIR is not on PATH — add: export PATH=\"\$HOME/.local/bin:\$PATH\"" ;;
  esac

  exec "$BIN" setup "$@"
}

main "$@"
