import {
  honchoDir
} from "./chunk-er0jc8ja.js";

// src/state.ts
import { join } from "path";
import { writeFileSync, unlinkSync, readFileSync } from "fs";
function stateFile(sessionId) {
  return join(honchoDir(), sessionId ? `state-${sessionId}.json` : "state.json");
}
function sessionFile(sessionId) {
  return join(honchoDir(), sessionId ? `session-${sessionId}.json` : "session.json");
}
function dedupFile(sessionId) {
  return join(honchoDir(), sessionId ? `dedup-${sessionId}.json` : "dedup.json");
}
function setMemoryState(phase, detail, sessionId) {
  try {
    writeFileSync(stateFile(sessionId), JSON.stringify({ phase, since: Date.now(), detail }));
  } catch {}
}
function setSessionLink(url, name, sessionId) {
  try {
    writeFileSync(sessionFile(sessionId), JSON.stringify({ url, name }));
  } catch {}
}
var DEDUP_LEDGER_RETAIN_TURNS = 50;
function isValidSeenMap(seen) {
  if (!seen || typeof seen !== "object" || Array.isArray(seen))
    return false;
  return Object.values(seen).every((v) => typeof v === "number" && Number.isFinite(v));
}
function loadDedupLedger(sessionId) {
  try {
    const raw = JSON.parse(readFileSync(dedupFile(sessionId), "utf-8"));
    const turn = typeof raw?.turn === "number" && raw.turn >= 0 ? raw.turn : 0;
    const seen = isValidSeenMap(raw?.seen) ? raw.seen : {};
    return { turn, seen };
  } catch {
    return { turn: 0, seen: {} };
  }
}
function saveDedupLedger(ledger, sessionId) {
  try {
    const cutoff = ledger.turn - DEDUP_LEDGER_RETAIN_TURNS;
    const seen = {};
    for (const [key, turn] of Object.entries(ledger.seen)) {
      if (turn > cutoff)
        seen[key] = turn;
    }
    writeFileSync(dedupFile(sessionId), JSON.stringify({ turn: ledger.turn, seen }));
  } catch {}
}
function clearSessionFiles(sessionId) {
  if (!sessionId)
    return;
  for (const f of [stateFile(sessionId), sessionFile(sessionId), dedupFile(sessionId)]) {
    try {
      unlinkSync(f);
    } catch {}
  }
}

export { setMemoryState, setSessionLink, loadDedupLedger, saveDedupLedger, clearSessionFiles };

//# debugId=5A7C44202DB29ECE64756E2164756E21
//# sourceMappingURL=chunk-xqbpafmf.js.map
