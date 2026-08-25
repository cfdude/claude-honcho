#!/usr/bin/env bun
import {
  clearSessionFiles
} from "../chunk-xqbpafmf.js";
import {
  logHook,
  setLogContext
} from "../chunk-94r8qs71.js";
import"../chunk-fe8crnvp.js";
import {
  getCachedStdin,
  getInstanceIdForCwd,
  getSessionName,
  initHook,
  isPluginEnabled,
  loadConfig,
  readStdinText
} from "../chunk-er0jc8ja.js";

// src/hooks/session-end.ts
async function handleSessionEnd() {
  const config = loadConfig();
  if (!config) {
    process.exit(0);
  }
  if (!isPluginEnabled()) {
    process.exit(0);
  }
  let hookInput = {};
  try {
    const input = getCachedStdin() ?? await readStdinText();
    if (input.trim()) {
      hookInput = JSON.parse(input);
    }
  } catch {}
  const cwd = hookInput.workspace_roots?.[0] || hookInput.cwd || process.cwd();
  const reason = hookInput.reason || "unknown";
  const instanceId = hookInput.session_id || getInstanceIdForCwd(cwd);
  const sessionName = getSessionName(cwd, instanceId || undefined);
  setLogContext(cwd, sessionName);
  logHook("session-end", `Session ending`, { reason });
  clearSessionFiles(hookInput.session_id);
  logHook("session-end", "Session ended — no upload (messages saved live)");
  process.exit(0);
}

// hooks/session-end.ts
await initHook();
await handleSessionEnd();

//# debugId=617B13E1E180C0F664756E2164756E21
//# sourceMappingURL=session-end.js.map
