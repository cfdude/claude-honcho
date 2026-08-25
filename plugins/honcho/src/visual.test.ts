import { test, expect, beforeEach, afterEach } from "bun:test";
import { visInjectionMessage, setOutputLevel, CONCLUSION_PREVIEW_CHARS } from "./visual.js";

const long = "x".repeat(CONCLUSION_PREVIEW_CHARS + 500);

// Per-conclusion bullets only exist at "verbose" now (the default "info" prints
// the header alone). These tests are about how a bullet is BOUNDED, so they
// declare the level that produces bullets. The truncation behavior itself is
// unchanged. The level is module state shared across test files in one bun
// process, so it is reset after each test rather than set once at the top.
beforeEach(() => setOutputLevel("verbose"));
afterEach(() => setOutputLevel("info"));

test("long conclusions are truncated in the terminal summary", () => {
  const out = visInjectionMessage("user-prompt", { conclusions: [long], queryLabel: "prompt" });
  expect(out).toContain("injected 1 conclusion (query: prompt)");
  // The bullet must not carry the whole conclusion.
  expect(out.length).toBeLessThan(long.length);
  expect(out).toContain("…");
});

test("short conclusions are shown in full, with no ellipsis", () => {
  const short = "robsherman prefers concise answers";
  const out = visInjectionMessage("user-prompt", { conclusions: [short] });
  expect(out).toContain(short);
  expect(out).not.toContain("…");
});

test("every conclusion is bounded, so N long ones cannot flood the terminal", () => {
  const many = Array.from({ length: 5 }, () => long);
  const out = visInjectionMessage("user-prompt", { conclusions: many, queryLabel: "prompt" });
  expect(out).toContain("injected 5 conclusions");
  // 5 × (preview + bullet + newline) plus the header — far below 5 × full length.
  expect(out.length).toBeLessThan(many.join("").length / 2);
});

test("newlines inside a conclusion are collapsed so one bullet stays one line", () => {
  const multiline = "first line\nsecond line\nthird line";
  const out = visInjectionMessage("user-prompt", { conclusions: [multiline] });
  const bulletLines = out.split("\n").filter(l => l.includes("first line"));
  expect(bulletLines).toHaveLength(1);
  expect(bulletLines[0]).toContain("second line");
});
