# Project-Level Workspace Override (`.honcho.json`) — Design

**Date:** 2026-06-30
**Repo:** `cfdude/claude-honcho`, plugin `plugins/honcho` (installed via the
`rob-sherman-plugins` marketplace as a `git-subdir` on ref
`feat/per-directory-workspace`).
**Status:** Approved design — pending spec review.

## Goal

Let an individual repository declare which Honcho workspace it belongs to, so
that work in a Highway repo is recorded in the `highway` workspace and
everything else stays `personal` — automatically, persistently, and without
per-shell setup or per-call manual steps.

## Background / corrected diagnosis

The user keeps "bleeding" Highway work into the `personal` workspace. The
mechanism was misdiagnosed in a prior session (it blamed the shared `:8501`
HTTP worker — that is Claude Desktop's transport; Claude Code runs this plugin
as a **per-session stdio process** via `bun run mcp-server.ts`). The actual
findings, verified against the code and empirically:

1. **The resolver already honors `HONCHO_WORKSPACE` as the highest-priority
   override in every branch** of `resolveConfig()` (`src/config.ts`), and
   `mergeWithEnvVars()` does not touch `workspace`. Empirically:
   `loadConfig("claude_code")` resolves `personal` with the env unset and
   `highway` with `HONCHO_WORKSPACE=highway`. So the resolution logic is correct.
2. **The override never fired because the env var never reached the plugin.**
   `HONCHO_WORKSPACE` set in `.claude/settings.local.json`'s `env` block does
   not propagate to the plugin subprocess; only shell-*exported* vars do (which
   is why `HONCHO_ENDPOINT`/`HONCHO_API_KEY` from `~/.zshrc` appear as
   env-shadows but `HONCHO_WORKSPACE` never did). With the var absent,
   resolution falls through to the stored default `personal`.
3. **`set_config workspace=…` is a silent no-op (Issue B).** The config has
   `globalOverride: true`, so the resolver reads the **root** `workspace`
   field, but `set_config` writes to `hosts.claude_code.workspace` — which
   `globalOverride` ignores. It returns success and changes nothing.

`globalOverride: true` is intentional: with ~300 repos that are mostly
personal, it makes `personal` the default for everything. That stays. What is
missing is a **project-level** override that beats the global default — the
same precedence model Claude Code itself uses (project settings override user
settings).

## Design

### `.honcho.json` (project-level marker)

A repository opts into a workspace with a file at its root:

```json
{ "workspace": "highway" }
```

Only `workspace` is read for now (the format is forward-compatible — additional
keys such as `aiPeer` may be added later without breaking older plugins, which
ignore unknown keys). A missing, empty, or malformed `.honcho.json` is treated
as "no project override" and never raises.

### Precedence

Workspace resolves highest-to-lowest:

```
1. HONCHO_WORKSPACE environment variable   (runtime, one-off override)
2. .honcho.json `workspace` (nearest, walking up from cwd)   (project-level)
3. globalOverride root `workspace` / hosts block / built-in default   (= personal)
```

This inserts the project-level source between the existing env override and the
existing global default. Personal repos (no `.honcho.json`) are unchanged.

### Discovery (walk-up)

The nearest `.honcho.json` is found by walking **up** from the resolution `cwd`
to the filesystem root, stopping at `$HOME` (a `.honcho.json` placed in `$HOME`
itself is ignored, to avoid a surprise global override). The first one found
wins. This lets a single file at a repo root (e.g.
`highway-llm/.honcho.json`) cover the repo and all its subdirectories
(`highway-llm/projects/maca`, etc.). Mirrors how `.git`/`.claude` are located.

### Threading the directory into resolution

`resolveConfig()` currently computes `workspace` with no directory context. The
change adds an optional `cwd` parameter (and a `getProjectWorkspace(cwd)`
helper) wired at the two call sites that already know the directory:

- **Hooks** (`session-start`, `user-prompt`, `post-tool-use`, `stop`,
  `pre-compact`, `session-end`): pass `hookInput.workspace_roots?.[0] ??
  hookInput.cwd ?? process.cwd()` — the value they already compute for session
  naming.
- **MCP server** (`src/mcp/server.ts`): pass the existing
  `getLastActiveCwd() ?? process.cwd()` (already used for session URLs at lines
  526, 748). The hooks keep `lastActiveCwd` current in the shared cache, so the
  long-lived server resolves against the active project.

