import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

import {
  emitPerTurn,
  filterRepeats,
  dedupKey,
  DEDUP_WINDOW_TURNS,
  DEDUP_FLOOR,
} from "./hooks/user-prompt.js";
import {
  loadDedupLedger,
  saveDedupLedger,
  clearSessionFiles,
  type DedupLedger,
} from "./state.js";
import { setOutputLevel } from "./visual.js";
import { OUTPUT_LEVELS, type OutputLevel } from "./config.js";

/**
 * Upstream #39 — UserPromptSubmit re-injected identical conclusions every turn.
 *
 * Dedup design under test:
 *  - Per Claude Code session_id, in ~/.honcho/dedup-<session_id>.json.
 *  - "Recently" = a sliding DEDUP_WINDOW_TURNS window keyed off the turn a
 *    conclusion was LAST actually injected, so nothing is suppressed forever.
 *  - Floor: a non-empty retrieval never yields an empty injection.
 *  - Independent of outputLevel, so the additionalContext invariant holds.
 */

// ============================================
// filterRepeats — window, re-surfacing, floor
// ============================================

const A = "robsherman prefers concise answers";
const B = "robsherman self-hosts Honcho on Railway";
const C = "robsherman uses bun, not node";

function ledger(turn: number, seen: Record<string, number> = {}): DedupLedger {
  return { turn, seen };
}

test("first turn injects everything and records it", () => {
  const l = ledger(1);
  const res = filterRepeats([A, B, C], l, "u");
  expect(res.kept).toEqual([A, B, C]);
  expect(res.suppressed).toBe(0);
  expect(res.floored).toBe(false);
  expect(Object.keys(l.seen)).toHaveLength(3);
  expect(l.seen[dedupKey(A, "u")]).toBe(1);
});

test("a conclusion injected last turn is suppressed on the next turn", () => {
  const l = ledger(1);
  filterRepeats([A, B], l, "u");

  l.turn = 2;
  const res = filterRepeats([A, B, C], l, "u");
  expect(res.kept).toEqual([C]);
  expect(res.suppressed).toBe(2);
  expect(res.floored).toBe(false);
});

test("cosmetic differences (case, whitespace) still count as a repeat", () => {
  const l = ledger(1);
  filterRepeats([A], l, "u");
  l.turn = 2;
  const res = filterRepeats([`  ROBSHERMAN   prefers    concise answers `, C], l, "u");
  expect(res.kept).toEqual([C]);
});

test("the same sentence about the user and about the assistant are distinct facts", () => {
  const l = ledger(1);
  filterRepeats([A], l, "u");
  l.turn = 2;
  // Namespaced separately, so the assistant view is not suppressed by the user view.
  expect(filterRepeats([A], l, "a").kept).toEqual([A]);
});

test("a suppressed conclusion re-surfaces once the window has passed", () => {
  const l = ledger(1);
  filterRepeats([A], l, "u");

  // Still inside the window: suppressed (and the floor is what returns it).
  l.turn = 1 + DEDUP_WINDOW_TURNS;
  expect(filterRepeats([A, B], l, "u").kept).toEqual([B]);

  // Past the window, measured from its LAST REAL injection (turn 1) — not from
  // the turns on which it was suppressed. Nothing is buried forever.
  l.turn = 1 + DEDUP_WINDOW_TURNS + 1;
  expect(filterRepeats([A], l, "u").kept).toEqual([A]);
  expect(l.seen[dedupKey(A, "u")]).toBe(l.turn);
});

test("being suppressed does not slide the window forward", () => {
  const l = ledger(1);
  filterRepeats([A], l, "u");
  // Suppressed on every turn in between. Each turn carries a genuinely NEW
  // conclusion so the floor never fires (the floor legitimately re-injects, and
  // re-injecting legitimately refreshes the stamp — that path is covered below).
  for (let t = 2; t <= DEDUP_WINDOW_TURNS; t++) {
    l.turn = t;
    const res = filterRepeats([A, `fresh conclusion ${t}`], l, "u");
    expect(res.kept).toEqual([`fresh conclusion ${t}`]);
  }
  // The stamp still points at A's last REAL injection, so it ages out on
  // schedule instead of being pushed further away every turn.
  expect(l.seen[dedupKey(A, "u")]).toBe(1);
});

test("FLOOR: dedup never yields an empty list for a non-empty retrieval", () => {
  const l = ledger(1);
  filterRepeats([A, B, C], l, "u");

  l.turn = 2;
  const res = filterRepeats([A, B, C], l, "u");
  // Everything was a repeat — but degrading memory to nothing is worse than
  // repeating, so the top-N come back regardless.
  expect(res.floored).toBe(true);
  expect(res.kept.length).toBeGreaterThan(0);
  expect(res.kept).toEqual([A, B, C].slice(0, DEDUP_FLOOR));
});

