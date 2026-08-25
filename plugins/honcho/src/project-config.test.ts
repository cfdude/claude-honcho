import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProjectConfig, getProjectWorkspace } from "./project-config.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "honcho-proj-"));
}

test("finds .honcho.json in the starting directory", () => {
  const dir = tmp();
  writeFileSync(join(dir, ".honcho.json"), JSON.stringify({ workspace: "highway" }));
  expect(getProjectWorkspace(dir)).toBe("highway");
  expect(findProjectConfig(dir)?.dir).toBe(dir);
});

test("walks up to an ancestor .honcho.json", () => {
  const root = tmp();
  writeFileSync(join(root, ".honcho.json"), JSON.stringify({ workspace: "highway" }));
  const nested = join(root, "a", "b");
  mkdirSync(nested, { recursive: true });
  expect(getProjectWorkspace(nested)).toBe("highway");
  expect(findProjectConfig(nested)?.dir).toBe(root);
});

test("returns null when no .honcho.json exists anywhere up the tree", () => {
  const dir = tmp();
  expect(getProjectWorkspace(dir)).toBeNull();
  expect(findProjectConfig(dir)).toBeNull();
});

test("a present-but-unusable file stops the walk (does not leak a parent's workspace)", () => {
  const root = tmp();
  writeFileSync(join(root, ".honcho.json"), JSON.stringify({ workspace: "highway" }));
  const child = join(root, "child");
  mkdirSync(child, { recursive: true });
  writeFileSync(join(child, ".honcho.json"), "{ this is not valid json");
  expect(getProjectWorkspace(child)).toBeNull();
});

test("ignores a file whose workspace is missing or not a non-empty string", () => {
  const d1 = tmp();
  writeFileSync(join(d1, ".honcho.json"), JSON.stringify({ notWorkspace: "x" }));
  expect(getProjectWorkspace(d1)).toBeNull();

  const d2 = tmp();
  writeFileSync(join(d2, ".honcho.json"), JSON.stringify({ workspace: "" }));
  expect(getProjectWorkspace(d2)).toBeNull();

  const d3 = tmp();
  writeFileSync(join(d3, ".honcho.json"), JSON.stringify({ workspace: 42 }));
  expect(getProjectWorkspace(d3)).toBeNull();
});

test("stopDir is excluded so a $HOME-level file is not an accidental global override", () => {
  const home = tmp();
  writeFileSync(join(home, ".honcho.json"), JSON.stringify({ workspace: "highway" }));
  // Walking from home itself, with home as stopDir, must find nothing.
  expect(getProjectWorkspace(home, home)).toBeNull();
});
