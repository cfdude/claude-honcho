/**
 * Tiny activity-state file the hooks write and the statusline reads.
 * Decoupled by design: hooks can't draw to the Claude Code TUI (no /dev/tty),
 * so instead they record what memory is doing and let the host-managed
 * statusline render the glow/pulse on its own refresh cycle.
 */

import { join } from "path";
import { writeFileSync, unlinkSync, readFileSync } from "fs";
import { honchoDir } from "./home.js";

// Per-window files keyed by Claude Code's session_id (the one field guaranteed
// identical between hook stdin and statusLine stdin). Falls back to a global
// file when no session_id is available, so multiple windows don't clobber each
// other's link/phase.
//
// honchoDir() is resolved lazily at call time (not captured into a module-level
// const) so it honors a `HOME` redirected after this module was imported.
function stateFile(sessionId?: string): string {
  return join(honchoDir(), sessionId ? `state-${sessionId}.json` : "state.json");
}
function sessionFile(sessionId?: string): string {
  return join(honchoDir(), sessionId ? `session-${sessionId}.json` : "session.json");
}
/**
 * Upstream #39 — the per-session ledger of conclusions already injected, so
 * UserPromptSubmit stops re-injecting the same ones verbatim every turn.
 *
 * It is a SIBLING of state-*.json rather than a field inside it: setMemoryState()
 * rewrites state-${sessionId}.json wholesale on every phase change (several times
 * per turn), so a ledger co-located there would be clobbered constantly. Same
 * directory, same session_id keying, same lazy honchoDir() resolution, and
 * clearSessionFiles() cleans it up with the rest.
 */
function dedupFile(sessionId?: string): string {
  return join(honchoDir(), sessionId ? `dedup-${sessionId}.json` : "dedup.json");
}

export type MemoryPhase =
  | "idle"
  | "loading"
  | "compacting"
  | "recalling"
  | "querying";    // an explicit honcho MCP tool call (search/chat/context/...)

export function setMemoryState(phase: MemoryPhase, detail?: string, sessionId?: string): void {
  try {
    writeFileSync(stateFile(sessionId), JSON.stringify({ phase, since: Date.now(), detail }));
  } catch {
    // best-effort — statusline falls back to idle if this is missing/stale
  }
}

// The hooks own the workspace + session-name math, so they write the resolved
// web URL here for the statusline to render as a clickable link.
export function setSessionLink(url: string, name: string | undefined, sessionId?: string): void {
  try {
    writeFileSync(sessionFile(sessionId), JSON.stringify({ url, name }));
  } catch {
    // best-effort — statusline just omits the link if this is missing
  }
}

/**
 * Which conclusions this session has already injected, and when.
 *
 * `turn` is the count of injecting UserPromptSubmit turns so far (trivial and
 * harness-injected prompts exit before reaching this, so they don't advance it).
 * `seen` maps a short content hash to the turn it was LAST actually injected on
 * — suppressed repeats deliberately do not refresh their stamp, so a conclusion
 * becomes eligible again a fixed window after its last real injection rather
 * than being buried forever.
 *
 * Only hashes are stored, never conclusion text: the ledger stays tiny and no
 * memory content is duplicated into a second file on disk.
 */
export interface DedupLedger {
  turn: number;
  seen: Record<string, number>;
}

/** Entries older than this many turns are dropped on save, bounding file size. */
const DEDUP_LEDGER_RETAIN_TURNS = 50;

/**
 * A ledger's `seen` map must be a plain object of finite numeric turn stamps.
 * Arrays and non-numeric values are treated as corruption and discarded.
 */
function isValidSeenMap(seen: unknown): seen is Record<string, number> {
  if (!seen || typeof seen !== "object" || Array.isArray(seen)) return false;
  return Object.values(seen as Record<string, unknown>).every(
    (v) => typeof v === "number" && Number.isFinite(v),
  );
}

export function loadDedupLedger(sessionId?: string): DedupLedger {
  try {
    const raw = JSON.parse(readFileSync(dedupFile(sessionId), "utf-8"));
    const turn = typeof raw?.turn === "number" && raw.turn >= 0 ? raw.turn : 0;
    // `typeof x === "object"` alone admits arrays and non-numeric stamps. A
    // stamp that will not coerce to a number makes `ledger.turn - lastTurn`
    // NaN, and `NaN > DEDUP_WINDOW_TURNS` is false — so that conclusion reads
    // as a permanent repeat, and only *kept* entries get restamped, so it never
    // heals for the life of the session.
    const seen = isValidSeenMap(raw?.seen) ? raw.seen : {};
    return { turn, seen };
  } catch {
    // Missing or corrupt: start clean. A lost ledger only costs one turn of
    // repeats — never memory content.
    return { turn: 0, seen: {} };
  }
}

export function saveDedupLedger(ledger: DedupLedger, sessionId?: string): void {
  try {
    const cutoff = ledger.turn - DEDUP_LEDGER_RETAIN_TURNS;
    const seen: Record<string, number> = {};
    for (const [key, turn] of Object.entries(ledger.seen)) {
      if (turn > cutoff) seen[key] = turn;
    }
    writeFileSync(dedupFile(sessionId), JSON.stringify({ turn: ledger.turn, seen }));
  } catch {
    // best-effort — a failed write just means the next turn may repeat itself
  }
}

// Clean up this window's files when its session ends, so they don't accumulate.
export function clearSessionFiles(sessionId?: string): void {
  if (!sessionId) return;
  for (const f of [stateFile(sessionId), sessionFile(sessionId), dedupFile(sessionId)]) {
    try { unlinkSync(f); } catch { /* already gone */ }
  }
}
