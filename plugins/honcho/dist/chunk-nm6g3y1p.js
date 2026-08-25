import { createRequire } from "node:module";
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  if (mod && typeof mod === "object" || typeof mod === "function") {
    for (let key of __getOwnPropNames(mod))
      if (!__hasOwnProp.call(to, key))
        __defProp(to, key, {
          get: __accessProp.bind(mod, key),
          enumerable: true
        });
  }
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// src/git.ts
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";
function isGitRepo(cwd) {
  return existsSync(join(cwd, ".git"));
}
function gitCommand(cwd, args) {
  try {
    return execSync(`git ${args}`, { cwd, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return null;
  }
}
function captureGitState(cwd) {
  if (!isGitRepo(cwd)) {
    return null;
  }
  const branch = gitCommand(cwd, "rev-parse --abbrev-ref HEAD") || "unknown";
  const commit = gitCommand(cwd, "rev-parse --short HEAD") || "unknown";
  const commitMessage = gitCommand(cwd, "log -1 --format=%s") || "";
  const statusOutput = gitCommand(cwd, "status --porcelain") || "";
  const isDirty = statusOutput.length > 0;
  const dirtyFiles = isDirty ? statusOutput.split(`
`).filter((line) => line.trim()).map((line) => line.slice(3).trim()).slice(0, 20) : [];
  return {
    branch,
    commit,
    commitMessage,
    isDirty,
    dirtyFiles,
    timestamp: new Date().toISOString()
  };
}

// src/home.ts
import { homedir } from "node:os";
import { join as join2 } from "node:path";
function homeDirPath() {
  return process.env.HOME || homedir();
}
function honchoDir() {
  return join2(homeDirPath(), ".honcho");
}

// src/project-config.ts
import { existsSync as existsSync2, readFileSync } from "node:fs";
import { dirname, join as join3 } from "node:path";
function findProjectConfig(cwd, stopDir = homeDirPath()) {
  let dir = cwd;
  while (true) {
    if (dir === stopDir)
      break;
    const candidate = join3(dir, ".honcho.json");
    if (existsSync2(candidate)) {
      try {
        const raw = JSON.parse(readFileSync(candidate, "utf-8"));
        if (typeof raw.workspace === "string" && raw.workspace.length > 0) {
          return { workspace: raw.workspace, dir };
        }
      } catch {}
      return null;
    }
    const parent = dirname(dir);
    if (parent === dir)
      break;
    dir = parent;
  }
  return null;
}
function getProjectWorkspace(cwd, stopDir = homeDirPath()) {
  return findProjectConfig(cwd, stopDir)?.workspace ?? null;
}

// src/config.ts
import { join as join5, basename, dirname as dirname2, resolve, sep } from "path";
import { existsSync as existsSync4, mkdirSync as mkdirSync2, readFileSync as readFileSync3, statSync as statSync2, writeFileSync as writeFileSync2 } from "fs";

// src/cache.ts
import { join as join4 } from "path";
import {
  existsSync as existsSync3,
  readFileSync as readFileSync2,
  writeFileSync,
  mkdirSync
} from "fs";
function cacheDir() {
  return honchoDir();
}
function idCacheFile() {
  return join4(cacheDir(), "cache.json");
}
function ensureCacheDir() {
  const dir = cacheDir();
  if (!existsSync3(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
function loadIdCache() {
  ensureCacheDir();
  if (!existsSync3(idCacheFile())) {
    return {};
  }
  try {
    return JSON.parse(readFileSync2(idCacheFile(), "utf-8"));
  } catch {
    return {};
  }
}
function getClaudeInstanceId() {
  const cache = loadIdCache();
  return cache.claudeInstanceId || null;
}
function getInstanceIdForCwd(cwd) {
  const cache = loadIdCache();
  return cache.sessions?.[cwd]?.instanceId ?? null;
}
var CONTEXT_CACHE_KNOWN_KEYS = new Set([
  "claudeContext",
  "summaries",
  "messageCount"
]);
var MAX_MESSAGE_SIZE = 24000;
function chunkContent(content, maxSize = MAX_MESSAGE_SIZE) {
  if (content.length <= maxSize) {
    return [content];
  }
  const chunks = [];
  let remaining = content;
  while (remaining.length > 0) {
    if (remaining.length <= maxSize) {
      chunks.push(remaining);
      break;
    }
    let splitIndex = remaining.lastIndexOf(`
`, maxSize);
    if (splitIndex <= 0 || splitIndex < maxSize * 0.25) {
      splitIndex = remaining.lastIndexOf(" ", maxSize);
    }
    if (splitIndex <= 0 || splitIndex < maxSize * 0.25) {
      splitIndex = maxSize;
    }
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }
  if (chunks.length > 1) {
    return chunks.map((chunk, i) => `[Part ${i + 1}/${chunks.length}] ${chunk}`);
  }
  return chunks;
}
var HONCHO_MAX_BATCH = 100;
async function addMessagesBatched(session, messages, resolveFallback) {
  let active = session;
  let usedFallback = false;
  for (let i = 0;i < messages.length; i += HONCHO_MAX_BATCH) {
    const batch = messages.slice(i, i + HONCHO_MAX_BATCH);
    try {
      await active.addMessages(batch);
    } catch (e) {
      if (usedFallback || !resolveFallback)
        throw e;
      active = await resolveFallback(e);
      usedFallback = true;
      await active.addMessages(batch);
    }
  }
}

// src/config.ts
function sanitizeForSessionName(s) {
  return s.toLowerCase().replace(/[^a-z0-9-_]/g, "-");
}
var OUTPUT_LEVELS = ["verbose", "info", "error", "off"];
var DEFAULT_OUTPUT_LEVEL = "info";
function parseOutputLevel(value) {
  if (!value)
    return;
  return OUTPUT_LEVELS.includes(value) ? value : undefined;
}
var HONCHO_BASE_URLS = {
  production: "https://api.honcho.dev/v3",
  local: "http://localhost:8000/v3"
};
var _detectedHost = null;
function setDetectedHost(host) {
  _detectedHost = host;
}
function getDetectedHost() {
  return _detectedHost ?? "claude_code";
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
function configDirPath() {
  return join5(homeDirPath(), ".honcho");
}
function configFilePath() {
  return join5(configDirPath(), "config.json");
}
function getConfigDir() {
  return configDirPath();
}
function configExists() {
  return existsSync4(configFilePath());
}
function loadConfig(host, cwd = process.cwd()) {
  const resolvedHost = host ?? getDetectedHost();
  if (configExists()) {
    try {
      const content = readFileSync3(configFilePath(), "utf-8");
      const raw = JSON.parse(content);
      return resolveConfig(raw, resolvedHost, cwd);
    } catch {}
  }
  return loadConfigFromEnv(resolvedHost, cwd);
}
function getWorkspaceProvenance(cwd) {
  const cfg = loadConfig("claude_code", cwd);
  const workspace = cfg?.workspace ?? "";
  if (process.env.HONCHO_WORKSPACE) {
    return { workspace, source: "env" };
  }
  const found = findProjectConfig(cwd);
  if (found) {
    return { workspace, source: "project", path: found.dir };
  }
  return { workspace, source: "global" };
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
function resolveWorktreeMainRoot(dir) {
  try {
    const gitPath = join5(dir, ".git");
    if (!statSync2(gitPath).isFile())
      return null;
    const match = readFileSync3(gitPath, "utf-8").match(/^gitdir:\s*(.+?)\s*$/m);
    if (!match)
      return null;
    const gitdir = resolve(dir, match[1]);
    const idx = gitdir.lastIndexOf(`${sep}worktrees${sep}`);
    if (idx === -1)
      return null;
    const gitContainer = gitdir.slice(0, idx);
    if (basename(gitContainer) === ".git")
      return dirname2(gitContainer);
    if (gitContainer.endsWith(".git"))
      return gitContainer;
    return null;
  } catch {
    return null;
  }
}
var MAX_GIT_WALK_UP = 12;
function worktreeMainRootFor(cwd) {
  try {
    let dir = resolve(cwd);
    for (let i = 0;i < MAX_GIT_WALK_UP; i++) {
      if (existsSync4(join5(dir, ".git")))
        return resolveWorktreeMainRoot(dir);
      const parent = dirname2(dir);
      if (parent === dir)
        break;
      dir = parent;
    }
  } catch {}
  return null;
}
function getSessionForPath(cwd, mainRoot) {
  const config = loadConfig();
  if (!config?.sessions)
    return null;
  if (config.sessions[cwd])
    return config.sessions[cwd];
  const mr = mainRoot === undefined ? worktreeMainRootFor(cwd) : mainRoot;
  if (mr && config.sessions[mr])
    return config.sessions[mr];
  return null;
}
function deriveSessionName(strategy, cwd, opts = {}) {
  const usePrefix = opts.sessionPeerPrefix !== false;
  const peerPart = opts.peerName ? sanitizeForSessionName(opts.peerName) : "user";
  const repoPart = sanitizeForSessionName(basename(cwd));
  const base = usePrefix ? `${peerPart}-${repoPart}` : repoPart;
  switch (strategy) {
    case "git-branch": {
      if (opts.branch) {
        const branchPart = sanitizeForSessionName(opts.branch);
        return `${base}-${branchPart}`;
      }
      return base;
    }
    case "chat-instance": {
      if (opts.instanceId) {
        return usePrefix ? `${peerPart}-chat-${opts.instanceId}` : `chat-${opts.instanceId}`;
      }
      return base;
    }
    case "per-directory":
    default:
      return base;
  }
}
function getSessionName(cwd, instanceId) {
  const config = loadConfig();
  const strategy = config?.sessionStrategy ?? "per-directory";
  const mainRoot = worktreeMainRootFor(cwd);
  if (strategy === "per-directory") {
    const configuredSession = getSessionForPath(cwd, mainRoot);
    if (configuredSession) {
      return configuredSession;
    }
  }
  let branch;
  if (strategy === "git-branch") {
    branch = captureGitState(cwd)?.branch;
  }
  let resolvedInstanceId;
  if (strategy === "chat-instance") {
    resolvedInstanceId = instanceId || getInstanceIdForCwd(cwd) || getClaudeInstanceId() || undefined;
  }
  return deriveSessionName(strategy, mainRoot ?? cwd, {
    peerName: config?.peerName,
    sessionPeerPrefix: config?.sessionPeerPrefix,
    branch,
    instanceId: resolvedInstanceId
  });
}
function isLoggingEnabled() {
  const config = loadConfig();
  return config?.logging !== false;
}
function getHonchoBaseUrlForEndpoint(endpoint) {
  if (endpoint?.baseUrl) {
    const url = endpoint.baseUrl;
    return url.endsWith("/v3") ? url : `${url}/v3`;
  }
  if (endpoint?.environment === "local") {
    return HONCHO_BASE_URLS.local;
  }
  return HONCHO_BASE_URLS.production;
}
function getHonchoBaseUrl(config) {
  return getHonchoBaseUrlForEndpoint(config.endpoint);
}
function getHonchoClientOptions(config) {
  const options = {
    apiKey: config.apiKey,
    baseURL: getHonchoBaseUrl(config),
    workspaceId: config.workspace,
    timeout: 120000,
    maxRetries: 1
  };
  if (config.accessClientId && config.accessClientSecret) {
    options.defaultHeaders = {
      "CF-Access-Client-Id": config.accessClientId,
      "CF-Access-Client-Secret": config.accessClientSecret
    };
  }
  return options;
}
function getEndpointInfo(config) {
  if (config.endpoint?.baseUrl) {
    return { type: "custom", url: config.endpoint.baseUrl };
  }
  if (config.endpoint?.environment === "local") {
    return { type: "local", url: HONCHO_BASE_URLS.local };
  }
  return { type: "production", url: HONCHO_BASE_URLS.production };
}
var VALID_ENVIRONMENTS = new Set(["production", "local"]);
function getObservationMode(config) {
  return config.observationMode ?? "unified";
}

export { __toESM, __commonJS, __require, captureGitState, homeDirPath, honchoDir, findProjectConfig, getProjectWorkspace, DEFAULT_OUTPUT_LEVEL, setDetectedHost, getConfigDir, loadConfig, getWorkspaceProvenance, deriveSessionName, getSessionName, isLoggingEnabled, getHonchoClientOptions, getEndpointInfo, getObservationMode, getClaudeInstanceId, getInstanceIdForCwd, chunkContent, addMessagesBatched };

//# debugId=C6B70E5D5808C8B364756E2164756E21
//# sourceMappingURL=chunk-nm6g3y1p.js.map
