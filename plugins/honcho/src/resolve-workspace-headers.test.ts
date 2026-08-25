import { test, expect, describe } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HELPER = join(import.meta.dir, "..", "scripts", "resolve-workspace-headers.mjs");

/**
 * The headersHelper carries workspace identity for the HTTP MCP transport. stdio
 * gets identity free from one-process-per-session; HTTP is shared, so this
 * script IS the isolation boundary. If it disagrees with project-config.ts, a
 * Highway repo silently writes into the personal workspace.
 */
async function run(cwd: string, env: Record<string, string>) {
  const proc = Bun.spawn(["node", HELPER], {
    cwd,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  expect(code).toBe(0);
  return JSON.parse(out) as Record<string, string>;
}

function sandbox(): string {
  const home = mkdtempSync(join(tmpdir(), "honcho-hdr-"));
  mkdirSync(join(home, ".honcho"), { recursive: true });
  writeFileSync(join(home, ".honcho", "config.json"), JSON.stringify({ workspace: "personal", apiKey: "hch" + "_testkeynotreal000000" }));
  return home;
}

describe("resolve-workspace-headers", () => {
  test("falls back to the global default when no .honcho.json is found", async () => {
    const home = sandbox();
    try {
      const h = await run(home, { HOME: home });
      expect(h["X-Honcho-Workspace-ID"]).toBe("personal");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("HONCHO_WORKSPACE overrides everything", async () => {
    const home = sandbox();
    try {
      writeFileSync(join(home, ".honcho.json"), JSON.stringify({ workspace: "highway" }));
      const h = await run(home, { HOME: home, HONCHO_WORKSPACE: "override-ws" });
      expect(h["X-Honcho-Workspace-ID"]).toBe("override-ws");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("walks up parent directories to find .honcho.json", async () => {
    const home = sandbox();
    try {
      writeFileSync(join(home, ".honcho.json"), JSON.stringify({ workspace: "highway" }));
      const deep = join(home, "repo", "pkg", "src");
      mkdirSync(deep, { recursive: true });
      const h = await run(deep, { HOME: home });
      expect(h["X-Honcho-Workspace-ID"]).toBe("highway");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("a MALFORMED .honcho.json stops the walk and does NOT inherit the parent's workspace", async () => {
    // The isolation-critical case. Climbing past a broken file would silently
    // resolve a Highway repo to whatever a parent directory declared.
    const home = sandbox();
    try {
      writeFileSync(join(home, ".honcho.json"), JSON.stringify({ workspace: "highway" }));
      const mid = join(home, "repo");
      mkdirSync(join(mid, "src"), { recursive: true });
      writeFileSync(join(mid, ".honcho.json"), "NOT JSON");
      const h = await run(join(mid, "src"), { HOME: home });
      expect(h["X-Honcho-Workspace-ID"]).not.toBe("highway");
      expect(h["X-Honcho-Workspace-ID"]).toBe("personal");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("a .honcho.json with no usable workspace also stops the walk", async () => {
    const home = sandbox();
    try {
      writeFileSync(join(home, ".honcho.json"), JSON.stringify({ workspace: "highway" }));
      const mid = join(home, "repo");
      mkdirSync(join(mid, "src"), { recursive: true });
      writeFileSync(join(mid, ".honcho.json"), JSON.stringify({ workspace: "" }));
      const h = await run(join(mid, "src"), { HOME: home });
      expect(h["X-Honcho-Workspace-ID"]).toBe("personal");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("emits the Authorization header from the same config the hooks read", async () => {
    const home = sandbox();
    try {
      const h = await run(home, { HOME: home });
      expect(h.Authorization).toStartWith("Bearer ");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("stdout is pure JSON — anything else corrupts the connection headers", async () => {
    const home = sandbox();
    try {
      const proc = Bun.spawn(["node", HELPER], {
        cwd: home, env: { PATH: process.env.PATH ?? "", HOME: home },
        stdout: "pipe", stderr: "pipe", stdin: "ignore",
      });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      expect(out.trim()).toBe(out); // no stray newline/whitespace
      expect(() => JSON.parse(out)).not.toThrow();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
