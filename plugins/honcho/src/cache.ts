import { join } from "path";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  appendFileSync,
  renameSync,
  unlinkSync,
  statSync,
} from "fs";
import { getContextRefreshConfig, getLocalContextConfig } from "./config.js";
import { honchoDir } from "./home.js";

// Lazily resolved (not module-level consts) so a `HOME` redirected after import
// (e.g. by tests) is honored — see home.ts's honchoDir().
function cacheDir(): string {
  return honchoDir();
}
function idCacheFile(): string {
  return join(cacheDir(), "cache.json");
}
function contextCacheFile(): string {
  return join(cacheDir(), "context-cache.json");
}
function claudeContextFile(): string {
  return join(cacheDir(), "claude-context.md");
}

// Ensure cache directory exists
function ensureCacheDir(): void {
  const dir = cacheDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// ============================================
// ID Cache - workspace, session, peer IDs
// ============================================

interface IdCache {
  workspace?: { name: string; id: string };
  peers?: Record<string, string>; // peerName -> peerId
  sessions?: Record<string, { name: string; id: string; updatedAt: string; instanceId?: string }>; // cwd -> session info
  claudeInstanceId?: string; // DEPRECATED: use per-cwd instanceId in sessions map instead
}

export function loadIdCache(): IdCache {
  ensureCacheDir();
  if (!existsSync(idCacheFile())) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(idCacheFile(), "utf-8"));
  } catch {
    return {};
  }
}

export function saveIdCache(cache: IdCache): void {
  ensureCacheDir();
  writeFileSync(idCacheFile(), JSON.stringify(cache, null, 2));
}

export function getCachedWorkspaceId(workspaceName: string): string | null {
  const cache = loadIdCache();
  if (cache.workspace?.name === workspaceName) {
    return cache.workspace.id;
  }
  return null;
}

export function setCachedWorkspaceId(name: string, id: string): void {
  const cache = loadIdCache();
  cache.workspace = { name, id };
  saveIdCache(cache);
}

export function getCachedPeerId(peerName: string): string | null {
  const cache = loadIdCache();
  return cache.peers?.[peerName] || null;
}

export function setCachedPeerId(peerName: string, peerId: string): void {
  const cache = loadIdCache();
  if (!cache.peers) cache.peers = {};
  cache.peers[peerName] = peerId;
  saveIdCache(cache);
}

export function getCachedSessionId(cwd: string): string | null {
  const cache = loadIdCache();
  return cache.sessions?.[cwd]?.id || null;
}

export function setCachedSessionId(cwd: string, name: string, id: string, instanceId?: string): void {
  const cache = loadIdCache();
  if (!cache.sessions) cache.sessions = {};
  cache.sessions[cwd] = { name, id, updatedAt: new Date().toISOString(), instanceId };
  saveIdCache(cache);
}

/** Find the most recently active CWD from cached sessions (fallback for MCP servers without project dir) */
export function getLastActiveCwd(): string | null {
  const cache = loadIdCache();
  if (!cache.sessions) return null;
  let latest: { cwd: string; updatedAt: string } | null = null;
  for (const [cwd, entry] of Object.entries(cache.sessions)) {
    if (!latest || entry.updatedAt > latest.updatedAt) {
      latest = { cwd, updatedAt: entry.updatedAt };
    }
  }
  return latest?.cwd || null;
}

// Claude instance tracking for parallel session support
export function getClaudeInstanceId(): string | null {
  const cache = loadIdCache();
  return cache.claudeInstanceId || null;
}

export function setClaudeInstanceId(instanceId: string): void {
  const cache = loadIdCache();
  cache.claudeInstanceId = instanceId;
  saveIdCache(cache);
}

/** Get the instance ID stored for a specific cwd (scoped, no cross-session collision) */
export function getInstanceIdForCwd(cwd: string): string | null {
  const cache = loadIdCache();
  return cache.sessions?.[cwd]?.instanceId ?? null;
}

// ============================================
// Context Cache - user + claude context with TTL
// ============================================

interface ContextCache {
  userContext?: { data: any; fetchedAt: number };
  claudeContext?: { data: any; fetchedAt: number };
  summaries?: { data: any; fetchedAt: number };
  messageCount?: number; // Track messages since last refresh
}

// Now configurable via config.json, with defaults in getContextRefreshConfig()
function getContextTTL(): number {
  const config = getContextRefreshConfig();
  return (config.ttlSeconds ?? 300) * 1000; // Convert to ms
}

