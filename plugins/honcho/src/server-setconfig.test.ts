import { test, expect } from "bun:test";
import { setConfigWorkspaceWarning, setConfigProjectShadowWarning } from "./mcp/server.js";

test("warns when setting workspace under globalOverride", () => {
  const w = setConfigWorkspaceWarning("workspace", true);
  expect(w).toContain(".honcho.json");
});

test("no warning for workspace when globalOverride is off", () => {
  expect(setConfigWorkspaceWarning("workspace", false)).toBeNull();
});

test("no warning for unrelated fields", () => {
  expect(setConfigWorkspaceWarning("logging", true)).toBeNull();
});

// --- project .honcho.json shadow warning (R2 part 2) ---

test("warns when setting workspace inside a repo with a project .honcho.json", () => {
  const w = setConfigProjectShadowWarning("workspace", { workspace: "highway", dir: "/repo" });
  expect(w).toContain("/repo/.honcho.json");
  expect(w).toContain("highway");
  expect(w).toContain("NOT take effect");
});

test("no project-shadow warning when there is no project config", () => {
  expect(setConfigProjectShadowWarning("workspace", null)).toBeNull();
});

test("no project-shadow warning for unrelated fields", () => {
  expect(setConfigProjectShadowWarning("logging", { workspace: "highway", dir: "/repo" })).toBeNull();
});
