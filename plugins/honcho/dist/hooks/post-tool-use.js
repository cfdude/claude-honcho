#!/usr/bin/env bun
import {
  redactSecrets
} from "../chunk-tcfez3z2.js";
import {
  require_dist
} from "../chunk-p7v70fg1.js";
import {
  visCaptureWithError
} from "../chunk-abmqmy2p.js";
import {
  logApiCall,
  logHook,
  setLogContext
} from "../chunk-94r8qs71.js";
import"../chunk-fe8crnvp.js";
import {
  __toESM,
  getCachedStdin,
  getClaudeInstanceId,
  getHonchoClientOptions,
  getSessionName,
  initHook,
  isPluginEnabled,
  loadConfig,
  readStdinText
} from "../chunk-er0jc8ja.js";

// src/hooks/post-tool-use.ts
var import_sdk = __toESM(require_dist(), 1);
function shouldLogTool(toolName, toolInput) {
  const significantTools = new Set(["Write", "Edit", "Bash", "Task", "NotebookEdit"]);
  if (!significantTools.has(toolName)) {
    return false;
  }
  if (toolName === "Bash") {
    const command = toolInput.command || "";
    const trivialCommands = ["cd", "ls", "pwd", "echo", "cat", "head", "tail", "which", "type", "git status", "git log", "git diff"];
    if (trivialCommands.some((cmd) => command.trim().startsWith(cmd))) {
      return false;
    }
  }
  return true;
}
function inferContentPurpose(content, filePath) {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  if (["ts", "tsx", "js", "jsx"].includes(ext)) {
    const exportMatch = content.match(/export\s+(default\s+)?(function|class|const|interface|type)\s+(\w+)/);
    if (exportMatch) {
      return `defines ${exportMatch[2]} ${exportMatch[3]}`;
    }
    const componentMatch = content.match(/(?:function|const)\s+(\w+).*(?:return|=>)\s*[(<]/);
    if (componentMatch) {
      return `component ${componentMatch[1]}`;
    }
  }
  if (ext === "py") {
    const classMatch = content.match(/class\s+(\w+)/);
    const defMatch = content.match(/def\s+(\w+)/);
    if (classMatch)
      return `defines class ${classMatch[1]}`;
    if (defMatch)
      return `defines function ${defMatch[1]}`;
  }
  if (["md", "mdx", "txt"].includes(ext)) {
    const headingMatch = content.match(/^#\s+(.+)$/m);
    if (headingMatch)
      return `doc: ${redactSecrets(headingMatch[1]).slice(0, 50)}`;
  }
  if (["json", "yaml", "yml", "toml"].includes(ext)) {
    return "config file";
  }
  const lineCount = content.split(`
`).length;
  return `${lineCount} lines`;
}
function summarizeEdit(oldStr, newStr, filePath) {
  const oldLines = oldStr.split(`
`).length;
  const newLines = newStr.split(`
`).length;
  if (oldStr.trim() === "") {
    const purpose = inferContentPurpose(newStr, filePath);
    return `added ${newLines} lines (${purpose})`;
  }
  if (newStr.trim() === "") {
    return `removed ${oldLines} lines`;
  }
  const oldTokens = oldStr.match(/\w+/g) ?? [];
  const newTokens = newStr.match(/\w+/g) ?? [];
  const oldSet = new Set(oldTokens);
  const newSet = new Set(newTokens);
  const added = newTokens.filter((t) => t.length > 2 && !oldSet.has(t));
  const removed = oldTokens.filter((t) => t.length > 2 && !newSet.has(t));
  if (added.length > 0 && removed.length > 0) {
    return `changed: ${removed.slice(0, 2).join(", ")} → ${added.slice(0, 2).join(", ")}`;
  }
  if (added.length > 0) {
    return `added: ${added.slice(0, 3).join(", ")}`;
  }
  if (removed.length > 0) {
    return `removed: ${removed.slice(0, 3).join(", ")}`;
  }
  const lineDiff = newLines - oldLines;
  if (lineDiff > 0)
    return `expanded by ${lineDiff} lines`;
  if (lineDiff < 0)
    return `reduced by ${-lineDiff} lines`;
  return `modified ${oldLines} lines`;
}
function formatToolSummary(toolName, toolInput, toolResponse) {
  return redactSecrets(buildToolSummary(toolName, toolInput, toolResponse));
}
function buildToolSummary(toolName, toolInput, toolResponse) {
  switch (toolName) {
    case "Write": {
      const filePath = toolInput.file_path || "unknown";
      const content = toolInput.content || "";
      const purpose = inferContentPurpose(content, filePath);
      const fileName = filePath.split("/").pop() || filePath;
      return `Wrote ${fileName} (${purpose})`;
    }
    case "Edit": {
      const filePath = toolInput.file_path || "unknown";
      const fileName = filePath.split("/").pop() || filePath;
      const oldStr = redactSecrets(toolInput.old_string || "");
      const newStr = redactSecrets(toolInput.new_string || "");
      const changeSummary = summarizeEdit(oldStr, newStr, filePath);
      return `Edited ${fileName}: ${changeSummary}`;
    }
    case "Bash": {
      const command = redactSecrets(toolInput.command || "").slice(0, 100);
      const success = !toolResponse.error;
      const cmdParts = command.split(/[;&|]/)[0].trim();
      if (["npm", "pnpm", "yarn", "bun"].some((pm) => command.includes(pm))) {
        const action = command.match(/(install|build|test|run|dev|start)/)?.[0] || "command";
        return `Package ${action}: ${success ? "success" : "failed"}`;
      }
      if (command.includes("git commit")) {
        const msg = command.match(/-m\s*["']([^"']+)["']/)?.[1] || "";
        return `Git commit: ${msg.slice(0, 50)}${msg.length > 50 ? "..." : ""}`;
      }
      if (command.includes("git push")) {
        return `Git push: ${success ? "success" : "failed"}`;
      }
      if (["curl", "wget", "fetch"].some((c) => command.includes(c))) {
        const url = command.match(/https?:\/\/[^\s"']+/)?.[0] || "";
        return `HTTP request to ${url.split("/")[2] || "API"}: ${success ? "success" : "failed"}`;
      }
      if (command.includes("docker") || command.includes("flyctl") || command.includes("fly ")) {
        return `Deploy: ${cmdParts.slice(0, 60)} (${success ? "success" : "failed"})`;
      }
      return `Ran: ${cmdParts.slice(0, 60)} (${success ? "success" : "failed"})`;
    }
    case "Task": {
      const desc = toolInput.description || "unknown";
      const type = toolInput.subagent_type || "";
      return `Agent task (${type}): ${desc}`;
    }
    case "NotebookEdit": {
      const notebookPath = toolInput.notebook_path || "unknown";
      const fileName = notebookPath.split("/").pop() || notebookPath;
      const editMode = toolInput.edit_mode || "replace";
      const cellType = toolInput.cell_type || "code";
      return `Notebook ${editMode} ${cellType} cell in ${fileName}`;
    }
    default:
      return `Used ${toolName}`;
  }
}
var UPLOAD_TIMEOUT_MS = 5000;
async function withUploadTimeout(p, ms) {
  let timer;
  try {
    return await Promise.race([
      p.catch((e) => ({ status: "error", error: `capture upload failed: ${e}` })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ status: "error", error: `capture upload timed out after ${ms}ms` }), ms);
      })
    ]);
  } finally {
    if (timer !== undefined)
      clearTimeout(timer);
  }
}
async function handlePostToolUse() {
  const hookStart = Date.now();
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
  } catch {
    process.exit(0);
  }
  const toolName = hookInput.tool_name || "";
  const toolInput = hookInput.tool_input || {};
  const toolResponse = hookInput.tool_response || {};
  const cwd = hookInput.workspace_roots?.[0] || hookInput.cwd || process.cwd();
  setLogContext(cwd, getSessionName(cwd));
  if (!shouldLogTool(toolName, toolInput)) {
    process.exit(0);
  }
  const summary = redactSecrets(formatToolSummary(toolName, toolInput, toolResponse), config.redactPatterns);
  logHook("post-tool-use", summary, { tool: toolName });
  const outcome = await withUploadTimeout(logToHonchoAsync(config, cwd, summary), UPLOAD_TIMEOUT_MS);
  if (outcome.status === "error") {
    logHook("post-tool-use", `Upload failed: ${outcome.error}`, { error: outcome.error });
  } else if (outcome.status === "skipped") {
    logHook("post-tool-use", `Upload skipped: ${outcome.reason}`, { skipped: outcome.reason });
  }
  visCaptureWithError(summary, outcome.status === "error" ? outcome.error : null, {
    uploaded: outcome.status === "uploaded",
    durationMs: Date.now() - hookStart
  });
  process.exit(0);
}
async function logToHonchoAsync(config, cwd, summary) {
  if (config.saveMessages === false) {
    return { status: "skipped", reason: "saveMessages is false" };
  }
  if (config.saveToolUse !== true) {
    return { status: "skipped", reason: "saveToolUse not enabled" };
  }
  const honcho = new import_sdk.Honcho(getHonchoClientOptions(config));
  const sessionName = getSessionName(cwd);
  const [session, aiPeer] = await Promise.all([
    honcho.session(sessionName),
    honcho.peer(config.aiPeer)
  ]);
  logApiCall("session.addMessages", "POST", `tool: ${summary.slice(0, 50)}`);
  const instanceId = getClaudeInstanceId();
  await session.addMessages([
    aiPeer.message(`[Tool] ${summary}`, {
      metadata: {
        instance_id: instanceId || undefined,
        session_affinity: sessionName
      }
    })
  ]);
  return { status: "uploaded" };
}

// hooks/post-tool-use.ts
await initHook();
await handlePostToolUse();

//# debugId=F6127B93DFF962F964756E2164756E21
//# sourceMappingURL=post-tool-use.js.map
