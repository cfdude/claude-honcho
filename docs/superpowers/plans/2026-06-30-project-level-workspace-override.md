# Project-Level Workspace Override (`.honcho.json`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a repo declare its Honcho workspace via a `.honcho.json` file that overrides the global default, so Highway repos record to `highway` automatically while everything else stays `personal`.

**Architecture:** Add directory-aware workspace resolution to the plugin's config layer. A new `getProjectWorkspace(cwd)` walks up from the working directory to the nearest `.honcho.json` and returns its `workspace`. `resolveConfig()` slots this between the existing `HONCHO_WORKSPACE` env override and the global default, in all three branches. `loadConfig()` gains an optional `cwd` that defaults to `getLastActiveCwd() ?? process.cwd()`, so existing callers need no change. Plus: `get_config` shows workspace provenance, `set_config` warns instead of silently no-op-ing under `globalOverride`, `.honcho.json` is added to the global gitignore, and the stale CLAUDE.md note is corrected.

**Tech Stack:** TypeScript, Bun (runtime + `bun test`), Node `fs`/`path`/`os`.

**Repo:** `cfdude/claude-honcho`, working in `plugins/honcho/`, on branch `feat/project-level-workspace` (already created off `feat/per-directory-workspace`).

## Global Constraints

- Precedence (highest→lowest): `HONCHO_WORKSPACE` env → `.honcho.json` `workspace` (nearest, walking up) → existing global default (`globalOverride` root `workspace` / hosts block / `DEFAULT_WORKSPACE`).
- `.honcho.json` reads only the `workspace` key for now; unknown keys ignored (forward-compatible).
- A missing/empty/malformed/unreadable `.honcho.json` resolves to "no override" and MUST NEVER throw.
- Walk-up stops at `stopDir` (default `os.homedir()`): a `.honcho.json` at `stopDir` itself is ignored.
- No change to the 15 existing `loadConfig()` callers — `cwd` defaults inside `loadConfig`.
- `set_config` MUST NOT silently mutate the root `workspace` (that is the global default for ~300 repos).
- All work on `plugins/honcho/`; tests via `bun test` run from `plugins/honcho/`.
- `.honcho.json` must be in the global gitignore; never tracked.

---

### Task 1: `getProjectWorkspace(cwd, stopDir?)` + test harness

**Files:**
- Create: `plugins/honcho/src/project-config.ts`
- Test: `plugins/honcho/src/project-config.test.ts`

**Interfaces:**
- Produces: `getProjectWorkspace(cwd: string, stopDir?: string): string | null` — walks up from `cwd` to the nearest `.honcho.json`, returns its `workspace` string, else `null`. Never throws. `stopDir` defaults to `os.homedir()`; the search excludes `stopDir` and above.

- [ ] **Step 1: Write the failing tests**

```typescript
// plugins/honcho/src/project-config.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectWorkspace } from "./project-config.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "honcho-proj-"));
}

test("returns null when no .honcho.json exists", () => {
  const root = tmp();
  const dir = join(root, "repo");
  mkdirSync(dir);
  expect(getProjectWorkspace(dir, root)).toBeNull();
  rmSync(root, { recursive: true, force: true });
});

test("reads workspace from .honcho.json in the cwd", () => {
  const root = tmp();
  const dir = join(root, "repo");
  mkdirSync(dir);
  writeFileSync(join(dir, ".honcho.json"), JSON.stringify({ workspace: "highway" }));
  expect(getProjectWorkspace(dir, root)).toBe("highway");
  rmSync(root, { recursive: true, force: true });
});

test("walks up to a parent .honcho.json from a subdirectory", () => {
  const root = tmp();
  const repo = join(root, "repo");
  const sub = join(repo, "projects", "maca");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(repo, ".honcho.json"), JSON.stringify({ workspace: "highway" }));
  expect(getProjectWorkspace(sub, root)).toBe("highway");
  rmSync(root, { recursive: true, force: true });
});

test("ignores a .honcho.json located at stopDir", () => {
  const root = tmp();
  const dir = join(root, "repo");
  mkdirSync(dir);
  writeFileSync(join(root, ".honcho.json"), JSON.stringify({ workspace: "highway" }));
  expect(getProjectWorkspace(dir, root)).toBeNull();
  rmSync(root, { recursive: true, force: true });
});

test("returns null for malformed JSON without throwing", () => {
  const root = tmp();
  const dir = join(root, "repo");
  mkdirSync(dir);
  writeFileSync(join(dir, ".honcho.json"), "{ not valid json");
  expect(getProjectWorkspace(dir, root)).toBeNull();
  rmSync(root, { recursive: true, force: true });
});

test("returns null when workspace key is missing or empty", () => {
  const root = tmp();
  const dir = join(root, "repo");
  mkdirSync(dir);
  writeFileSync(join(dir, ".honcho.json"), JSON.stringify({ aiPeer: "claude" }));
  expect(getProjectWorkspace(dir, root)).toBeNull();
  rmSync(root, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/honcho && bun test src/project-config.test.ts`