test("FLOOR: holds for a single all-repeat conclusion too", () => {
  const l = ledger(1);
  filterRepeats([A], l, "u");
  l.turn = 2;
  const res = filterRepeats([A], l, "u");
  expect(res.kept).toEqual([A]);
  expect(res.floored).toBe(true);
});

test("an empty retrieval stays empty (nothing is invented)", () => {
  const l = ledger(1);
  const res = filterRepeats([], l, "u");
  expect(res.kept).toEqual([]);
  expect(res.floored).toBe(false);
});

// ============================================
// emitPerTurn integration + the outputLevel invariant WITH dedup active
// ============================================

const EMIT_CONFIG = { peerName: "robsherman", aiPeer: "claude" };
const EMIT_INJECTION = { perTurn: ["userContext"], showContents: [] } as any;
const CTX = { context: { representation: `- ${A}\n- ${B}\n- ${C}` } };

function captureStdout(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.join(" ")); };
  try { fn(); } finally { console.log = original; }
  return lines;
}

function emitWith(l: DedupLedger, level: OutputLevel = "info"): any {
  setOutputLevel(level);
  const lines = captureStdout(() =>
    emitPerTurn(EMIT_CONFIG, EMIT_INJECTION, CTX, null, null, null, { dedup: l })
  );
  return lines.length ? JSON.parse(lines[0]!) : null;
}

test("the second identical turn injects a smaller payload but never an empty one", () => {
  // More conclusions than DEDUP_FLOOR, so an all-repeat turn genuinely shrinks
  // (with <= DEDUP_FLOOR conclusions the floor returns all of them, by design).
  const many = [A, B, C, "robsherman runs bun test before committing", "robsherman dislikes silent failures"];
  const MANY_CTX = { context: { representation: many.map((c) => `- ${c}`).join("\n") } };
  const emitMany = (l: DedupLedger) => {
    setOutputLevel("info");
    const lines = captureStdout(() =>
      emitPerTurn(EMIT_CONFIG, EMIT_INJECTION, MANY_CTX, null, null, null, { dedup: l })
    );
    return JSON.parse(lines[0]!);
  };

  const l = ledger(1);
  const first = emitMany(l);
  const firstCtx = first.hookSpecificOutput.additionalContext;
  for (const c of many) expect(firstCtx).toContain(c);

  // Exactly the same retrieval comes back next turn — the #39 repetition.
  l.turn = 2;
  const second = emitMany(l);
  const secondCtx = second.hookSpecificOutput.additionalContext;

  // Repeats are gone, so the payload shrank...
  expect(secondCtx.length).toBeLessThan(firstCtx.length);
  // ...but it is still a real injection (the floor), not nothing.
  expect(secondCtx).toContain("Relevant conclusions:");
  expect(secondCtx.trim().length).toBeGreaterThan(0);
  // ...capped by the floor, in retrieval (relevance) order.
  for (const c of many.slice(0, DEDUP_FLOOR)) expect(secondCtx).toContain(c);
  for (const c of many.slice(DEDUP_FLOOR)) expect(secondCtx).not.toContain(c);
});

test("a genuinely new conclusion is injected while the repeats are dropped", () => {
  const l = ledger(1);
  emitWith(l);

  l.turn = 2;
  const NEW = "robsherman is fixing upstream honcho issues";
  setOutputLevel("info");
  const lines = captureStdout(() =>
    emitPerTurn(
      EMIT_CONFIG,
      EMIT_INJECTION,
      { context: { representation: `- ${A}\n- ${B}\n- ${NEW}` } },
      null, null, null,
      { dedup: l },
    )
  );
  const ctx = JSON.parse(lines[0]!).hookSpecificOutput.additionalContext;
  expect(ctx).toContain(NEW);
  expect(ctx).not.toContain(A);
  expect(ctx).not.toContain(B);
});

test("INVARIANT: dedup does not depend on outputLevel — identical payload at every level", () => {
  // A populated ledger, so dedup is genuinely ACTIVE for each emit (the
  // pre-existing invariant test passes no ledger and would not cover this).
  const payloads = OUTPUT_LEVELS.map((level) => {
    const seeded = ledger(1);
    filterRepeats([A], seeded, "u"); // A is a repeat...
    seeded.turn = 2;                 // ...as of this turn
    return emitWith(seeded, level);
  });

  const contexts = payloads.map((p) => p.hookSpecificOutput.additionalContext);
  expect(new Set(contexts).size).toBe(1);
  // And dedup really was in effect: A suppressed, B and C injected.
  expect(contexts[0]).not.toContain(A);
  expect(contexts[0]).toContain(B);
});

