/**
 * Visual logging for honcho hooks
 *
 * Only hooks that output JSON with `systemMessage` show inline indicators in Claude Code:
 * - UserPromptSubmit — addSystemMessage() adds to existing JSON output
 * - PostToolUse — visCapture() outputs JSON with systemMessage
 * - Stop — visStopMessage() outputs JSON with systemMessage
 *
 * SessionStart, SessionEnd, and PreCompact output plain text to stdout (context injection),
 * so they cannot show inline indicators. Their activity is logged to the verbose log file only.
 */

import { arrows, symbols } from "./unicode.js";
import {
  isLoggingEnabled,
  getEndpointInfo,
  getWorkspaceProvenance,
  DEFAULT_OUTPUT_LEVEL,
  type OutputLevel,
  type HonchoCLAUDEConfig,
} from "./config.js";

// Plain text (no ANSI) for systemMessage — shown in Claude Code's UI
const sym = {
  left: arrows.left,      // ←
  right: arrows.right,    // →
  check: symbols.check,   // ✓
  bullet: symbols.bullet, // •
  cross: symbols.cross,   // ✗
};

type HookDirection = "in" | "out" | "info" | "ok" | "warn" | "error";

const directionSymbol: Record<HookDirection, string> = {
  in:    sym.left,
  out:   sym.right,
  info:  sym.bullet,
  ok:    sym.check,
  warn:  "!",
  error: sym.cross,
};

/**
 * Format a visual log line (plain text, no ANSI — for systemMessage display)
 */
function formatLine(direction: HookDirection, hookName: string, message: string): string {
  return `[honcho] ${hookName} ${directionSymbol[direction]} ${message}`;
}

// ============================================
// Terminal output level — the display dial
//
// Governs the human-facing `systemMessage` ONLY. The `additionalContext`
// payload handed to the model is built independently and is byte-identical at
// every level, including "off": memory quality must never depend on how loud
// the terminal is (asserted in output-level.test.ts).
//
// Set once per hook process by config.ts's initHook(), right after host
// detection. The default is "info" (NOT "verbose") so an emitter that somehow
// runs before initialization can only ever under-print, never spam.
//
// Unrelated to `logging` / verboseApiResult / writeVerbose further down this
// file — those write to ~/.honcho/*.log FILES and are not affected by this dial.
// ============================================

const LEVEL_RANK: Record<OutputLevel, number> = { off: 0, error: 1, info: 2, verbose: 3 };

let _outputLevel: OutputLevel = DEFAULT_OUTPUT_LEVEL;

export function setOutputLevel(level: OutputLevel): void {
  _outputLevel = level;
}

export function getCurrentOutputLevel(): OutputLevel {
  return _outputLevel;
}

/** True when the current level is at least as loud as `min`. */
function atLeast(min: OutputLevel): boolean {
  return LEVEL_RANK[_outputLevel] >= LEVEL_RANK[min];
}

/** Routine status lines ("injected …", "captured: …", "saved N msgs") — verbose + info. */
function showsStatus(): boolean {
  return atLeast("info");
}

/** Per-conclusion bullets, full dialectic answers, diagnostics — verbose only. */
function showsDetail(): boolean {
  return atLeast("verbose");
}

/** Failures — verbose + info + error; silent only at "off". */
function showsErrors(): boolean {
  return atLeast("error");
}

/**
 * Print one systemMessage JSON to stdout, built from `lines`.
 *
 * Empty lines are dropped and a fully-empty set prints NOTHING — no blank
 * `systemMessage`, no stray newline. Every printing emitter routes through this
 * so a hook emits at most ONE JSON object on stdout: Claude Code parses hook
 * stdout as a single JSON document, and a second `console.log(JSON.stringify(…))`
 * would corrupt it (for UserPromptSubmit it would be swallowed as raw context
 * text). Hooks that already own their stdout (user-prompt, session-start) use
 * the *-line/returning variants and fold the result into their own object.
 */
