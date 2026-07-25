import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHonchoClientOptions, resolveConfig } from "./config.js";

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