// Known keys in ContextCache — anything else is a ghost from older versions
const CONTEXT_CACHE_KNOWN_KEYS = new Set([
  "claudeContext", "summaries", "messageCount",
]);

export function loadContextCache(): ContextCache {
  ensureCacheDir();
  if (!existsSync(contextCacheFile())) {
    return {};
  }
  try {
    const raw = JSON.parse(readFileSync(contextCacheFile(), "utf-8"));
    // Strip ghost keys left by older plugin versions (e.g. "aiContext")
    let cleaned = false;
    for (const key of Object.keys(raw)) {
      if (!CONTEXT_CACHE_KNOWN_KEYS.has(key)) {
        delete raw[key];
        cleaned = true;
      }
    }
    if (cleaned) {
      writeFileSync(contextCacheFile(), JSON.stringify(raw, null, 2));
    }
    return raw;
  } catch {
    return {};
  }
}

export function saveContextCache(cache: ContextCache): void {
  ensureCacheDir();
  writeFileSync(contextCacheFile(), JSON.stringify(cache, null, 2));
}

export function getCachedClaudeContext(): any | null {
  const cache = loadContextCache();
  if (cache.claudeContext && Date.now() - cache.claudeContext.fetchedAt < getContextTTL()) {
    return cache.claudeContext.data;
  }
  return null;
}

export function setCachedClaudeContext(data: any): void {
  const cache = loadContextCache();
  cache.claudeContext = { data, fetchedAt: Date.now() };
  saveContextCache(cache);
}

// Track message count for threshold-based refresh
export function incrementMessageCount(): number {
  const cache = loadContextCache();
  cache.messageCount = (cache.messageCount || 0) + 1;
  saveContextCache(cache);
  return cache.messageCount;
}

export function getMessageCount(): number {
  const cache = loadContextCache();
  return cache.messageCount || 0;
}

export function resetMessageCount(): void {
  const cache = loadContextCache();
  cache.messageCount = 0;
  saveContextCache(cache);
}

// ============================================
// CLAUDE Context File - self-summary
// ============================================

export function getClaudeContextPath(): string {
  return claudeContextFile();
}

export function loadClaudeLocalContext(): string {
  ensureCacheDir();
  if (!existsSync(claudeContextFile())) {
    return "";
  }
  try {
    return readFileSync(claudeContextFile(), "utf-8");
  } catch {
    return "";
  }
}

// No trailing newline: every entry begins with "\n", and the pre-existing file
// shape had no blank line between the heading and the first entry.
const CLAUDE_CONTEXT_HEADER = `# CLAUDE Work Context\n\nAuto-generated log of CLAUDE's recent work.\n\n## Recent Activity`;

/**
 * Overwrite claude-context.md ATOMICALLY: write a uniquely-named temp file in
 * the SAME directory (rename is only atomic within one filesystem), then
 * renameSync over the target. A plain writeFileSync truncates first, so a reader
 * — or a crash — landing mid-write saw a torn/empty file. ~15 concurrent Claude
 * Code sessions all fire post-tool-use, so this is a real interleaving, not a
 * theoretical one.
 *
 * The temp file is unlinked on failure so a dead write can never leave
 * `claude-context.md.tmp-*` litter in ~/.honcho.
 */
export function saveClaudeLocalContext(content: string): void {
  ensureCacheDir();
  const target = claudeContextFile();
  // Resolved lazily inside the function (never a module-level const) so a
  // redirected HOME is honored — see home.ts's honchoDir().
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, target);
  } catch (e) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // best-effort cleanup; the original error is what matters
    }
    throw e;
  }
}

/**
 * Append one activity entry, then trim the file back to `maxEntries`.
 *
 * Concurrency guarantees (this used to be a plain read-modify-write — full read,
 * in-memory rewrite, full overwrite — so with ~15 concurrent sessions the
 * interleaving A-read/B-read/A-write/B-write silently dropped A's entry):
 *
 *  - **No corruption, ever.** The entry goes on with O_APPEND (`appendFileSync`),
 *    which the OS applies at the current end of file, so two concurrent appends
 *    can neither interleave within a line nor overwrite each other. The trim
 *    rewrite goes through saveClaudeLocalContext()'s temp-file + rename, so a
 *    reader sees either the old file or the new one, never a partial one.
 *  - **No lost appends on the hot path.** The common case (file exists, under the
 *    entry cap) is append-only — nothing is read, so nothing can be clobbered.
 *  - **Narrow lost-entry window in two cold paths, by design.** (a) Cold start
 *    writes header+first entry in a single exclusive (`wx`) create, so a losing
 *    racer falls through to a plain append instead of clobbering. (b) The trim
 *    rewrite re-checks the file size right before renaming and retries if it
 *    changed; a concurrent append inside that last sliver can still be dropped.
 *
 * A lockfile was deliberately NOT used: a hook killed mid-write would strand the
 * lock and break memory capture for every session — far worse than occasionally
 * losing one cache entry.
 */