Expected: FAIL — `Cannot find module "./project-config.js"` (module not yet created).

- [ ] **Step 3: Implement `getProjectWorkspace`**

```typescript
// plugins/honcho/src/project-config.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Walk up from `cwd` to the nearest `.honcho.json` and return its `workspace`.
 * Returns null when none is found, or when the file is missing/empty/malformed
 * or lacks a non-empty string `workspace`. Never throws.
 *
 * The search excludes `stopDir` (default: the user's home directory) and any
 * ancestor of it, so a `.honcho.json` placed directly in $HOME does not become
 * an accidental global override.
 */
export function getProjectWorkspace(cwd: string, stopDir: string = homedir()): string | null {
  let dir = cwd;
  while (true) {
    if (dir === stopDir) break;
    const candidate = join(dir, ".honcho.json");
    if (existsSync(candidate)) {
      try {
        const raw = JSON.parse(readFileSync(candidate, "utf-8")) as { workspace?: unknown };
        if (typeof raw.workspace === "string" && raw.workspace.length > 0) {
          return raw.workspace;
        }
      } catch {
        // malformed/unreadable -> treat as no override
      }
      return null; // a present-but-unusable file stops the walk (don't leak a parent's)
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/honcho && bun test src/project-config.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add plugins/honcho/src/project-config.ts plugins/honcho/src/project-config.test.ts
git commit -m "feat(honcho): add getProjectWorkspace walk-up discovery for .honcho.json"
```

---

### Task 2: Thread project workspace into `resolveConfig` + `loadConfig`

**Files:**
- Modify: `plugins/honcho/src/config.ts` (`resolveConfig` ~lines 294-331; `loadConfig` ~line 279)
- Test: `plugins/honcho/src/config.test.ts` (create)

**Interfaces:**
- Consumes: `getProjectWorkspace(cwd, stopDir?)` from Task 1; existing `getLastActiveCwd()` from `./cache.js`.
- Produces: `loadConfig(host?: HonchoHost, cwd?: string)` — `cwd` defaults to `getLastActiveCwd() ?? process.cwd()`. `resolveConfig(raw, host, cwd)` now consults the project workspace.

- [ ] **Step 1: Write the failing tests**

```typescript
// plugins/honcho/src/config.test.ts
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";

const envBackup = process.env.HONCHO_WORKSPACE;
afterEach(() => {
  if (envBackup === undefined) delete process.env.HONCHO_WORKSPACE;
  else process.env.HONCHO_WORKSPACE = envBackup;
});

function repoWith(workspace: string): string {
  const dir = mkdtempSync(join(tmpdir(), "honcho-cfg-"));
  writeFileSync(join(dir, ".honcho.json"), JSON.stringify({ workspace }));
  return dir;
}

test(".honcho.json workspace overrides the global default", () => {
  delete process.env.HONCHO_WORKSPACE;
  const dir = repoWith("highway");
  const cfg = loadConfig("claude_code", dir);
  expect(cfg?.workspace).toBe("highway");
  rmSync(dir, { recursive: true, force: true });
});

test("HONCHO_WORKSPACE env beats the .honcho.json project value", () => {
  process.env.HONCHO_WORKSPACE = "envwins";
  const dir = repoWith("highway");
  const cfg = loadConfig("claude_code", dir);
  expect(cfg?.workspace).toBe("envwins");
  rmSync(dir, { recursive: true, force: true });
});

test("no .honcho.json leaves the global default unchanged", () => {
  delete process.env.HONCHO_WORKSPACE;
  const dir = mkdtempSync(join(tmpdir(), "honcho-cfg-"));
  const withFile = loadConfig("claude_code", repoWith("highway"));
  const without = loadConfig("claude_code", dir);
  // The dir without a file must NOT resolve to highway (it gets the global default).
  expect(without?.workspace).not.toBe("highway");
  expect(withFile?.workspace).toBe("highway");
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd plugins/honcho && bun test src/config.test.ts`
Expected: FAIL — `cfg?.workspace` is the global default (not `highway`) because `resolveConfig` does not yet consult `.honcho.json`.

