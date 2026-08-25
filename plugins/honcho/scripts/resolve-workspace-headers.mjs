#!/usr/bin/env node
/**
 * headersHelper for an HTTP-transport Honcho MCP server.
 *
 * WHY THIS EXISTS: the stdio MCP server gets workspace identity for free — one
 * process per Claude Code session means process.cwd() is unambiguous. That is
 * also why there are ~27 of them and ~969 MB of RAM. An HTTP server is shared,
 * so identity has to travel per connection instead. Claude Code runs this
 * command at CONNECT time, in the session's working directory, and merges the
 * JSON on stdout into the connection headers.
 *
 * It MUST agree with src/project-config.ts and src/config.ts, or a Highway repo
 * silently writes into the personal workspace. Three rules, in order:
 *
 *   1. HONCHO_WORKSPACE env wins outright (per-invocation override).
 *   2. Otherwise walk up from cwd for a `.honcho.json` with a non-empty string
 *      `workspace`, stopping at $HOME.
 *   3. Otherwise the global default from ~/.honcho/config.json, else "personal".
 *
 * SECURITY PROPERTY worth preserving deliberately: a `.honcho.json` that exists
 * but is unreadable/unparseable/lacks a usable workspace STOPS the walk and
 * yields null — it does not keep climbing and inherit a parent directory's
 * workspace. Leaking a parent's workspace is the exact failure this guards.
 *
 * Output is JSON on stdout and nothing else. Any diagnostic goes to stderr;
 * stdout is parsed as headers.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

const home = process.env.HOME || homedir();

/** Mirrors findProjectConfig() in src/project-config.ts. */
function findProjectWorkspace(startDir, stopDir) {
  let dir = startDir;
  while (true) {
    const candidate = join(dir, ".honcho.json");
    let raw;
    try {
      raw = JSON.parse(readFileSync(candidate, "utf-8"));
    } catch (e) {
      // ENOENT means "not here, keep looking". Anything else means the file is
      // present but unusable — stop, do NOT inherit a parent's workspace.
      if (e && e.code === "ENOENT") {
        if (dir === stopDir) return null;
        const parent = dirname(dir);
        if (parent === dir) return null;
        dir = parent;
        continue;
      }
      return null;
    }
    if (typeof raw.workspace === "string" && raw.workspace.length > 0) return raw.workspace;
    return null; // present but no usable workspace — same stop rule
  }
}

function globalDefault() {
  try {
    const cfg = JSON.parse(readFileSync(join(home, ".honcho", "config.json"), "utf-8"));
    const ws = cfg.workspace ?? cfg?.hosts?.claude_code?.workspace;
    if (typeof ws === "string" && ws.length > 0) return ws;
  } catch {
    /* fall through to the built-in default */
  }
  return "personal";
}

const workspace =
  (process.env.HONCHO_WORKSPACE && process.env.HONCHO_WORKSPACE.trim()) ||
  findProjectWorkspace(process.cwd(), home) ||
  globalDefault();

const headers = { "X-Honcho-Workspace-ID": workspace };

// The API key is read from the same config the hooks use, so HTTP and hook
// transports cannot drift onto different credentials.
try {
  const cfg = JSON.parse(readFileSync(join(home, ".honcho", "config.json"), "utf-8"));
  const key = cfg.apiKey ?? cfg?.hosts?.claude_code?.apiKey;
  if (typeof key === "string" && key.length > 0) headers.Authorization = `Bearer ${key}`;
} catch {
  /* no key: the server will reject with a clear message rather than us guessing */
}

process.stdout.write(JSON.stringify(headers));