export function appendClaudeWork(workDescription: string): void {
  ensureCacheDir();
  const target = claudeContextFile();
  const timestamp = new Date().toISOString();
  const entry = `\n- [${timestamp}] ${workDescription}`;

  // Cold start: create header + this entry in ONE exclusive write. Doing the
  // header and the entry as separate calls would let a concurrent append land
  // bytes before the header did. A writer that loses the `wx` race falls
  // through to a plain append, so no entry is lost.
  let created = false;
  if (!existsSync(target)) {
    try {
      writeFileSync(target, CLAUDE_CONTEXT_HEADER + entry, { flag: "wx" });
      created = true;
    } catch {
      // Another process won the create race — fall through and append instead.
    }
  }

  if (!created) {
    // An EMPTY (or header-less) file must be re-headered, not just appended to:
    // the old truncate-then-write left a zero-byte file behind whenever a hook
    // was killed mid-write, and without the header the trim below can never find
    // "## Recent Activity" — so the file would grow forever. The old code got
    // this for free because loadClaudeLocalContext() returns "" for a missing
    // OR empty OR unreadable file and the header was rebuilt in all three cases.
    // Appending header+entry (rather than overwriting) keeps the no-lost-entry
    // property intact even if a racer appends at the same moment.
    let needsHeader = false;
    try {
      needsHeader = statSync(target).size === 0 || !loadClaudeLocalContext().includes("## Recent Activity");
    } catch {
      needsHeader = false;
    }
    appendFileSync(target, needsHeader ? CLAUDE_CONTEXT_HEADER + entry : entry);
  }

  // Keep only the last N entries so the file can't grow without bound.
  let maxEntries = getLocalContextConfig().maxEntries;
  if (!maxEntries) {
    maxEntries = 10;
  }

  // Retry-on-change: if the file grew between the read and the rename, another
  // session appended and our rewrite would drop it — re-read and try again.
  for (let attempt = 0; attempt < 3; attempt++) {
    let sizeBefore: number;
    try {
      sizeBefore = statSync(target).size;
    } catch {
      return;
    }

    const existing = loadClaudeLocalContext();
    const lines = existing.split("\n");
    const activityStart = lines.findIndex((l) => l.includes("## Recent Activity"));
    if (activityStart === -1) return;

    const header = lines.slice(0, activityStart + 1);
    const activities = lines.slice(activityStart + 1).filter((l) => l.trim());
    if (activities.length <= maxEntries) return; // nothing to trim — the hot path

    const trimmed = [...header, ...activities.slice(-maxEntries)].join("\n");

    let sizeNow: number;
    try {
      sizeNow = statSync(target).size;
    } catch {
      return;
    }
    if (sizeNow !== sizeBefore) continue; // someone appended; re-read and retry

    saveClaudeLocalContext(trimmed);
    return;
  }
}

// ============================================
// Git State Cache - track git state per directory
// ============================================

function gitStateFile(): string {
  return join(cacheDir(), "git-state.json");
}

export interface GitState {
  branch: string;
  commit: string; // Short SHA
  commitMessage: string;
  isDirty: boolean;
  dirtyFiles: string[];
  timestamp: string;
}

interface GitStateCache {
  [cwd: string]: GitState;
}

export function loadGitStateCache(): GitStateCache {
  ensureCacheDir();
  if (!existsSync(gitStateFile())) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(gitStateFile(), "utf-8"));
  } catch {
    return {};
  }
}

export function saveGitStateCache(cache: GitStateCache): void {
  ensureCacheDir();
  writeFileSync(gitStateFile(), JSON.stringify(cache, null, 2));
}

export function getCachedGitState(cwd: string): GitState | null {
  const cache = loadGitStateCache();
  return cache[cwd] || null;
}

export function setCachedGitState(cwd: string, state: GitState): void {
  const cache = loadGitStateCache();
  cache[cwd] = state;
  saveGitStateCache(cache);
}

export interface GitFeatureContext {
  type: "feature" | "fix" | "refactor" | "docs" | "test" | "chore" | "unknown";
  description: string;
  keywords: string[];
  areas: string[]; // e.g., ["api", "auth", "ui"]
  confidence: "high" | "medium" | "low";
}

