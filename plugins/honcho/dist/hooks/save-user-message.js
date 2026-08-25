#!/usr/bin/env bun
// @bun
import {
  isHarnessInjected,
  isTerseReply
} from "../chunk-qh44saa8.js";
import"../chunk-49wja30f.js";
import {
  require_dist
} from "../chunk-p7v70fg1.js";
import"../chunk-abmqmy2p.js";
import"../chunk-xqbpafmf.js";
import {
  logApiCall,
  logHook,
  setLogContext
} from "../chunk-94r8qs71.js";
import"../chunk-fe8crnvp.js";
import {
  __require,
  __toESM,
  addMessagesBatched,
  chunkContent,
  getCachedStdin,
  getHonchoClientOptions,
  getInstanceIdForCwd,
  getProjectWorkspace,
  getSessionName,
  homeDirPath,
  isPluginEnabled,
  loadConfig,
  readStdinText
} from "../chunk-er0jc8ja.js";

// src/config.ts
import { join, basename, dirname, resolve, sep } from "path";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
var OUTPUT_LEVELS = ["verbose", "info", "error", "off"];
var DEFAULT_OUTPUT_LEVEL = "info";
function parseOutputLevel(value) {
  if (!value)
    return;
  return OUTPUT_LEVELS.includes(value) ? value : undefined;
}
var _detectedHost = null;
function setDetectedHost(host) {
  _detectedHost = host;
}
function getDetectedHost() {
  return _detectedHost ?? "claude_code";
}
function detectHost(stdinInput) {
  const envHost = process.env.HONCHO_HOST;
  if (envHost === "cursor" || envHost === "claude_code" || envHost === "obsidian")
    return envHost;
  if (stdinInput?.cursor_version)
    return "cursor";
  if (process.env.CURSOR_PROJECT_DIR)
    return "cursor";
  return "claude_code";
}
var DEFAULT_WORKSPACE = {
  cursor: "cursor",
  claude_code: "claude_code",
  obsidian: "obsidian"
};
var DEFAULT_AI_PEER = {
  cursor: "cursor",
  claude_code: "claude",
  obsidian: "honcho"
};
var _stdinText = null;
function cacheStdin(text) {
  _stdinText = text;
}
async function readStdinText2() {
  const chunks = [];
  for await (const chunk of process.stdin)
    chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}
