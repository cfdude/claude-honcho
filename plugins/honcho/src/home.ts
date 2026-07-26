// plugins/honcho/src/home.ts
//
// The single definition of "where is the user's home directory" for this plugin.
//
// This module MUST import nothing but `node:os` and `node:path`. It is imported by
// the lowest-level modules (config, cache, log, state, visual, project-config), so
// any additional dependency risks an import cycle.
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The user's home directory, honoring $HOME.
 *
 * Node's os.homedir() returns $HOME when set; Bun's reads the passwd entry and
 * IGNORES $HOME. Every ~/.honcho path in this plugin resolves through this helper
 * so behavior is identical on both runtimes — and so the plugin can never end up
 * half-relocated, reading config.json + the sessions map from one .honcho directory
 * while writing cache.json / state-*.json / activity.log to another.
 *
 * `||` (not `??`) so an exported-but-empty `HOME=` falls back to homedir() rather
 * than producing a rootward path like "/.honcho".
 */
export function homeDirPath(): string {
  return process.env.HOME || homedir();
}

/**
 * The plugin's `~/.honcho` directory, resolved lazily at call time (not captured
 * into a module-level const) so it honors a `HOME` redirected after this module
 * was imported — e.g. by tests.
 */
export function honchoDir(): string {
  return join(homeDirPath(), ".honcho");
}