- [ ] **Step 3: Implement the threading**

In `plugins/honcho/src/config.ts`, add to the imports from `./cache.js` (existing line ~5) the `getLastActiveCwd` symbol, and import the project helper:

```typescript
import { getInstanceIdForCwd, getClaudeInstanceId, getLastActiveCwd } from "./cache.js";
import { getProjectWorkspace } from "./project-config.js";
```

Change `loadConfig` (line ~279) to accept and forward `cwd`:

```typescript
export function loadConfig(host?: HonchoHost, cwd?: string): HonchoCLAUDEConfig | null {
  const resolvedHost = host ?? getDetectedHost();
  const resolvedCwd = cwd ?? getLastActiveCwd() ?? process.cwd();

  if (configExists()) {
    try {
      const content = readFileSync(CONFIG_FILE, "utf-8");
      const raw = JSON.parse(content) as HonchoFileConfig;
      return resolveConfig(raw, resolvedHost, resolvedCwd);
    } catch {
      // Fall through to env-only config
    }
  }
  return loadConfigFromEnv(resolvedHost);
}
```

Change `resolveConfig` signature and the three workspace assignments (lines ~294-331) to consult the project workspace between env and the existing default:

```typescript
function resolveConfig(raw: HonchoFileConfig, host: HonchoHost, cwd: string): HonchoCLAUDEConfig | null {
  const hostBlock = raw.hosts?.[host]
    ?? raw.hosts?.[host.replace(/_/g, "-")]
    ?? raw.hosts?.[host.replace(/-/g, "_")];

  const apiKey = process.env.HONCHO_API_KEY || hostBlock?.apiKey || raw.apiKey;
  if (!apiKey) return null;

  const peerName = raw.peerName || process.env.HONCHO_PEER_NAME || process.env.USER || process.env.USERNAME || "user";

  // Project-level workspace (.honcho.json) sits between the env override and the
  // global default, in every branch. See docs/superpowers/specs/2026-06-30-*.
  const projectWorkspace = getProjectWorkspace(cwd);

  let workspace: string;
  let aiPeer: string;

  if (raw.globalOverride === true) {
    workspace = process.env.HONCHO_WORKSPACE ?? projectWorkspace ?? raw.workspace ?? DEFAULT_WORKSPACE[host];
    aiPeer = raw.aiPeer ?? hostBlock?.aiPeer ?? DEFAULT_AI_PEER[host];
  } else if (hostBlock) {
    workspace = process.env.HONCHO_WORKSPACE ?? projectWorkspace ?? hostBlock.workspace ?? DEFAULT_WORKSPACE[host];
    aiPeer = hostBlock.aiPeer ?? DEFAULT_AI_PEER[host];
  } else {
    workspace = process.env.HONCHO_WORKSPACE ?? projectWorkspace ?? raw.workspace ?? DEFAULT_WORKSPACE[host];
    if (host === "cursor") {
      aiPeer = raw.cursorPeer ?? DEFAULT_AI_PEER["cursor"];
    } else {
      aiPeer = raw.claudePeer ?? DEFAULT_AI_PEER["claude_code"];
    }
  }
  // ... rest of resolveConfig unchanged (config object build + mergeWithEnvVars) ...
```

