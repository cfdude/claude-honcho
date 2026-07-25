import { test, expect } from "bun:test";
import { setConfigWorkspaceWarning } from "./mcp/server.js";

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