export interface GitStateChange {
  type: "branch_switch" | "new_commits" | "files_changed" | "initial";
  description: string;
  from?: string;
  to?: string;
}

export function detectGitChanges(previous: GitState | null, current: GitState): GitStateChange[] {
  const changes: GitStateChange[] = [];

  if (!previous) {
    changes.push({
      type: "initial",
      description: `Session started on branch '${current.branch}' at ${current.commit}`,
    });
    return changes;
  }

  // Branch switch
  if (previous.branch !== current.branch) {
    changes.push({
      type: "branch_switch",
      description: `Branch switched from '${previous.branch}' to '${current.branch}'`,
      from: previous.branch,
      to: current.branch,
    });
  }

  // New commits (different SHA on same branch, or any commit change)
  if (previous.commit !== current.commit) {
    changes.push({
      type: "new_commits",
      description: `New commit: ${current.commit} - ${current.commitMessage}`,
      from: previous.commit,
      to: current.commit,
    });
  }

  // Dirty state changed
  if (!previous.isDirty && current.isDirty) {
    changes.push({
      type: "files_changed",
      description: `Uncommitted changes detected: ${current.dirtyFiles.slice(0, 5).join(", ")}${current.dirtyFiles.length > 5 ? "..." : ""}`,
    });
  }

  return changes;
}

// ============================================
// Message Chunking - split large messages for API limits
// ============================================

// Under Honcho's 25k-char per-message cap, with headroom for the [Part i/N] prefix.
const MAX_MESSAGE_SIZE = 24000;

export function chunkContent(content: string, maxSize: number = MAX_MESSAGE_SIZE): string[] {
  if (content.length <= maxSize) {
    return [content];
  }

  const chunks: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxSize) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline boundary
    let splitIndex = remaining.lastIndexOf('\n', maxSize);
    if (splitIndex <= 0 || splitIndex < maxSize * 0.25) {
      // No good newline boundary, split at space
      splitIndex = remaining.lastIndexOf(' ', maxSize);
    }
    if (splitIndex <= 0 || splitIndex < maxSize * 0.25) {
      // No good boundary, hard split
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

export const HONCHO_MAX_BATCH = 100;

type SessionLike = { addMessages: (messages: any[]) => Promise<unknown> };

/**
 * Upload messages, split across calls of ≤100 to stay under Honcho's batch cap.
 *
 * When `resolveFallback` is given, a batch failure resolves an alternate session
 * once and retries only the failed batch (and any remaining ones) on it. This
 * lets callers front a fast noEnsure session and fall back to get-or-create
 * without ever replaying batches the first session already accepted.
 */
export async function addMessagesBatched(
  session: SessionLike,
  messages: any[],
  resolveFallback?: (error: unknown) => Promise<SessionLike>,
): Promise<void> {
  let active = session;
  let usedFallback = false;
  for (let i = 0; i < messages.length; i += HONCHO_MAX_BATCH) {
    const batch = messages.slice(i, i + HONCHO_MAX_BATCH);
    try {
      await active.addMessages(batch);
    } catch (e) {
      if (usedFallback || !resolveFallback) throw e;
      active = await resolveFallback(e);
      usedFallback = true;
      await active.addMessages(batch);
    }
  }
}

// ============================================
// Utility: Clear all caches (for debugging)
// ============================================

export function clearAllCaches(): void {
  ensureCacheDir();
  if (existsSync(idCacheFile())) writeFileSync(idCacheFile(), "{}");
  if (existsSync(contextCacheFile())) writeFileSync(contextCacheFile(), "{}");
  if (existsSync(gitStateFile())) writeFileSync(gitStateFile(), "{}");
  // Don't clear claude-context.md - that's valuable history
}

/** Clear only the ID cache (workspace, peer, session IDs) */
export function clearIdCache(): void {
  ensureCacheDir();
  writeFileSync(idCacheFile(), "{}");
}

/** Clear only peer IDs from the ID cache */
export function clearPeerCache(): void {
  const cache = loadIdCache();
  delete cache.peers;
  saveIdCache(cache);
}

/** Clear only userContext from the context cache */
export function clearUserContextOnly(): void {
  const cache = loadContextCache();
  delete cache.userContext;
  saveContextCache(cache);
}

/** Clear only claudeContext from the context cache */
export function clearClaudeContextOnly(): void {
  const cache = loadContextCache();
  delete cache.claudeContext;
  saveContextCache(cache);
}
