import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Proves appendClaudeWork() survives concurrent writers.
 *
 * This MUST use real subprocesses. An in-process `Promise.all` over synchronous
 * fs calls cannot interleave — Bun would run each append to completion before
 * starting the next — so it would pass even against the original unsynchronized
 * read-modify-write. Separate OS processes are the only way to exercise the race.
 *
 * HOME is redirected to a throwaway dir (src/home.ts resolves
 * `process.env.HOME || homedir()` precisely so this works on Bun) — the real
 * ~/.honcho/config.json carries live credentials and is never touched.
 */

const CACHE_MODULE = resolve(import.meta.dir, "cache.ts");
const WRITERS = 20;

// Async-aware on purpose: a synchronous `finally { rmSync(...) }` around an
// async fn deletes the fake home while the spawned writers are still running,
// which silently drops the seeded config (and makes the trim path untestable).
async function withFakeHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const fakeHome = mkdtempSync(join(tmpdir(), "honcho-concurrency-"));
  mkdirSync(join(fakeHome, ".honcho"), { recursive: true });
  // No localContext.maxEntries → the 50 default, comfortably above WRITERS, so
  // this test isolates the append path from the trim path.
  writeFileSync(
    join(fakeHome, ".honcho", "config.json"),
    JSON.stringify({ apiKey: "k", peerName: "p" }),
  );
  try {
    return await fn(fakeHome);
  } finally {
    rmSync(fakeHome, { recursive: true, force: true });
  }
}

async function spawnAppenders(fakeHome: string, count: number, prefix = "entry"): Promise<void> {
  const procs = Array.from({ length: count }, (_, i) =>
    Bun.spawn({
      cmd: [
        process.execPath,
        "-e",
        `const { appendClaudeWork } = await import(${JSON.stringify(CACHE_MODULE)}); appendClaudeWork(${JSON.stringify(prefix)} + "-" + ${i});`,
      ],
      env: { ...process.env, HOME: fakeHome },
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const codes = await Promise.all(procs.map((p) => p.exited));
  const failures: string[] = [];
  for (let i = 0; i < procs.length; i++) {
    if (codes[i] !== 0) {
      failures.push(`writer ${i} exited ${codes[i]}: ${await new Response(procs[i].stderr).text()}`);
    }
  }
  expect(failures).toEqual([]);
}

test("concurrent appendClaudeWork() writers neither corrupt the file nor lose entries", async () => {
  await withFakeHome(async (fakeHome) => {
    await spawnAppenders(fakeHome, WRITERS);

    const contextFile = join(fakeHome, ".honcho", "claude-context.md");
    const content = readFileSync(contextFile, "utf-8");

    // Header survived exactly once — no writer clobbered another's header.
    expect(content.split("# CLAUDE Work Context").length - 1).toBe(1);
    expect(content).toContain("## Recent Activity");

    const entryLines = content.split("\n").filter((l) => l.startsWith("- ["));

    // Every line is a well-formed single entry. Two timestamps on one line is
    // the signature of an interleaved write.
    for (const line of entryLines) {
      expect(line).toMatch(/^- \[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] entry-\d+$/);
      expect(line.match(/\[\d{4}-\d{2}-\d{2}T/g)?.length).toBe(1);
    }

    // No lost updates: O_APPEND means all 20 land, each exactly once.
    expect(entryLines).toHaveLength(WRITERS);
    const seen = new Set(entryLines.map((l) => l.replace(/^- \[[^\]]+\]\s*/, "")));
    expect(seen.size).toBe(WRITERS);

    // No temp files left behind by the atomic-write path.
    expect(readdirSync(join(fakeHome, ".honcho")).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
});

test("a zero-byte or header-less claude-context.md is re-headered, so trimming keeps working", async () => {
  await withFakeHome(async (fakeHome) => {
    const contextFile = join(fakeHome, ".honcho", "claude-context.md");

    // A zero-byte file is exactly what the OLD truncate-then-write left behind
    // when a hook was killed mid-write. Without re-headering, the trim can never
    // find "## Recent Activity" and the file grows forever.
    writeFileSync(contextFile, "");
    await spawnAppenders(fakeHome, 1, "afterEmpty");

    const content = readFileSync(contextFile, "utf-8");
    expect(content).toContain("# CLAUDE Work Context");
    expect(content).toContain("## Recent Activity");
    const entryLines = content.split("\n").filter((l) => l.startsWith("- ["));
    expect(entryLines).toHaveLength(1);
    expect(entryLines[0]).toContain("afterEmpty-0");
  });
});

test("trimming under concurrency keeps the file well-formed and bounded", async () => {
  await withFakeHome(async (fakeHome) => {
    // maxEntries: 5 forces the trim rewrite path on nearly every append.
    writeFileSync(
      join(fakeHome, ".honcho", "config.json"),
      JSON.stringify({ apiKey: "k", peerName: "p", localContext: { maxEntries: 5 } }),
    );

    await spawnAppenders(fakeHome, WRITERS, "trimmed");

    const contextFile = join(fakeHome, ".honcho", "claude-context.md");
    const burst = readFileSync(contextFile, "utf-8");
    expect(burst.split("# CLAUDE Work Context").length - 1).toBe(1);

    const burstLines = burst.split("\n").filter((l) => l.startsWith("- ["));
    for (const line of burstLines) {
      expect(line).toMatch(/^- \[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] trimmed-\d+$/);
    }
    // With maxEntries=5 the design keeps only the newest 5 regardless of how
    // many writers ran, so the bound — not the writer count — is what's
    // assertable here: the file is trimmed, never torn, never emptied, and
    // never left holding a half-written line. If the retry-on-change loop
    // yields to a racing append it may briefly sit above the cap, hence <=.
    expect(burstLines.length).toBeGreaterThan(0);
    expect(burstLines.length).toBeLessThanOrEqual(WRITERS);
    expect(readdirSync(join(fakeHome, ".honcho")).filter((f) => f.includes(".tmp-"))).toEqual([]);

    // A subsequent quiet append lands, and the bound holds exactly.
    await spawnAppenders(fakeHome, 1, "quiet");
    const healed = readFileSync(contextFile, "utf-8");
    expect(healed.split("# CLAUDE Work Context").length - 1).toBe(1);
    const healedLines = healed.split("\n").filter((l) => l.startsWith("- ["));
    expect(healedLines).toHaveLength(5);
    expect(healedLines[healedLines.length - 1]).toContain("quiet-0");
    expect(readdirSync(join(fakeHome, ".honcho")).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });
});
