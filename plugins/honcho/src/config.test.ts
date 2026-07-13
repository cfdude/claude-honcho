// plugins/honcho/src/config.test.ts
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, loadConfigFromEnv, getWorkspaceProvenance, getHonchoClientOptions } from "./config.js";

const envBackup = process.env.HONCHO_WORKSPACE;
const keyBackup = process.env.HONCHO_API_KEY;
afterEach(() => {
  if (envBackup === undefined) delete process.env.HONCHO_WORKSPACE; else process.env.HONCHO_WORKSPACE = envBackup;
  if (keyBackup === undefined) delete process.env.HONCHO_API_KEY; else process.env.HONCHO_API_KEY = keyBackup;
});

function repoWith(workspace: string): string {
  const dir = mkdtempSync(join(tmpdir(), "honcho-cfg-"));
  writeFileSync(join(dir, ".honcho.json"), JSON.stringify({ workspace }));
  return dir;
}
function emptyDir(): string { return mkdtempSync(join(tmpdir(), "honcho-cfg-")); }
const BASE = { apiKey: "k", peerName: "p" };

test("globalOverride branch: .honcho.json overrides root; env beats it; absent falls back", () => {
  const withFile = repoWith("highway");
  const without = emptyDir();
  const raw = { ...BASE, globalOverride: true, workspace: "personal" } as any;
  delete process.env.HONCHO_WORKSPACE;
  expect(resolveConfig(raw, "claude_code", withFile)?.workspace).toBe("highway");
  expect(resolveConfig(raw, "claude_code", without)?.workspace).toBe("personal");
  process.env.HONCHO_WORKSPACE = "envwins";
  expect(resolveConfig(raw, "claude_code", withFile)?.workspace).toBe("envwins");
  rmSync(withFile, { recursive: true, force: true });
  rmSync(without, { recursive: true, force: true });
});

test("hostBlock branch: .honcho.json overrides host default; absent falls back", () => {
  delete process.env.HONCHO_WORKSPACE;
  const raw = { ...BASE, hosts: { claude_code: { workspace: "hostdefault" } } } as any;
  const withFile = repoWith("highway");
  const without = emptyDir();
  expect(resolveConfig(raw, "claude_code", withFile)?.workspace).toBe("highway");
  expect(resolveConfig(raw, "claude_code", without)?.workspace).toBe("hostdefault");
  rmSync(withFile, { recursive: true, force: true });
  rmSync(without, { recursive: true, force: true });
});

test("legacy flat branch: .honcho.json overrides flat workspace; absent falls back", () => {
  delete process.env.HONCHO_WORKSPACE;
  const raw = { ...BASE, workspace: "legacy" } as any;
  const withFile = repoWith("highway");
  const without = emptyDir();
  expect(resolveConfig(raw, "claude_code", withFile)?.workspace).toBe("highway");
  expect(resolveConfig(raw, "claude_code", without)?.workspace).toBe("legacy");
  rmSync(withFile, { recursive: true, force: true });
  rmSync(without, { recursive: true, force: true });
});

test("env-only path (no config file): loadConfigFromEnv honors .honcho.json", () => {
  delete process.env.HONCHO_WORKSPACE;
  process.env.HONCHO_API_KEY = "k"; // loadConfigFromEnv returns null without an apiKey
  const dir = repoWith("highway");
  expect(loadConfigFromEnv("claude_code", dir)?.workspace).toBe("highway");
  rmSync(dir, { recursive: true, force: true });
});

test("provenance reports 'project' with the file's directory", () => {
  delete process.env.HONCHO_WORKSPACE;
  const dir = repoWith("highway");
  const p = getWorkspaceProvenance(dir);
  // Assert source and path only — workspace derives from loadConfig which reads
  // the real ~/.honcho/config.json and is not controllable in a hermetic test.
  expect(p.source).toBe("project");
  expect(p.path).toBe(dir);
  rmSync(dir, { recursive: true, force: true });
});

test("provenance reports 'env' when HONCHO_WORKSPACE is set", () => {
  process.env.HONCHO_WORKSPACE = "envwins";
  const dir = repoWith("highway");
  const p = getWorkspaceProvenance(dir);
  expect(p.source).toBe("env");
  rmSync(dir, { recursive: true, force: true });
});

test("provenance reports 'global' with no env and no file", () => {
  delete process.env.HONCHO_WORKSPACE;
  const dir = mkdtempSync(join(tmpdir(), "honcho-cfg-"));
  const p = getWorkspaceProvenance(dir);
  expect(p.source).toBe("global");
  rmSync(dir, { recursive: true, force: true });
});

// --- Cloudflare Access service-token headers (honcho-cloudflare-tunnel-access) ---

test("getHonchoClientOptions emits CF-Access headers only when BOTH access creds are present", () => {
  const base = { peerName: "p", apiKey: "k", workspace: "personal", aiPeer: "claude" } as any;
  // neither present -> no defaultHeaders (unchanged behavior)
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

test("resolveConfig carries access creds from config.json root", () => {
  const dir = emptyDir();
  const raw = { ...BASE, workspace: "personal", accessClientId: "cid.access", accessClientSecret: "csecret" } as any;
  const cfg = resolveConfig(raw, "claude_code", dir);
  expect(cfg?.accessClientId).toBe("cid.access");
  expect(cfg?.accessClientSecret).toBe("csecret");
});