function emitLines(lines: (string | undefined | null)[]): void {
  const body = lines.filter((l): l is string => !!l && l.trim().length > 0).join("\n");
  if (!body) return;
  console.log(JSON.stringify({ systemMessage: body }));
}

/**
 * Output a systemMessage JSON to stdout — shown to the user in Claude Code's UI
 * Use this for hooks that don't already write to stdout (PostToolUse, Stop).
 * Suppressed below "info" — use visError() for failures, which survives "error".
 */
export function visMessage(direction: HookDirection, hookName: string, message: string): void {
  if (!showsStatus()) return;
  emitLines([formatLine(direction, hookName, message)]);
}

/**
 * A failure line, formatted. Returns "" at "off". Use this from hooks that
 * already own stdout (user-prompt) and fold the result into their own JSON.
 */
export function visErrorLine(hookName: string, message: string): string {
  if (!showsErrors()) return "";
  return formatLine("error", hookName, message);
}

/**
 * Report a failure to the terminal. Visible at "verbose", "info" AND "error" —
 * the whole point of the "error" level is that a broken endpoint, a rejected
 * credential or a dropped write still reaches the user when routine chatter
 * does not. Silent only at "off".
 */
export function visError(hookName: string, message: string): void {
  emitLines([visErrorLine(hookName, message)]);
}

/**
 * A compact one-block health readout: where we're talking to, which workspace
 * we resolved and why, and whether Cloudflare Access headers are attached.
 * Verbose only — returns "" otherwise.
 *
 * Returns a string rather than printing: its only caller (user-prompt) already
 * owns stdout and must emit exactly one JSON object. See emitLines() above.
 *
 * NEVER prints credential VALUES — only the boolean fact that both halves of
 * the Access service token are present and therefore being sent.
 */
export function visDiagnostics(
  config: HonchoCLAUDEConfig,
  extra?: Record<string, string | number>,
  cwd: string = process.cwd(),
): string {
  if (!showsDetail()) return "";

  let workspaceDetail = config.workspace;
  try {
    const prov = getWorkspaceProvenance(cwd);
    workspaceDetail = `${prov.workspace || config.workspace} (source: ${prov.source}${prov.path ? ` @ ${prov.path}` : ""})`;
  } catch {
    // provenance is a nicety; never let it break the turn
  }

  const accessHeaders = Boolean(config.accessClientId && config.accessClientSecret);
  const rows: string[] = [
    `endpoint: ${getEndpointInfo(config).url}`,
    `workspace: ${workspaceDetail}`,
    `cf-access headers: ${accessHeaders ? "yes" : "no"}`,
  ];
  for (const [k, v] of Object.entries(extra ?? {})) {
    rows.push(`${k}: ${v}`);
  }

  return [
    formatLine("info", "diagnostics", `output level ${_outputLevel}`),
    ...rows.map(r => `  ${sym.bullet} ${r}`),
  ].join("\n");
}

/**
 * Build the injection systemMessage for the user-prompt hook: a one-line status
 * summary followed by the injected conclusions as bullets. The stable profile
 * block is intentionally omitted here — it lives in the injection log, not in
 * every turn's transcript. `matched` is only set for high-signal topics, so a
 * low-signal fuzzy fallback query is never surfaced as a bogus match.
 */
/**
 * Max characters of a single conclusion shown in the terminal summary.
 * This bounds the *display* only — `additionalContext` still carries every
 * conclusion at full length, so the model's memory is unaffected. Without this
 * bound a handful of long conclusions reprint several KB on every single turn.
 */
export const CONCLUSION_PREVIEW_CHARS = 160;

/** One conclusion, collapsed to a single bounded line for terminal display. */
function previewConclusion(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > CONCLUSION_PREVIEW_CHARS
    ? `${oneLine.slice(0, CONCLUSION_PREVIEW_CHARS)}…`
    : oneLine;
}