test("without a ledger, emitPerTurn behaves exactly as before (no dedup)", () => {
  const first = (() => {
    setOutputLevel("info");
    const lines = captureStdout(() =>
      emitPerTurn(EMIT_CONFIG, EMIT_INJECTION, CTX, null, null, null, {})
    );
    return JSON.parse(lines[0]!).hookSpecificOutput.additionalContext;
  })();
  expect(first).toContain(A);
  expect(first).toContain(B);
  expect(first).toContain(C);
});

// ============================================
// Ledger persistence — under a FAKE HOME
// ============================================

let realHonchoBefore: string[] = [];
let originalHome: string | undefined;
let fakeHome: string;

beforeEach(() => {
  const realHoncho = join(homedir(), ".honcho");
  realHonchoBefore = existsSync(realHoncho) ? readdirSync(realHoncho) : [];
  fakeHome = mkdtempSync(join(tmpdir(), "honcho-dedup-"));
  mkdirSync(join(fakeHome, ".honcho"), { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });

  // Nothing may have appeared in the developer's real ~/.honcho.
  const realHoncho = join(homedir(), ".honcho");
  const after = existsSync(realHoncho) ? readdirSync(realHoncho) : [];
  expect(after.filter((f) => !realHonchoBefore.includes(f))).toEqual([]);
});

test("the ledger round-trips through ~/.honcho and lands under the redirected HOME", () => {
  const l = ledger(3, { "u:abc123": 2 });
  saveDedupLedger(l, "sess-1");

  expect(existsSync(join(fakeHome, ".honcho", "dedup-sess-1.json"))).toBe(true);
  expect(loadDedupLedger("sess-1")).toEqual({ turn: 3, seen: { "u:abc123": 2 } });
});

test("a missing or corrupt ledger degrades to a clean one, never a throw", () => {
  expect(loadDedupLedger("never-written")).toEqual({ turn: 0, seen: {} });

  writeFileSync(join(fakeHome, ".honcho", "dedup-broken.json"), "{not json");
  expect(() => loadDedupLedger("broken")).not.toThrow();
  expect(loadDedupLedger("broken")).toEqual({ turn: 0, seen: {} });
});

test("stale entries are pruned on save so the ledger cannot grow without bound", () => {
  saveDedupLedger({ turn: 100, seen: { "u:old": 10, "u:recent": 95 } }, "sess-2");
  const reloaded = loadDedupLedger("sess-2");
  expect(reloaded.seen["u:recent"]).toBe(95);
  expect(reloaded.seen["u:old"]).toBeUndefined();
});

test("clearSessionFiles removes the ledger with the rest of the session state", () => {
  saveDedupLedger(ledger(1, { "u:x": 1 }), "sess-3");
  expect(existsSync(join(fakeHome, ".honcho", "dedup-sess-3.json"))).toBe(true);
  clearSessionFiles("sess-3");
  expect(existsSync(join(fakeHome, ".honcho", "dedup-sess-3.json"))).toBe(false);
});

// ============================================
// Ledger validation (upstream PR #104 review)
// ============================================

/**
 * `typeof x === "object"` alone admits arrays and non-numeric stamps.
 * filterRepeats computes `ledger.turn - lastTurn`; a value that will not coerce
 * yields NaN, and `NaN > DEDUP_WINDOW_TURNS` is false — so the conclusion reads
 * as a repeat. Only KEPT entries are restamped, so a poisoned entry never heals
 * for the life of the session. loadDedupLedger therefore rejects the whole map.
 */
test("a seen map with a non-numeric stamp is discarded, not trusted", () => {
  writeFileSync(
    join(fakeHome, ".honcho", "dedup-sess-corrupt.json"),
    JSON.stringify({ turn: 5, seen: { "u:x": "abc" } }),
  );
  const loaded = loadDedupLedger("sess-corrupt");
  expect(loaded.seen).toEqual({});
  expect(loaded.turn).toBe(5);
});

test("a seen map that is an array is discarded", () => {
  writeFileSync(
    join(fakeHome, ".honcho", "dedup-sess-array.json"),
    JSON.stringify({ turn: 3, seen: [1, 2, 3] }),
  );
  expect(loadDedupLedger("sess-array").seen).toEqual({});
});

test("a valid numeric seen map still round-trips", () => {
  writeFileSync(
    join(fakeHome, ".honcho", "dedup-sess-good.json"),
    JSON.stringify({ turn: 4, seen: { "u:x": 2 } }),
  );
  expect(loadDedupLedger("sess-good").seen).toEqual({ "u:x": 2 });
});
