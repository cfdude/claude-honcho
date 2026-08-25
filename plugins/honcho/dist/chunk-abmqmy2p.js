import {
  arrows,
  symbols
} from "./chunk-fe8crnvp.js";
import {
  DEFAULT_OUTPUT_LEVEL,
  getEndpointInfo,
  getWorkspaceProvenance,
  honchoDir,
  isLoggingEnabled
} from "./chunk-er0jc8ja.js";

// src/visual.ts
import { join } from "path";
import { appendFileSync, mkdirSync, existsSync, writeFileSync } from "fs";
var sym = {
  left: arrows.left,
  right: arrows.right,
  check: symbols.check,
  bullet: symbols.bullet,
  cross: symbols.cross
};
var directionSymbol = {
  in: sym.left,
  out: sym.right,
  info: sym.bullet,
  ok: sym.check,
  warn: "!",
  error: sym.cross
};
function formatLine(direction, hookName, message) {
  return `[honcho] ${hookName} ${directionSymbol[direction]} ${message}`;
}
var LEVEL_RANK = { off: 0, error: 1, info: 2, verbose: 3 };
var _outputLevel = DEFAULT_OUTPUT_LEVEL;
function setOutputLevel(level) {
  _outputLevel = level;
}
function getCurrentOutputLevel() {
  return _outputLevel;
}
function atLeast(min) {
  return LEVEL_RANK[_outputLevel] >= LEVEL_RANK[min];
}
function showsStatus() {
  return atLeast("info");
}
function showsDetail() {
  return atLeast("verbose");
}
function showsErrors() {
  return atLeast("error");
}
function emitLines(lines) {
  const body = lines.filter((l) => !!l && l.trim().length > 0).join(`
`);
  if (!body)
    return;
  console.log(JSON.stringify({ systemMessage: body }));
}
function visMessage(direction, hookName, message) {
  if (!showsStatus())
    return;
  emitLines([formatLine(direction, hookName, message)]);
}
function visErrorLine(hookName, message) {
  if (!showsErrors())
    return "";
  return formatLine("error", hookName, message);
}
function visError(hookName, message) {
  emitLines([visErrorLine(hookName, message)]);
}
function visDiagnostics(config, extra, cwd = process.cwd()) {
  if (!showsDetail())
    return "";
  let workspaceDetail = config.workspace;
  try {
    const prov = getWorkspaceProvenance(cwd);
    workspaceDetail = `${prov.workspace || config.workspace} (source: ${prov.source}${prov.path ? ` @ ${prov.path}` : ""})`;
  } catch {}
  const accessHeaders = Boolean(config.accessClientId && config.accessClientSecret);
  const rows = [
    `endpoint: ${getEndpointInfo(config).url}`,
    `workspace: ${workspaceDetail}`,
    `cf-access headers: ${accessHeaders ? "yes" : "no"}`
  ];
  for (const [k, v] of Object.entries(extra ?? {})) {
    rows.push(`${k}: ${v}`);
  }
  return [
    formatLine("info", "diagnostics", `output level ${_outputLevel}`),
    ...rows.map((r) => `  ${sym.bullet} ${r}`)
  ].join(`
`);
}
var CONCLUSION_PREVIEW_CHARS = 160;
function previewConclusion(text) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > CONCLUSION_PREVIEW_CHARS ? `${oneLine.slice(0, CONCLUSION_PREVIEW_CHARS)}…` : oneLine;
}
function visInjectionMessage(hookName, opts) {
  if (!showsStatus())
    return "";
  const count = opts.conclusions.length;
  const noun = count === 1 ? "conclusion" : "conclusions";
  const head = opts.queryLabel ? `injected ${count} ${noun} (query: ${opts.queryLabel})` : opts.matched?.length ? `injected ${count} ${noun} (matched: ${opts.matched.join(", ")})` : `injected ${count} ${noun}`;
  const summary = formatLine("in", hookName, head);
  if (!showsDetail() && !opts.showContents)
    return summary;
  const body = opts.conclusions.map((c) => `  ${sym.bullet} ${previewConclusion(c)}`).join(`
`);
  return body ? `${summary}
${body}` : summary;
}
function visDialecticMessage(hookName, reasoning, elapsedMs, answer, showContents = false) {
  if (!showsStatus())
    return "";
  const head = formatLine("in", hookName, `injected dialectic (${reasoning} · ${(elapsedMs / 1000).toFixed(1)}s)`);
  if (!showsDetail() && !showContents)
    return head;
  return answer.trim() ? `${head}
${answer.trim()}` : head;
}
function visSessionContextMessage(hookName, lines, tokenCount, showContents = false) {
  if (!showsStatus())
    return "";
  const noun = lines.length === 1 ? "message" : "messages";
  const head = formatLine("in", hookName, `injected ${lines.length} session ${noun} (~${tokenCount} tokens)`);
  if (!showsDetail() && !showContents)
    return head;
  const body = lines.map((l) => {
    const flat = l.replace(/\s+/g, " ").trim();
    return `  ${sym.bullet} ${flat.length > 150 ? `${flat.slice(0, 149)}…` : flat}`;
  }).join(`
`);
  return body ? `${head}
${body}` : head;
}
function visComposedInjection(hookName, labels) {
  if (!showsStatus())
    return "";
  const summary = labels.length ? `injected ${labels.join(" + ")}` : "nothing to inject";
  return formatLine("in", hookName, summary);
}
function visStatusLine(text) {
  return showsStatus() ? text : "";
}
function visCaptureLine(summary, uploaded = true) {
  if (!showsStatus())
    return "";
  const label = uploaded ? "captured" : "captured (local only)";
  return formatLine("out", "post-tool-use", `${label}: ${summary}`);
}
function visDurationLine(hookName, ms) {
  if (!showsDetail())
    return "";
  return formatLine("info", hookName, `took ${ms}ms`);
}
function visCapture(summary) {
  emitLines([visCaptureLine(summary)]);
}
function visCaptureWithError(summary, error, opts = {}) {
  emitLines([
    visCaptureLine(summary, opts.uploaded ?? true),
    error ? visErrorLine("post-tool-use", error) : "",
    opts.durationMs === undefined ? "" : visDurationLine("post-tool-use", opts.durationMs)
  ]);
}
function visSkipMessage(hookName, reason) {
  visMessage("info", hookName, `skipped (${reason})`);
}
function visStopMessage(direction, message) {
  visMessage(direction, "response", message);
}
function addSystemMessage(existingJson, message) {
  if (!message || !message.trim())
    return existingJson;
  return { ...existingJson, systemMessage: message };
}
function verboseLogPath() {
  return join(honchoDir(), "verbose.log");
}
function ensureVerboseLog() {
  const dir = honchoDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
function writeVerbose(text) {
  if (!isLoggingEnabled())
    return;
  ensureVerboseLog();
  const timestamp = new Date().toISOString().split("T")[1].split(".")[0];
  appendFileSync(verboseLogPath(), `[${timestamp}] ${text}
`);
}
function verboseApiResult(label, data) {
  if (!data)
    return;
  const separator = "─".repeat(60);
  const content = data.length > 3000 ? data.slice(0, 3000) + `
... (${data.length - 3000} more chars)` : data;
  writeVerbose(`${label}
${separator}
${content}
${separator}`);
}
function verboseList(label, items) {
  if (!items || items.length === 0)
    return;
  const formatted = items.map((item) => `  • ${item}`).join(`
`);
  writeVerbose(`${label} (${items.length} items)
${formatted}`);
}
function clearVerboseLog() {
  if (!isLoggingEnabled())
    return;
  ensureVerboseLog();
  writeFileSync(verboseLogPath(), "");
}
function getVerboseLogPath() {
  return verboseLogPath();
}
function formatVerboseBlock(label, data) {
  if (!data)
    return "";
  const separator = "─".repeat(60);
  const content = data.length > 3000 ? data.slice(0, 3000) + `
... (${data.length - 3000} more chars)` : data;
  return `
[verbose] ${label}
${separator}
${content}
${separator}`;
}
function formatVerboseList(label, items) {
  if (!items || items.length === 0)
    return "";
  const formatted = items.map((item) => `  • ${item}`).join(`
`);
  return `
[verbose] ${label} (${items.length} items)
${formatted}`;
}

export { setOutputLevel, getCurrentOutputLevel, visMessage, visErrorLine, visError, visDiagnostics, CONCLUSION_PREVIEW_CHARS, visInjectionMessage, visDialecticMessage, visSessionContextMessage, visComposedInjection, visStatusLine, visCaptureLine, visDurationLine, visCapture, visCaptureWithError, visSkipMessage, visStopMessage, addSystemMessage, verboseApiResult, verboseList, clearVerboseLog, getVerboseLogPath, formatVerboseBlock, formatVerboseList };

//# debugId=9C1B0AF9EC188ECF64756E2164756E21
//# sourceMappingURL=chunk-abmqmy2p.js.map
