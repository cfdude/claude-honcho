// plugins/honcho/src/project-config.test.ts
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getProjectWorkspace } from "./project-config.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "honcho-proj-"));
}

test("returns null when no .honcho.json exists", () => {
  const root = tmp();
  const dir = join(root, "repo");
  mkdirSync(dir);
  expect(getProjectWorkspace(dir, root)).toBeNull();
  rmSync(root, { recursive: true, force: true });
});

test("reads workspace from .honcho.json in the cwd", () => {
  const root = tmp();
  const dir = join(root, "repo");
  mkdirSync(dir);
  writeFileSync(join(dir, ".honcho.json"), JSON.stringify({ workspace: "highway" }));
  expect(getProjectWorkspace(dir, root)).toBe("highway");
  rmSync(root, { recursive: true, force: true });
});

test("walks up to a parent .honcho.json from a subdirectory", () => {
  const root = tmp();
  const repo = join(root, "repo");
  const sub = join(repo, "projects", "maca");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(repo, ".honcho.json"), JSON.stringify({ workspace: "highway" }));
  expect(getProjectWorkspace(sub, root)).toBe("highway");
  rmSync(root, { recursive: true, force: true });
});

test("ignores a .honcho.json located at stopDir", () => {
  const root = tmp();
  const dir = join(root, "repo");
  mkdirSync(dir);
  writeFileSync(join(root, ".honcho.json"), JSON.stringify({ workspace: "highway" }));
  expect(getProjectWorkspace(dir, root)).toBeNull();
  rmSync(root, { recursive: true, force: true });
});

test("returns null for malformed JSON without throwing", () => {
  const root = tmp();
  const dir = join(root, "repo");
  mkdirSync(dir);
  writeFileSync(join(dir, ".honcho.json"), "{ not valid json");
  expect(getProjectWorkspace(dir, root)).toBeNull();
  rmSync(root, { recursive: true, force: true });
});

test("returns null when workspace key is missing or empty", () => {
  const root = tmp();
  const dir = join(root, "repo");
  mkdirSync(dir);
  writeFileSync(join(dir, ".honcho.json"), JSON.stringify({ aiPeer: "claude" }));
  expect(getProjectWorkspace(dir, root)).toBeNull();
  rmSync(root, { recursive: true, force: true });
});

test("a malformed child .honcho.json stops the walk (does NOT leak the parent's value)", () => {
  const root = tmp();
  const repo = join(root, "repo");
  const sub = join(repo, "sub");
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(repo, ".honcho.json"), JSON.stringify({ workspace: "highway" }));
  writeFileSync(join(sub, ".honcho.json"), "{ broken");
  // Deliberate semantics: the nearest file wins; an unusable nearest file
  // resolves to null rather than silently inheriting a parent's workspace.
  expect(getProjectWorkspace(sub, root)).toBeNull();
  rmSync(root, { recursive: true, force: true });
});
