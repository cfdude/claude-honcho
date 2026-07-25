import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHonchoClientOptions, resolveConfig, loadConfig, saveConfig, getWorkspaceProvenance } from "./config.js";

/** A temp dir OUTSIDE $HOME so the .honcho.json walk-up terminates cleanly. */
export function emptyDir(): string {
  return mkdtempSync(join(tmpdir(), "honcho-test-"));
}

export const BASE = { apiKey: "k", peerName: "p" } as const;

test("getHonchoClientOptions emits CF-Access headers only when BOTH access creds are present", () => {
  const base = { peerName: "p", apiKey: "k", workspace: "personal", aiPeer: "claude" } as any;
  // neither present -> no defaultHeaders (unchanged upstream behavior)
  expect(getHonchoClientOptions(base).defaultHeaders).toBeUndefined();
  // both present -> both headers
  const opts = getHonchoClientOptions({ ...base, accessClientId: "cid.access", accessClientSecret: "csecret" });
  expect(opts.defaultHeaders).toEqual({
    "CF-Access-Client-Id": "cid.access",
    "CF-Access-Client-Secret": "csecret",
  });
  // only one present -> no headers (both required)
  expect(getHonchoClientOptions({ ...base, accessClientId: "cid.access" }).defaultHeaders).toBeUndefined();
  expect(getHonchoClientOptions({ ...base, accessClientSecret: "csecret" }).defaultHeaders).toBeUndefined();
});

test("getHonchoClientOptions preserves upstream fields", () => {
  const base = { peerName: "p", apiKey: "k", workspace: "personal", aiPeer: "claude" } as any;
  const opts = getHonchoClientOptions(base);
  expect(opts.apiKey).toBe("k");
  expect(opts.workspaceId).toBe("personal");
  expect(opts.timeout).toBe(120000);
  expect(opts.maxRetries).toBe(1);
});

test("resolveConfig carries access creds from config.json root", () => {
  const raw = { ...BASE, workspace: "personal", accessClientId: "cid.access", accessClientSecret: "csecret" } as any;
  const cfg = resolveConfig(raw, "claude_code");
  expect(cfg?.accessClientId).toBe("cid.access");
  expect(cfg?.accessClientSecret).toBe("csecret");
});

test("HONCHO_WORKSPACE wins even when globalOverride is true (regression guard)", () => {
  const dir = emptyDir();
  process.env.HONCHO_WORKSPACE = "highway";
  try {
    // Mirrors the real ~/.honcho/config.json shape: globalOverride AND a hosts block.
    const raw = {
      ...BASE,
      workspace: "personal",
      globalOverride: true,
      hosts: { claude_code: { workspace: "personal" } },
    } as any;
    const cfg = resolveConfig(raw, "claude_code", dir);
    expect(cfg?.workspace).toBe("highway");
  } finally {
    delete process.env.HONCHO_WORKSPACE;
  }
});

test("HONCHO_WORKSPACE wins when a host block exists without globalOverride", () => {
  const dir = emptyDir();
  process.env.HONCHO_WORKSPACE = "highway";
  try {
    const raw = { ...BASE, hosts: { claude_code: { workspace: "personal" } } } as any;
    const cfg = resolveConfig(raw, "claude_code", dir);
    expect(cfg?.workspace).toBe("highway");
  } finally {
    delete process.env.HONCHO_WORKSPACE;
  }
});

test("project .honcho.json beats the global workspace when no env var is set", () => {
  const dir = emptyDir();
  writeFileSync(join(dir, ".honcho.json"), JSON.stringify({ workspace: "highway" }));
  const raw = { ...BASE, workspace: "personal", globalOverride: true } as any;
  const cfg = resolveConfig(raw, "claude_code", dir);
  expect(cfg?.workspace).toBe("highway");
});

test("env beats project when both are present", () => {
  const dir = emptyDir();
  writeFileSync(join(dir, ".honcho.json"), JSON.stringify({ workspace: "project-ws" }));
  process.env.HONCHO_WORKSPACE = "env-ws";
  try {
    const raw = { ...BASE, workspace: "personal" } as any;
    expect(resolveConfig(raw, "claude_code", dir)?.workspace).toBe("env-ws");
  } finally {
    delete process.env.HONCHO_WORKSPACE;
  }
});

test("falls back to the global workspace when neither env nor project is present", () => {
  const dir = emptyDir();
  const raw = { ...BASE, workspace: "personal", globalOverride: true } as any;
  expect(resolveConfig(raw, "claude_code", dir)?.workspace).toBe("personal");
});

test("host-block workspace still applies when no env/project override", () => {
  const dir = emptyDir();
  const raw = { ...BASE, hosts: { claude_code: { workspace: "hostblock-ws" } } } as any;
  expect(resolveConfig(raw, "claude_code", dir)?.workspace).toBe("hostblock-ws");
});

