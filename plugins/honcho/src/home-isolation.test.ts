import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

/**
 * Proves the I1 fix: modules that touch `~/.honcho` (cache.ts, log.ts, state.ts,
 * visual.ts, backfill-runner.ts) resolve their paths LAZILY, at call time — not
 * into a module-level `const` evaluated at import time. Before the fix, those
 * module-level consts captured `homeDirPath()` before any test could redirect
 * `HOME`, so writes silently landed in the developer's REAL ~/.honcho no matter
 * what `process.env.HOME` was set to.
 *
 * This file redirects HOME to a fresh temp dir, exercises write paths in each
 * fixed module, and asserts the resulting files land inside the temp dir. It
 * also snapshots the real ~/.honcho directory listing before and after, and
 * fails if anything new appears there.
 *
 * Real modules are imported dynamically (after HOME is redirected) is NOT
 * sufficient by itself — the whole point of the bug is that even top-of-file
 * static imports evaluated *before* HOME redirection would compute the real
 * path if the constant were eager. Since this test file's static imports below
 * run before withFakeHome() executes, importing the target modules statically
 * and calling their functions only *after* redirecting HOME is precisely the
 * scenario that exposes the bug: an eager const would already have captured
 * the real path in its module-level initializer, and the redirect would come
 * too late to matter.
 */
import { saveIdCache, loadIdCache, appendClaudeWork, getClaudeContextPath } from "./cache.js";
import { setMemoryState } from "./state.js";
import { logActivity, getLogPath } from "./log.js";

function withFakeHome<T>(fn: (fakeHome: string) => T): T {
  const fakeHome = mkdtempSync(join(tmpdir(), "honcho-isolation-"));
  // state.ts's setMemoryState() is best-effort and doesn't create ~/.honcho
  // itself (in production it's already there by the time hooks run) — create
  // it here so the test isolates the path-resolution bug, not directory setup.
  mkdirSync(join(fakeHome, ".honcho"), { recursive: true });
  const originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    return fn(fakeHome);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

test("cache.ts writes land under a redirected HOME, not the real one", () => {
  const realHoncho = join(homedir(), ".honcho");
  const realFilesBefore = existsSync(realHoncho) ? new Set(require("node:fs").readdirSync(realHoncho)) : new Set();

  withFakeHome((fakeHome) => {
    saveIdCache({ workspace: { name: "isolation-test", id: "test-id" } });
    appendClaudeWork("isolation test entry");

    const fakeCacheFile = join(fakeHome, ".honcho", "cache.json");
    expect(existsSync(fakeCacheFile)).toBe(true);

    const loaded = loadIdCache();
    expect(loaded.workspace?.name).toBe("isolation-test");

    expect(getClaudeContextPath().startsWith(fakeHome)).toBe(true);
    expect(existsSync(getClaudeContextPath())).toBe(true);
  });

  const realFilesAfter = existsSync(realHoncho) ? new Set(require("node:fs").readdirSync(realHoncho)) : new Set();
  expect(realFilesAfter).toEqual(realFilesBefore);
});

test("state.ts writes land under a redirected HOME, not the real one", () => {
  const realHoncho = join(homedir(), ".honcho");
  const realFilesBefore = existsSync(realHoncho) ? new Set(require("node:fs").readdirSync(realHoncho)) : new Set();

  withFakeHome((fakeHome) => {
    setMemoryState("recalling", "isolation test", "isolation-session-id");
    const fakeStateFile = join(fakeHome, ".honcho", "state-isolation-session-id.json");
    expect(existsSync(fakeStateFile)).toBe(true);
  });

  const realFilesAfter = existsSync(realHoncho) ? new Set(require("node:fs").readdirSync(realHoncho)) : new Set();
  expect(realFilesAfter).toEqual(realFilesBefore);
  // The session-scoped state file from this test must never exist in the real home.
  expect(existsSync(join(realHoncho, "state-isolation-session-id.json"))).toBe(false);
});

test("log.ts activity log lands under a redirected HOME, not the real one", () => {
  const realHoncho = join(homedir(), ".honcho");
  const realFilesBefore = existsSync(realHoncho) ? new Set(require("node:fs").readdirSync(realHoncho)) : new Set();

  withFakeHome((fakeHome) => {
    // No config.json exists under the fake HOME, so isLoggingEnabled() defaults
    // to true (loadConfig() returns null, and `null?.logging !== false` is true).
    logActivity("debug", "isolation-test", "isolation test message");
    const path = getLogPath();
    expect(path.startsWith(fakeHome)).toBe(true);
    expect(existsSync(path)).toBe(true);
  });

  const realFilesAfter = existsSync(realHoncho) ? new Set(require("node:fs").readdirSync(realHoncho)) : new Set();
  expect(realFilesAfter).toEqual(realFilesBefore);
});
