// plugins/honcho/src/project-config.ts
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Walk up from `cwd` to the nearest `.honcho.json` and return both the workspace
 * and the directory containing the usable file.
 * Returns null when none is found, or when the nearest present file is missing/
 * empty/malformed or lacks a non-empty string `workspace`. Never throws.
 *
 * The search excludes `stopDir` (default: the user's home directory) and any
 * ancestor of it, so a `.honcho.json` placed directly in $HOME does not become
 * an accidental global override.
 *
 * This is the single canonical walk used by both getProjectWorkspace() and
 * getWorkspaceProvenance() so that resolution and provenance reporting are
 * always in agreement.
 */
export function findProjectConfig(cwd: string, stopDir: string = homedir()): { workspace: string; dir: string } | null {
  let dir = cwd;
  while (true) {
    if (dir === stopDir) break;
    const candidate = join(dir, ".honcho.json");
    if (existsSync(candidate)) {
      try {
        const raw = JSON.parse(readFileSync(candidate, "utf-8")) as { workspace?: unknown };
        if (typeof raw.workspace === "string" && raw.workspace.length > 0) {
          return { workspace: raw.workspace, dir };
        }
      } catch {
        // malformed/unreadable -> treat as no override
      }
      return null; // a present-but-unusable file stops the walk (don't leak a parent's)
    }
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Walk up from `cwd` to the nearest `.honcho.json` and return its `workspace`.
 * Returns null when none is found, or when the file is missing/empty/malformed
 * or lacks a non-empty string `workspace`. Never throws.
 *
 * The search excludes `stopDir` (default: the user's home directory) and any
 * ancestor of it, so a `.honcho.json` placed directly in $HOME does not become
 * an accidental global override.
 */
export function getProjectWorkspace(cwd: string, stopDir: string = homedir()): string | null {
  return findProjectConfig(cwd, stopDir)?.workspace ?? null;
}