// --- Fix-review follow-up tests (loadConfig fallback + saveConfig persistence guard) ---
//
// These two tests exercise loadConfig()/saveConfig() against a REAL (but temporary and
// isolated) ~/.honcho/config.json path: config.ts resolves that path fresh on every call
// (not cached at module-load) via its homeDirPath() helper, which reads process.env.HOME
// first. That helper matters -- Bun's os.homedir() IGNORES $HOME and reads the passwd
// entry, so without it these tests would silently read and WRITE the developer's real
// ~/.honcho/config.json while appearing isolated. HOME is always restored in `finally`.

test("loadConfig forwards cwd to loadConfigFromEnv when no config file exists (Finding 1 regression guard)", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "honcho-home-"));
  const projectDir = mkdtempSync(join(tmpdir(), "honcho-project-"));
  writeFileSync(join(projectDir, ".honcho.json"), JSON.stringify({ workspace: "project-ws" }));

  const originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  process.env.HONCHO_API_KEY = "test-key";
  delete process.env.HONCHO_WORKSPACE;
  try {
    // No ~/.honcho/config.json exists under fakeHome, so loadConfig() must fall through to
    // loadConfigFromEnv() -- and it must forward `cwd` so the project override still applies.
    const cfg = loadConfig("claude_code", projectDir);
    expect(cfg?.workspace).toBe("project-ws");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    delete process.env.HONCHO_API_KEY;
  }
});

test("saveConfig does not persist an env-only HONCHO_WORKSPACE override to disk (Finding 2 regression guard)", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "honcho-home-"));
  const honchoDir = join(fakeHome, ".honcho");
  mkdirSync(honchoDir, { recursive: true });
  const configPath = join(honchoDir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({ apiKey: "k", peerName: "p", hosts: { claude_code: { workspace: "original-ws" } } })
  );

  const originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  process.env.HONCHO_WORKSPACE = "env-ws";
  try {
    // Simulates the resolved config a loadConfig() call would hand back while
    // HONCHO_WORKSPACE is set -- config.workspace reflects the per-invocation env override.
    saveConfig({ apiKey: "k", peerName: "p", workspace: "env-ws", aiPeer: "claude" } as any);

    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.hosts.claude_code.workspace).toBe("original-ws");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    delete process.env.HONCHO_WORKSPACE;
  }
});

test("saveConfig does not persist a project-derived workspace to disk (cross-workspace leak guard)", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "honcho-home-"));
  const honchoDir = join(fakeHome, ".honcho");
  mkdirSync(honchoDir, { recursive: true });
  const configPath = join(honchoDir, "config.json");
  // A DEFAULT install: no globalOverride, host block already carries the user's
  // real (personal) workspace.
  writeFileSync(
    configPath,
    JSON.stringify({ apiKey: "k", peerName: "p", hosts: { claude_code: { workspace: "personal" } } })
  );

  // A repo pinned to the employer workspace via a project .honcho.json.
  const projectDir = mkdtempSync(join(tmpdir(), "honcho-project-"));
  writeFileSync(join(projectDir, ".honcho.json"), JSON.stringify({ workspace: "highway" }));

  const originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  delete process.env.HONCHO_WORKSPACE;
  try {
    // Simulates the resolved config loadConfig(host, projectDir) hands back inside
    // that repo: workspace === "highway", sourced from the project file. Any
    // saveConfig() in that session (session write, MCP set_config) must NOT make
    // it the global host-block default -- otherwise an unrelated repo with no
    // .honcho.json later resolves "highway" and personal work leaks into the
    // employer workspace.
    saveConfig(
      { apiKey: "k", peerName: "p", workspace: "highway", aiPeer: "claude" } as any,
      projectDir
    );

    const written = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(written.hosts.claude_code.workspace).toBe("personal");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

// --- getWorkspaceProvenance ---
//
// getWorkspaceProvenance() calls loadConfig() internally, which reads
// ~/.honcho/config.json when it exists. Isolate HOME to a fresh temp dir (with
// no config.json inside it) for every case below, exactly like the loadConfig/
// saveConfig tests above, so these never touch the developer's real config file.

test("provenance reports 'env' when HONCHO_WORKSPACE is set", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "honcho-home-"));
  const dir = emptyDir();
  const originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  process.env.HONCHO_WORKSPACE = "highway";
  try {
    expect(getWorkspaceProvenance(dir).source).toBe("env");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    delete process.env.HONCHO_WORKSPACE;
  }
});

test("provenance reports 'project' with the owning directory when .honcho.json is found", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "honcho-home-"));
  const dir = emptyDir();
  writeFileSync(join(dir, ".honcho.json"), JSON.stringify({ workspace: "highway" }));
  const originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const prov = getWorkspaceProvenance(dir);
    expect(prov.source).toBe("project");
    expect(prov.path).toBe(dir);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("provenance reports 'global' when neither env nor project is present", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "honcho-home-"));
  const dir = emptyDir();
  const originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const prov = getWorkspaceProvenance(dir);
    expect(prov.source).toBe("global");
    expect(prov.path).toBeUndefined();
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});