(Leave the remainder of `resolveConfig` — the `config` object literal and `return mergeWithEnvVars(config)` — exactly as is.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd plugins/honcho && bun test src/config.test.ts`
Expected: PASS (3 tests). Also run `bun test` (whole dir) — Task 1 tests still pass.

- [ ] **Step 5: Commit**

```bash
git add plugins/honcho/src/config.ts plugins/honcho/src/config.test.ts
git commit -m "feat(honcho): resolve workspace from .honcho.json (env > project > global)"
```

---

### Task 3: `get_config` workspace provenance

**Files:**
- Modify: `plugins/honcho/src/config.ts` (export a provenance helper)
- Modify: `plugins/honcho/src/mcp/server.ts` (`handleGetConfig`, ~line 85)
- Test: `plugins/honcho/src/config.test.ts` (extend)

**Interfaces:**
- Produces: `getWorkspaceProvenance(cwd: string): { workspace: string; source: "env" | "project" | "global"; path?: string }` in `config.ts`. `handleGetConfig` includes this in its JSON output.

- [ ] **Step 1: Write the failing test**

```typescript
// append to plugins/honcho/src/config.test.ts
import { getWorkspaceProvenance } from "./config.js";

test("provenance reports 'project' with the file's directory", () => {
  delete process.env.HONCHO_WORKSPACE;
  const dir = repoWith("highway");
  const p = getWorkspaceProvenance(dir);
  expect(p.source).toBe("project");
  expect(p.workspace).toBe("highway");
  expect(p.path).toBe(dir);
  rmSync(dir, { recursive: true, force: true });
});

test("provenance reports 'env' when HONCHO_WORKSPACE is set", () => {
  process.env.HONCHO_WORKSPACE = "envwins";
  const dir = repoWith("highway");
  expect(getWorkspaceProvenance(dir).source).toBe("env");
  rmSync(dir, { recursive: true, force: true });
});

test("provenance reports 'global' with no env and no file", () => {
  delete process.env.HONCHO_WORKSPACE;
  const dir = mkdtempSync(join(tmpdir(), "honcho-cfg-"));
  expect(getWorkspaceProvenance(dir).source).toBe("global");
  rmSync(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/honcho && bun test src/config.test.ts`
Expected: FAIL — `getWorkspaceProvenance` not exported.

- [ ] **Step 3: Implement `getWorkspaceProvenance` and wire `handleGetConfig`**

Add to `config.ts` (uses the same walk-up; reports which layer won). Note it returns the directory that held the file via a second helper or by re-walking; implement a small variant that returns both:

```typescript
// config.ts
import { dirname, join } from "node:path"; // if not already imported
import { existsSync } from "node:fs";       // if not already imported
import { homedir } from "node:os";          // if not already imported

export function getWorkspaceProvenance(cwd: string): { workspace: string; source: "env" | "project" | "global"; path?: string } {
  const cfg = loadConfig("claude_code", cwd);
  const workspace = cfg?.workspace ?? "";
  if (process.env.HONCHO_WORKSPACE) {
    return { workspace, source: "env" };
  }
  // find the directory of the nearest usable .honcho.json (mirror getProjectWorkspace walk)
  let dir = cwd;
  const stop = homedir();
  while (dir !== stop) {
    if (existsSync(join(dir, ".honcho.json")) && getProjectWorkspace(dir)) {
      return { workspace, source: "project", path: dir };
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { workspace, source: "global" };
}
```

In `mcp/server.ts` `handleGetConfig(cwd)` (line ~85), call `loadConfig("claude_code", cwd)` (pass cwd) and add the provenance to the response object:

```typescript
function handleGetConfig(cwd: string) {
  const cfg = loadConfig("claude_code", cwd);
  // ... existing body, but add to the JSON payload:
  //   workspaceSource: getWorkspaceProvenance(cwd),
}
```

(Import `getWorkspaceProvenance` and ensure `loadConfig` is called with `cwd`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/honcho && bun test src/config.test.ts`
Expected: PASS. Run full `bun test` — all green.

- [ ] **Step 5: Commit**

```bash
git add plugins/honcho/src/config.ts plugins/honcho/src/config.test.ts plugins/honcho/src/mcp/server.ts
git commit -m "feat(honcho): get_config reports workspace provenance (env/project/global)"
```

---

### Task 4: `set_config` warns instead of silent no-op under `globalOverride`

**Files:**
- Modify: `plugins/honcho/src/mcp/server.ts` (`handleSetConfig`, ~lines 237-313)
- Test: `plugins/honcho/src/server-setconfig.test.ts` (create — exercises the warning helper)

**Interfaces:**
- Produces: a pure helper `setConfigWorkspaceWarning(field: string, raw: HonchoFileConfig): string | null` returning a warning string when `field === "workspace"` and `raw.globalOverride === true` (the write to `hosts.<host>` will be shadowed), else `null`. `handleSetConfig` includes it in `warnings`.

- [ ] **Step 1: Write the failing test**

```typescript
// plugins/honcho/src/server-setconfig.test.ts
import { test, expect } from "bun:test";
import { setConfigWorkspaceWarning } from "./mcp/server.js";

test("warns when setting workspace under globalOverride", () => {
  const w = setConfigWorkspaceWarning("workspace", { globalOverride: true } as any);
  expect(w).toContain(".honcho.json");
});

test("no warning for workspace when globalOverride is not set", () => {
  expect(setConfigWorkspaceWarning("workspace", {} as any)).toBeNull();
});

test("no warning for unrelated fields", () => {
  expect(setConfigWorkspaceWarning("logging", { globalOverride: true } as any)).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd plugins/honcho && bun test src/server-setconfig.test.ts`
Expected: FAIL — `setConfigWorkspaceWarning` not exported.

- [ ] **Step 3: Implement the helper and wire it**

In `mcp/server.ts`, export:

```typescript
export function setConfigWorkspaceWarning(field: string, raw: HonchoFileConfig): string | null {
  if (field === "workspace" && raw.globalOverride === true) {
    return "globalOverride is on, so this change writes to the per-host block but resolution reads the global default — it will NOT take effect. For a per-repo workspace, create a .honcho.json ({\"workspace\":\"...\"}) in the repo instead. To change the global default for ALL repos, edit ~/.honcho/config.json directly.";
  }
  return null;
}
```

In `handleSetConfig`, read the raw config file once (it already loads config), and when `field === "workspace"`, push `setConfigWorkspaceWarning(field, raw)` (if non-null) into the existing `warnings` array before building the response. Do NOT change where the value is written.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd plugins/honcho && bun test src/server-setconfig.test.ts`
Expected: PASS (3 tests). Full `bun test` green.

- [ ] **Step 5: Commit**

```bash
git add plugins/honcho/src/mcp/server.ts plugins/honcho/src/server-setconfig.test.ts
git commit -m "fix(honcho): set_config warns when workspace write is shadowed by globalOverride"
```

---

### Task 5: Global gitignore, CLAUDE.md correction, version bump (chore)

**Files:**
- Modify: global gitignore (`git config --global core.excludesfile`; create `~/.config/git/ignore` if unset)
- Modify: `/Users/robsherman/.claude/CLAUDE.md` (the Honcho Memory section note)
- Modify: `plugins/honcho/.claude-plugin/plugin.json` (version bump)

**Interfaces:** none (configuration + docs).

- [ ] **Step 1: Ensure `.honcho.json` is globally gitignored**

```bash
EXCLUDES="$(git config --global core.excludesfile)"
if [ -z "$EXCLUDES" ]; then EXCLUDES="$HOME/.config/git/ignore"; mkdir -p "$(dirname "$EXCLUDES")"; git config --global core.excludesfile "$EXCLUDES"; fi
grep -qxF ".honcho.json" "$EXCLUDES" 2>/dev/null || echo ".honcho.json" >> "$EXCLUDES"
echo "global gitignore: $EXCLUDES"; grep -n "honcho" "$EXCLUDES"
```
Expected: `.honcho.json` present in the resolved global excludes file.

- [ ] **Step 2: Verify ignore works (no test framework — manual)**

```bash
cd "$(mktemp -d)" && git init -q && echo '{"workspace":"highway"}' > .honcho.json && git status --porcelain
```
Expected: empty output (`.honcho.json` is ignored). Clean up the temp dir.

- [ ] **Step 3: Correct the stale CLAUDE.md note**

In `/Users/robsherman/.claude/CLAUDE.md`, replace the guidance that says the per-host block "disables the `HONCHO_WORKSPACE` override" with the verified behavior: `HONCHO_WORKSPACE` (env) always wins; a repo-level `.honcho.json` (`{"workspace":"highway"}`) overrides the global default; `globalOverride:true` keeps `personal` as the default for all other repos. Note that `.claude/settings.local.json` `env` does NOT reach the plugin (use `.honcho.json` or a shell `export`), and that `.honcho.json` is globally gitignored.

- [ ] **Step 4: Bump plugin version**

In `plugins/honcho/.claude-plugin/plugin.json`, bump `version` `0.2.5` → `0.2.6`. (Also update the hardcoded server version string `0.2.4` in `src/mcp/server.ts` ~line 553 to `0.2.6` for consistency.)

- [ ] **Step 5: Commit**

```bash
git add plugins/honcho/.claude-plugin/plugin.json plugins/honcho/src/mcp/server.ts
git commit -m "chore(honcho): bump to 0.2.6 for project-level workspace override"
```
(The global gitignore and `~/.claude/CLAUDE.md` live outside the repo — note them in the task report; they are not part of the repo commit.)

---

## Post-Implementation

- Run full suite: `cd plugins/honcho && bun test` — all tasks' tests green.
- Type-check if the repo supports it: `cd plugins/honcho && bun run tsc --noEmit` (if `typescript` is available); fix any errors in touched files.
- Reinstall/update the plugin so the running Claude Code picks up `0.2.6` (the marketplace installs `feat/per-directory-workspace`; merge `feat/project-level-workspace` into it or update the marketplace ref — decide at finishing-the-branch time).
- Manual acceptance: drop `.honcho.json {"workspace":"highway"}` in a `highway-*` repo, restart the session, call `get_config`, confirm `workspace: highway (source: project ...)`; confirm a personal repo still shows `personal`.
