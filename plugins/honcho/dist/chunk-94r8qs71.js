import {
  arrows,
  box,
  symbols
} from "./chunk-fe8crnvp.js";
import {
  honchoDir,
  isLoggingEnabled
} from "./chunk-er0jc8ja.js";

// src/log.ts
import { join } from "path";
import { existsSync, appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
function cacheDir() {
  return honchoDir();
}
function logFile() {
  return join(cacheDir(), "activity.log");
}
var MAX_LOG_SIZE = 100 * 1024;
var sym = {
  check: symbols.check,
  cross: symbols.cross,
  arrow: arrows.right,
  dot: symbols.bullet,
  circle: symbols.dot,
  branch: box.branchRight,
  corner: box.cornerRight,
  pipe: box.vertical,
  top: box.topRight,
  line: box.horizontal
};
function ensureLogDir() {
  if (!existsSync(cacheDir())) {
    mkdirSync(cacheDir(), { recursive: true });
  }
}
var currentCwd = null;
var currentSession = null;
function setLogContext(cwd, session) {
  currentCwd = cwd;
  currentSession = session || null;
}
function logActivity(level, source, message, data, options) {
  if (!isLoggingEnabled())
    return;
  ensureLogDir();
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    source,
    message,
    data,
    timing: options?.timing,
    success: options?.success,
    depth: options?.depth ?? 0,
    cwd: options?.cwd || currentCwd || undefined,
    session: options?.session || currentSession || undefined
  };
  try {
    if (existsSync(logFile())) {
      const stats = statSync(logFile()).size;
      if (stats > MAX_LOG_SIZE) {
        const content = readFileSync(logFile(), "utf-8");
        const truncated = content.slice(-50 * 1024);
        writeFileSync(logFile(), truncated);
      }
    }
    appendFileSync(logFile(), JSON.stringify(entry) + `
`);
  } catch {}
}
function logHook(hookName, message, data) {
  logActivity("hook", hookName, message, data);
}
function logApiCall(endpoint, method, details, timing, success) {
  const msg = `${method} ${endpoint}${details ? ` ${sym.arrow} ${details}` : ""}`;
  logActivity("api", "honcho", msg, undefined, { timing, success });
}
function logFlow(stage, message, data) {
  logActivity("flow", stage, message, data);
}
function logAsync(operation, message, results) {
  logActivity("async", operation, message, results ? { results } : undefined);
}

export { setLogContext, logHook, logApiCall, logFlow, logAsync };

//# debugId=74CAA625EA43836764756E2164756E21
//# sourceMappingURL=chunk-94r8qs71.js.map