export function visInjectionMessage(hookName: string, opts: {
  conclusions: string[];
  matched?: string[];
  /** Overrides the matched suffix, e.g. "prompt" → "(query: prompt)". */
  queryLabel?: string;
}): string {
  // "error"/"off": a healthy injection is not a failure — say nothing.
  if (!showsStatus()) return "";
  const count = opts.conclusions.length;
  const noun = count === 1 ? "conclusion" : "conclusions";
  const head = opts.queryLabel
    ? `injected ${count} ${noun} (query: ${opts.queryLabel})`
    : opts.matched?.length
      ? `injected ${count} ${noun} (matched: ${opts.matched.join(", ")})`
      : `injected ${count} ${noun}`;
  const summary = formatLine("in", hookName, head);
  // "info" is the default and deliberately prints the header ONLY — reprinting
  // every conclusion on every turn is the noise this dial exists to fix.
  if (!showsDetail()) return summary;
  const body = opts.conclusions.map(c => `  ${sym.bullet} ${previewConclusion(c)}`).join("\n");
  return body ? `${summary}\n${body}` : summary;
}

/**
 * Build the per-turn systemMessage for the "dialectic" component: a status line
 * (tier · elapsed) followed by the full reasoned answer, so the user sees
 * exactly what was injected. The answer is prose and can be long — that's the
 * intended trade-off; it also lands in additionalContext for the model.
 */
export function visDialecticMessage(hookName: string, reasoning: string, elapsedMs: number, answer: string): string {
  if (!showsStatus()) return "";
  const head = formatLine("in", hookName, `injected dialectic (${reasoning} · ${(elapsedMs / 1000).toFixed(1)}s)`);
  if (!showsDetail()) return head;
  return answer.trim() ? `${head}\n${answer.trim()}` : head;
}

/**
 * Build the systemMessage for the SessionStart composition: a single status
 * line naming which components were injected (e.g. "injected summary + peer
 * card (12 items)"). Session start is a once-per-session surface, so unlike the
 * per-turn line it stays terse — the payload itself goes to additionalContext.
 */
export function visComposedInjection(hookName: string, labels: string[]): string {
  if (!showsStatus()) return "";
  const summary = labels.length ? `injected ${labels.join(" + ")}` : "nothing to inject";
  return formatLine("in", hookName, summary);
}

/**
 * Pass through a plain status banner (e.g. the GUI session link) at
 * "verbose"/"info", drop it at "error"/"off". Without this, `off` would still
 * leak a one-line banner on the first turns of a session.
 */
export function visStatusLine(text: string): string {
  return showsStatus() ? text : "";
}

/** The "captured: …" line, formatted. Returns "" below "info". */
export function visCaptureLine(summary: string): string {
  if (!showsStatus()) return "";
  return formatLine("out", "post-tool-use", `captured: ${summary}`);
}

/**
 * Output tool capture as systemMessage (for post-tool-use — no existing stdout)
 */
export function visCapture(summary: string): void {
  emitLines([visCaptureLine(summary)]);
}

/**
 * Print the capture line and (if the upload failed) the error, as ONE JSON
 * object. post-tool-use has two things to say per invocation but only one
 * stdout write to say them in — see emitLines(). At "error"/"off" the capture
 * line drops out and only the failure survives.
 */
export function visCaptureWithError(summary: string, error?: string | null): void {
  emitLines([visCaptureLine(summary), error ? visErrorLine("post-tool-use", error) : ""]);
}

/**
 * Output skip as systemMessage (for hooks with no existing stdout)
 */
export function visSkipMessage(hookName: string, reason: string): void {
  visMessage("info", hookName, `skipped (${reason})`);
}

/**
 * Output stop hook message as systemMessage (no existing stdout)
 * Named "response" in display — "stop" fires after every Claude turn, not session end
 */
export function visStopMessage(direction: HookDirection, message: string): void {
  visMessage(direction, "response", message);
}

/**
 * Add systemMessage to an existing hookSpecificOutput JSON object
 * Used by UserPromptSubmit which already outputs JSON
 */
export function addSystemMessage(existingJson: any, message: string): any {
  // A suppressed emitter returns "". Adding `systemMessage: ""` would render an
  // empty banner in Claude Code, so an empty message adds NO key at all — the
  // difference between "quiet" and "a blank line every turn".
  if (!message || !message.trim()) return existingJson;
  return { ...existingJson, systemMessage: message };
}

