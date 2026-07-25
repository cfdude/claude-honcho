import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
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