`getProjectWorkspace(cwd)` is read per-resolution (a cheap stat/read up the
tree), so switching projects resolves correctly. When `cwd` is omitted (callers
that have no directory), behavior is exactly as today.

Both resolution paths consult the project workspace so the precedence invariant
holds universally: `resolveConfig` (when `~/.honcho/config.json` exists) **and**
`loadConfigFromEnv` (the no-config-file fallback). Without this, a `.honcho.json`
repo on a machine lacking the config file would silently ignore the override.

### Secondary fixes (same bug surface, in scope)

- **`get_config` provenance.** `get_config` reports *where* the workspace came
  from, e.g. `workspace: highway (source: .honcho.json at
  /Users/.../highway-llm)` vs `(source: global default)` or `(source:
  HONCHO_WORKSPACE env)`. Turns this from a mystery into a one-glance check.
- **Issue B — `set_config` honesty.** When `globalOverride: true` makes a
  `set_config workspace=…` write ineffective (resolution reads root, not
  `hosts.<host>`), `set_config` must return a **clear warning** that the change
  will not take effect — never a silent success. It must NOT silently start
  writing the root `workspace` instead: that field is the global default, so
  changing it would flip all ~300 repos. The warning directs the user to
  `.honcho.json` for a per-repo workspace (the intended mechanism). Changing the
  global default remains a deliberate, separate action.
- **Documentation correction.** The user's global `CLAUDE.md` note claiming
  "the hosts block disables the `HONCHO_WORKSPACE` override" is false (env and
  now project-level always win). Correct it to describe the real precedence and
  the new `.honcho.json` mechanism.

### `.honcho.json` must never be committed

`.honcho.json` is a local trust-domain marker; committing it (or even a
per-repo `.gitignore` line naming it) into a company repo would leak the
existence of the `highway` workspace. The fix adds `.honcho.json` to the user's
**global** gitignore (`core.excludesfile`; create/point it at
`~/.config/git/ignore` if unset) — one entry, covers all repos, and leaves
nothing in any repo. The spec mandates: wherever a `.honcho.json` is created,
it is covered by the global gitignore and never tracked.

## Components / units

- `getProjectWorkspace(cwd: string): string | null` — new, in `src/config.ts`
  (or a small `src/project-config.ts`): walk-up discovery + parse of
  `.honcho.json`; returns the `workspace` string or `null`; never throws.
- `resolveConfig(raw, host, cwd?)` — extended to slot
  `getProjectWorkspace(cwd)` between the env var and the existing default in all
  three branches (`globalOverride`, hosts-block, legacy).
- `loadConfig(host?, cwd?)` — threads `cwd` through to `resolveConfig`.
- Hook + MCP-server call sites — pass their known `cwd`.
- `get_config` handler — compute and display workspace provenance.
- `set_config` handler — remove the silent no-op for the
  `globalOverride`-shadowed case.

## Error handling

- Missing `.honcho.json` → `null` (no override).
- Unreadable / invalid JSON / missing `workspace` key → `null` + a non-fatal
  log line; resolution falls through to the global default. Never throws, so a
  typo in one repo can never break the plugin everywhere.
- Walk-up stops at `$HOME`/filesystem root; bounded.

## Testing

Unit tests (resolver + discovery), no live server required:

1. No `.honcho.json` anywhere → `personal` (global default unchanged).
2. `.honcho.json {"workspace":"highway"}` in `cwd` → `highway`.
3. `.honcho.json` in a **parent** dir, resolving from a subdir → `highway`
   (walk-up).
4. `HONCHO_WORKSPACE=other` env set **and** a `.honcho.json` present → `other`
   (env beats project).
5. Malformed/empty `.honcho.json` → falls through to `personal`, no throw.
6. `.honcho.json` in `$HOME` only → ignored (still `personal`).
7. `get_config` provenance string is correct for each source (env / project /
   global).
8. `set_config workspace=…` under `globalOverride:true` returns a clear warning
   (not a silent success) and does not mutate the root `workspace`.

## Out of scope (YAGNI)

- Name-pattern matching (`highway-*`) — explicit `.honcho.json` is the chosen
  mechanism.
- Additional `.honcho.json` keys beyond `workspace` (format stays
  forward-compatible).
- Any migration of existing `~/.honcho/config.json` state beyond the Issue B
  fix.
- A CLI/skill to scaffold `.honcho.json` — may come later; for now the file is
  created by hand (and covered by the global gitignore).