async function initHook() {
  const stdinText = await readStdinText2();
  cacheStdin(stdinText);
  let input = {};
  try {
    input = JSON.parse(stdinText || "{}");
  } catch {
    process.exit(0);
  }
  if (input.cursor_version)
    process.exit(0);
  setDetectedHost(detectHost(input));
  try {
    const { setOutputLevel } = await import("../chunk-dsaahbm1.js");
    setOutputLevel(getOutputLevel(loadConfig2()));
  } catch {}
}
function configDirPath() {
  return join(homeDirPath(), ".honcho");
}
function configFilePath() {
  return join(configDirPath(), "config.json");
}
function configExists() {
  return existsSync(configFilePath());
}
function loadConfig2(host, cwd = process.cwd()) {
  const resolvedHost = host ?? getDetectedHost();
  if (configExists()) {
    try {
      const content = readFileSync(configFilePath(), "utf-8");
      const raw = JSON.parse(content);
      return resolveConfig(raw, resolvedHost, cwd);
    } catch {}
  }
  return loadConfigFromEnv(resolvedHost, cwd);
}
function resolveConfig(raw, host, cwd = process.cwd()) {
  const hostBlock = raw.hosts?.[host] ?? raw.hosts?.[host.replace(/_/g, "-")] ?? raw.hosts?.[host.replace(/-/g, "_")];
  const apiKey = process.env.HONCHO_API_KEY || hostBlock?.apiKey || raw.apiKey;
  if (!apiKey)
    return null;
  const peerName = raw.peerName || process.env.HONCHO_PEER_NAME || process.env.USER || process.env.USERNAME || "user";
  const projectWorkspace = getProjectWorkspace(cwd);
  const envWorkspace = process.env.HONCHO_WORKSPACE || undefined;
  let workspace;
  let aiPeer;
  if (raw.globalOverride === true) {
    workspace = envWorkspace ?? projectWorkspace ?? raw.workspace ?? DEFAULT_WORKSPACE[host];
    aiPeer = raw.aiPeer ?? hostBlock?.aiPeer ?? DEFAULT_AI_PEER[host];
  } else if (hostBlock) {
    workspace = envWorkspace ?? projectWorkspace ?? hostBlock.workspace ?? DEFAULT_WORKSPACE[host];
    aiPeer = hostBlock.aiPeer ?? DEFAULT_AI_PEER[host];
  } else {
    workspace = envWorkspace ?? projectWorkspace ?? raw.workspace ?? DEFAULT_WORKSPACE[host];
    if (host === "cursor") {
      aiPeer = raw.cursorPeer ?? DEFAULT_AI_PEER["cursor"];
    } else {
      aiPeer = raw.claudePeer ?? DEFAULT_AI_PEER["claude_code"];
    }
  }
  const config = {
    apiKey,
    peerName,
    workspace,
    aiPeer,
    sessionStrategy: hostBlock?.sessionStrategy ?? raw.sessionStrategy,
    sessionPeerPrefix: hostBlock?.sessionPeerPrefix ?? raw.sessionPeerPrefix,
    sessions: raw.sessions,
    saveMessages: hostBlock?.saveMessages ?? raw.saveMessages,
    saveToolUse: hostBlock?.saveToolUse ?? raw.saveToolUse,
    saveGitEvents: hostBlock?.saveGitEvents ?? raw.saveGitEvents,
    reasoningLevel: hostBlock?.reasoningLevel ?? raw.reasoningLevel,
    outputLevel: hostBlock?.outputLevel ?? raw.outputLevel ?? DEFAULT_OUTPUT_LEVEL,
    observationMode: hostBlock?.observationMode ?? raw.observationMode,
    messageUpload: hostBlock?.messageUpload ?? raw.messageUpload,
    contextRefresh: hostBlock?.contextRefresh ?? raw.contextRefresh,
    endpoint: hostBlock?.endpoint ?? raw.endpoint,
    redactPatterns: hostBlock?.redactPatterns ?? raw.redactPatterns,
    injection: hostBlock?.injection ?? raw.injection,
    rememberTool: hostBlock?.rememberTool ?? raw.rememberTool,
    enabled: hostBlock?.enabled ?? raw.enabled,
    logging: hostBlock?.logging ?? raw.logging,
    globalOverride: raw.globalOverride,
    accessClientId: raw.accessClientId,
    accessClientSecret: raw.accessClientSecret
  };
  return mergeWithEnvVars(config);
}
function loadConfigFromEnv(host, cwd) {
  const apiKey = process.env.HONCHO_API_KEY;
  if (!apiKey) {
    return null;
  }
  const resolvedHost = host ?? getDetectedHost();
  const peerName = process.env.HONCHO_PEER_NAME || process.env.USER || process.env.USERNAME || "user";
  const projectWorkspace = cwd ? getProjectWorkspace(cwd) : null;
  const workspace = process.env.HONCHO_WORKSPACE || projectWorkspace || DEFAULT_WORKSPACE[resolvedHost];
  const hostPeerEnv = resolvedHost === "cursor" ? process.env.HONCHO_CURSOR_PEER : process.env.HONCHO_CLAUDE_PEER;
  const aiPeer = process.env.HONCHO_AI_PEER || hostPeerEnv || DEFAULT_AI_PEER[resolvedHost];
  const endpoint = process.env.HONCHO_ENDPOINT;
  const config = {
    apiKey,
    peerName,
    workspace,
    aiPeer,
    saveMessages: process.env.HONCHO_SAVE_MESSAGES !== "false",
    saveToolUse: process.env.HONCHO_SAVE_TOOL_USE === "true",
    saveGitEvents: process.env.HONCHO_SAVE_GIT_EVENTS === "true",
    enabled: process.env.HONCHO_ENABLED !== "false",
    logging: process.env.HONCHO_LOGGING !== "false",
    outputLevel: parseOutputLevel(process.env.HONCHO_OUTPUT_LEVEL) ?? DEFAULT_OUTPUT_LEVEL
  };
  if (endpoint) {
    if (endpoint === "local") {
      config.endpoint = { environment: "local" };
    } else if (endpoint.startsWith("http")) {
      config.endpoint = { baseUrl: endpoint };
    }
  }
  return config;
}
function mergeWithEnvVars(config) {
  if (process.env.HONCHO_API_KEY) {
    config.apiKey = process.env.HONCHO_API_KEY;
  }
  if (process.env.HONCHO_PEER_NAME) {
    config.peerName = process.env.HONCHO_PEER_NAME;
  }
  if (process.env.HONCHO_ENABLED === "false") {
    config.enabled = false;
  }
  if (process.env.HONCHO_LOGGING === "false") {
    config.logging = false;
  }
  if (process.env.HONCHO_SAVE_TOOL_USE !== undefined) {
    config.saveToolUse = process.env.HONCHO_SAVE_TOOL_USE === "true";
  }
  if (process.env.HONCHO_SAVE_GIT_EVENTS !== undefined) {
    config.saveGitEvents = process.env.HONCHO_SAVE_GIT_EVENTS === "true";
  }
  const envOutputLevel = parseOutputLevel(process.env.HONCHO_OUTPUT_LEVEL);
  if (envOutputLevel) {
    config.outputLevel = envOutputLevel;
  }
  return config;
}
function getOutputLevel(config) {
  const resolved = (config === undefined ? loadConfig2() : config)?.outputLevel;
  return parseOutputLevel(resolved) ?? DEFAULT_OUTPUT_LEVEL;
}
var VALID_ENVIRONMENTS = new Set(["production", "local"]);

