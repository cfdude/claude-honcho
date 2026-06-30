// plugins/honcho/src/config.test.ts
import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig, loadConfigFromEnv, getWorkspaceProvenance } from "./config.js";

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
