import { test, expect } from "bun:test";
import { summarizeEdit } from "./hooks/post-tool-use.js";

/**
 * The token diff was O(n·m) — `Array.includes` inside `filter`, twice. On a real
 * 682 KB Edit payload the hook took 12.6s; a 100k-token edit never finished.
 * Measured before the fix: 11.4s at 20k tokens/side, 40.1s at 40k.
 *
 * These tests pin the two properties that matter: output is unchanged, and a
 * large edit completes in well under a second.
 */

function tokens(n: number, seed: string): string {
  const a: string[] = [];
  for (let i = 0; i < n; i++) a.push(`${seed}tok${i % Math.max(1, (n / 2) | 0)}`);
  return a.join(" ");
}

test("a large edit summarizes fast — no quadratic blowup", () => {
  const oldStr = tokens(20000, "a");
  const newStr = tokens(20000, "b");
  const t0 = performance.now();
  const out = summarizeEdit(oldStr, newStr, "/tmp/big.ts");
  const elapsed = performance.now() - t0;
  expect(typeof out).toBe("string");
  expect(out.length).toBeGreaterThan(0);
  // Pre-fix this took ~11,400ms. 1s is a generous ceiling that still fails
  // loudly if the Set is ever replaced by a linear scan again.
  expect(elapsed).toBeLessThan(1000);
});

test("identifies added and removed identifiers", () => {
  const out = summarizeEdit("alpha beta gamma", "alpha beta delta", "/tmp/x.ts");
  expect(out).toContain("gamma");
  expect(out).toContain("delta");
});

test("tokens of 2 chars or fewer are ignored", () => {
  // "ab" is added but too short to report; "gamma" was removed and is long enough.
  const out = summarizeEdit("alpha gamma", "alpha ab", "/tmp/x.ts");
  expect(out).not.toContain("ab");
  expect(out).toContain("gamma");
});

test("pure addition and pure deletion keep their special-cased summaries", () => {
  expect(summarizeEdit("", "one\ntwo\nthree", "/tmp/x.ts")).toContain("lines");
  expect(summarizeEdit("one\ntwo", "", "/tmp/x.ts")).toContain("removed 2 lines");
});

test("no identifier change falls back to a line-count summary", () => {
  const out = summarizeEdit("alpha beta", "alpha beta", "/tmp/x.ts");
  expect(out).toMatch(/modified|expanded|reduced/);
});