// src/hooks/save-user-message.ts
var import_sdk = __toESM(require_dist(), 1);
async function handleSaveUserMessage() {
  const config = loadConfig();
  if (!config) {
    process.exit(0);
  }
  if (!isPluginEnabled() || config.saveMessages === false) {
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
  const prompt = hookInput.prompt || "";
  if (!prompt.trim()) {
    process.exit(0);
  }
  const cwd = hookInput.workspace_roots?.[0] || hookInput.cwd || process.cwd();
  const instanceId = hookInput.session_id || getInstanceIdForCwd(cwd);
  const sessionName = getSessionName(cwd, instanceId || undefined);
  setLogContext(cwd, sessionName);
  if (isHarnessInjected(prompt)) {
    logHook("save-user-message", "Skipping upload (harness-injected content, not user input)");
    process.exit(0);
  }
  try {
    await postUserMessage(config, prompt, instanceId || undefined, sessionName);
  } catch (e) {
    logHook("save-user-message", `Upload failed: ${e}`);
  }
  process.exit(0);
}
async function postUserMessage(config, prompt, instanceId, sessionName) {
  const honcho = new import_sdk.Honcho(getHonchoClientOptions(config));
  const noEnsure = () => Promise.resolve();
  const userPeer = new import_sdk.Peer(config.peerName, honcho.workspaceId, honcho.http, undefined, undefined, noEnsure);
  const createdAt = new Date().toISOString();
  const configuration = isTerseReply(prompt) ? { reasoning: { enabled: false } } : undefined;
  const messages = chunkContent(prompt).map((chunk) => userPeer.message(chunk, {
    createdAt,
    metadata: {
      instance_id: instanceId || undefined,
      session_affinity: sessionName
    },
    ...configuration ? { configuration } : {}
  }));
  logApiCall("session.addMessages", "POST", `user prompt (${prompt.length} chars, ${messages.length} msg, direct)`);
  const session = new import_sdk.Session(sessionName, honcho.workspaceId, honcho.http, undefined, undefined, noEnsure);
  await addMessagesBatched(session, messages, (e) => {
    logHook("save-user-message", `Direct upload failed, retrying via get-or-create: ${e}`);
    return honcho.session(sessionName);
  });
}

// hooks/save-user-message.ts
await initHook();
await handleSaveUserMessage();

//# debugId=6A8817DCFC17CBD664756E2164756E21
//# sourceMappingURL=save-user-message.js.map