// ============================================
// Verbose output — written to ~/.honcho/verbose.log
// Tail with: tail -f ~/.honcho/verbose.log
//
// NOTE: This file-based verbose output is used by SessionStart and
// UserPromptSubmit hooks, where stdout is always visible to Claude
// (not just in Ctrl+O). For hooks where stdout is only shown in
// Ctrl+O (PreCompact, PostToolUse, Stop, SessionEnd), prefer
// printing verbose data to stdout instead — use formatVerboseBlock().
// ============================================

import { join } from "path";
import { appendFileSync, mkdirSync, existsSync, writeFileSync } from "fs";
import { honchoDir } from "./home.js";

// Lazily resolved (not a module-level const) so a `HOME` redirected after
// import (e.g. by tests) is honored — see home.ts's honchoDir().
function verboseLogPath(): string {
  return join(honchoDir(), "verbose.log");
}

function ensureVerboseLog(): void {
  const dir = honchoDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function writeVerbose(text: string): void {
  if (!isLoggingEnabled()) return;
  ensureVerboseLog();
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
  appendFileSync(verboseLogPath(), `[${timestamp}] ${text}\n`);
}

/**
 * Log detailed API response data to verbose log file (~/.honcho/verbose.log).
 * Used by SessionStart and UserPromptSubmit hooks where stdout is always
 * visible to Claude (so we can't use stdout for debug data).
 * View with: tail -f ~/.honcho/verbose.log
 */
export function verboseApiResult(label: string, data: string | null | undefined): void {
  if (!data) return;
  const separator = "─".repeat(60);
  const content = data.length > 3000 ? data.slice(0, 3000) + `\n... (${data.length - 3000} more chars)` : data;
  writeVerbose(`${label}\n${separator}\n${content}\n${separator}`);
}

/**
 * Log a list of items (like peerCard) to verbose log file (~/.honcho/verbose.log).
 * Used by SessionStart and UserPromptSubmit hooks (stdout always visible).
 */
export function verboseList(label: string, items: string[] | null | undefined): void {
  if (!items || items.length === 0) return;
  const formatted = items.map(item => `  • ${item}`).join("\n");
  writeVerbose(`${label} (${items.length} items)\n${formatted}`);
}

/**
 * Clear the verbose log (call at session start)
 */
export function clearVerboseLog(): void {
  if (!isLoggingEnabled()) return;
  ensureVerboseLog();
  writeFileSync(verboseLogPath(), "");
}

/**
 * Get the verbose log path
 */
export function getVerboseLogPath(): string {
  return verboseLogPath();
}

// ============================================
// Stdout-based verbose output — for Ctrl+O visibility
//
// In Claude Code, Ctrl+O toggles visibility of hook stdout.
// For hooks where stdout is only shown in Ctrl+O (PreCompact,
// PostToolUse, Stop, SessionEnd), we can print verbose data
// directly to stdout so it appears when the user presses Ctrl+O.
// ============================================

/**
 * Format verbose API response data as a plain-text block for stdout.
 * Use in hooks where stdout is only visible in Ctrl+O (PreCompact, Stop, etc.).
 * Returns empty string if data is null/undefined.
 */
export function formatVerboseBlock(label: string, data: string | null | undefined): string {
  if (!data) return "";
  const separator = "─".repeat(60);
  const content = data.length > 3000 ? data.slice(0, 3000) + `\n... (${data.length - 3000} more chars)` : data;
  return `\n[verbose] ${label}\n${separator}\n${content}\n${separator}`;
}

/**
 * Format a list of items as a plain-text block for stdout.
 * Use in hooks where stdout is only visible in Ctrl+O (PreCompact, Stop, etc.).
 * Returns empty string if items is null/undefined/empty.
 */
export function formatVerboseList(label: string, items: string[] | null | undefined): string {
  if (!items || items.length === 0) return "";
  const formatted = items.map(item => `  • ${item}`).join("\n");
  return `\n[verbose] ${label} (${items.length} items)\n${formatted}`;
}
