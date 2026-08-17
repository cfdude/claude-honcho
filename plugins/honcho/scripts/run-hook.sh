#!/bin/sh
# Upstream #82 — resolve the hook runtime, and FAIL LOUDLY when it is missing.
#
# Claude Code runs hooks non-interactively, so they do not necessarily inherit
# the shell PATH the runtime was installed onto (no .zshrc/.bashrc sourcing).
# When the runtime was invoked directly from hooks.json, a missing binary meant
# every hook exited non-zero with an empty message and memory capture simply
# stopped — nothing in the transcript, nothing in the plugin's own log (the log
# is written by the code that never got to run).
#
# The guard therefore has to live OUTSIDE the program: a fix written in
# TS/JS cannot run when the runtime that executes it is the thing that is
# missing.
#
# RUNTIME IS CHOSEN FROM THE TARGET EXTENSION:
#   *.js  -> node preferred, bun accepted as a fallback. This is the BUILT
#            artifact (scripts/build.ts bundles to dist/ with target "node"),
#            and the whole point of that build is that bun is NOT a prerequisite
#            for USING the plugin. Requiring bun here would silently undo it.
#   *.ts  -> bun required. Source mode, i.e. running from a working tree.
#
# POSIX sh only, no dependencies, no stdin reads (the hook payload on stdin must
# reach the exec'd process untouched), and one `exec` so no extra process
# lingers on the hot path.
#
# Precedent for shelling out from hooks.json: SessionStart already invokes
# `bash "${CLAUDE_PLUGIN_ROOT}/scripts/check-version.sh"`, so a shell entry point
# is an established, working shape for this plugin on every supported platform.
#
# Overrides (all optional):
#   HONCHO_BUN             absolute path to the bun binary to use
#   HONCHO_NODE            absolute path to the node binary to use
#   HONCHO_BUN_CANDIDATES  space-separated list replacing the default bun search
#   HONCHO_NODE_CANDIDATES space-separated list replacing the default node search
set -u

if [ "$#" -lt 1 ]; then
  echo "honcho: run-hook.sh requires a hook script path" >&2
  exit 1
fi

HOOK_SCRIPT="$1"
shift

# Resolve one binary: explicit override, then PATH, then a fixed candidate list.
# `command -v` is a shell builtin: no subprocess, no stdin, no measurable cost.
resolve_bin() {
  _name="$1"
  _override="$2"
  _candidates="$3"

  if [ -n "$_override" ] && [ -x "$_override" ]; then
    printf '%s' "$_override"
    return 0
  fi
  if command -v "$_name" >/dev/null 2>&1; then
    command -v "$_name"
    return 0
  fi
  for _candidate in $_candidates; do
    if [ -x "$_candidate" ]; then
      printf '%s' "$_candidate"
      return 0
    fi
  done
  return 1
}

DEFAULT_BUN="${HOME:-}/.bun/bin/bun /opt/homebrew/bin/bun /usr/local/bin/bun /usr/bin/bun ${HOME:-}/.local/bin/bun"
DEFAULT_NODE="/opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node ${HOME:-}/.local/bin/node ${HOME:-}/.nvm/versions/node/*/bin/node"

BUN_CANDIDATES="${HONCHO_BUN_CANDIDATES:-$DEFAULT_BUN}"
NODE_CANDIDATES="${HONCHO_NODE_CANDIDATES:-$DEFAULT_NODE}"

RUNTIME=""
case "$HOOK_SCRIPT" in
  *.js)
    # Built artifact: node first, bun as a fallback so a node-less machine that
    # happens to have bun still works.
    RUNTIME="$(resolve_bin node "${HONCHO_NODE:-}" "$NODE_CANDIDATES" 2>/dev/null || true)"
    if [ -z "$RUNTIME" ]; then
      RUNTIME="$(resolve_bin bun "${HONCHO_BUN:-}" "$BUN_CANDIDATES" 2>/dev/null || true)"
    fi
    MISSING_MSG="honcho: neither 'node' nor 'bun' found - memory capture is DISABLED for this session. Claude Code runs hooks without your shell PATH; install Node (https://nodejs.org) or set HONCHO_NODE=/absolute/path/to/node."
    ;;
  *)
    # Source mode: only bun executes TypeScript directly.
    RUNTIME="$(resolve_bin bun "${HONCHO_BUN:-}" "$BUN_CANDIDATES" 2>/dev/null || true)"
    MISSING_MSG="honcho: 'bun' not found - memory capture is DISABLED for this session. Claude Code runs hooks without your shell PATH; install bun (https://bun.sh) or set HONCHO_BUN=/absolute/path/to/bun. Searched PATH plus: $BUN_CANDIDATES"
    ;;
esac

if [ -z "$RUNTIME" ]; then
  # Exit non-zero WITHOUT writing to stdout. Per Claude Code's hook reference, a
  # non-zero exit other than 2 is a non-blocking error and "the transcript shows
  # a <hook name> hook error notice followed by the first line of stderr", so
  # this surfaces without --debug and without needing the JSON channel. Writing
  # to stdout would be wrong here: on UserPromptSubmit, exit-0 stdout is injected
  # into the model's context, so a diagnostic there could become fake memory.
  echo "$MISSING_MSG" >&2
  exit 1
fi

# `node file.js` and `bun run file` are both correct invocations; bun also
# accepts a bare path, so one form works for either runtime.
exec "$RUNTIME" "$HOOK_SCRIPT" "$@"
