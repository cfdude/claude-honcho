import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveConfig,
  loadConfig,
  saveConfig,
  getOutputLevel,
  parseOutputLevel,
  OUTPUT_LEVELS,
  DEFAULT_OUTPUT_LEVEL,
  type OutputLevel,
} from "./config.js";
import {
  setOutputLevel,
  getCurrentOutputLevel,
  visInjectionMessage,
  visDialecticMessage,
  visComposedInjection,
  visCapture,
  visSkipMessage,
  visStopMessage,
  visError,
  visErrorLine,
  visDiagnostics,
  visStatusLine,
  addSystemMessage,
} from "./visual.js";
import { emitPerTurn } from "./hooks/user-prompt.js";
import { handleSetConfig } from "./mcp/server.js";

const BASE = { apiKey: "k", peerName: "p" } as const;

// visual.ts keeps the level as module state shared across test files in a single
// bun process — always restore the default so ordering can never leak.
afterEach(() => setOutputLevel(DEFAULT_OUTPUT_LEVEL));

/**
 * Run `fn` with $HOME pointed at a throwaway directory.
 *
 * Every test that reaches saveConfig() MUST go through this. `~/.honcho/config.json`
 * is a real, in-use file carrying live API and Cloudflare Access credentials; a
 * saveConfig() against the real HOME would rewrite it. src/home.ts resolves
 * `process.env.HOME || homedir()` precisely so this redirect works on Bun (whose
 * os.homedir() ignores $HOME).
 */
function withFakeHome<T>(fn: (home: string, configPath: string) => T, seed?: object): T {
  const fakeHome = mkdtempSync(join(tmpdir(), "honcho-home-"));
  const honchoDir = join(fakeHome, ".honcho");
  mkdirSync(honchoDir, { recursive: true });
  const configPath = join(honchoDir, "config.json");
  writeFileSync(configPath, JSON.stringify(seed ?? { ...BASE }));
  const originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    return fn(fakeHome, configPath);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
}

/** Run `fn` with HONCHO_OUTPUT_LEVEL set (or cleared), restoring it afterwards. */
function withEnvLevel<T>(value: string | undefined, fn: () => T): T {
  const original = process.env.HONCHO_OUTPUT_LEVEL;
  if (value === undefined) delete process.env.HONCHO_OUTPUT_LEVEL;
  else process.env.HONCHO_OUTPUT_LEVEL = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.HONCHO_OUTPUT_LEVEL;
    else process.env.HONCHO_OUTPUT_LEVEL = original;
  }
}

/** Capture every console.log line emitted by `fn`. */
function captureStdout(fn: () => void): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

// ============================================
// Resolution precedence
// ============================================

test("outputLevel defaults to info when nothing sets it", () => {
  withEnvLevel(undefined, () => {
    const cfg = resolveConfig({ ...BASE } as any, "claude_code", "/nonexistent-dir");
    expect(cfg?.outputLevel).toBe("info");
    expect(DEFAULT_OUTPUT_LEVEL).toBe("info");
  });
});

test("outputLevel resolves from the root config field", () => {
  withEnvLevel(undefined, () => {
    const cfg = resolveConfig({ ...BASE, outputLevel: "error" } as any, "claude_code", "/nonexistent-dir");
    expect(cfg?.outputLevel).toBe("error");
  });
});

test("a host block's outputLevel beats the root field", () => {
  withEnvLevel(undefined, () => {
    const raw = { ...BASE, outputLevel: "error", hosts: { claude_code: { outputLevel: "verbose" } } } as any;
    expect(resolveConfig(raw, "claude_code", "/nonexistent-dir")?.outputLevel).toBe("verbose");
    // ...and a host WITHOUT its own value still falls back to root.
    expect(resolveConfig(raw, "cursor", "/nonexistent-dir")?.outputLevel).toBe("error");
  });
});

test("getOutputLevel defaults null/absent/garbage config to info", () => {
  expect(getOutputLevel(null)).toBe("info");
  expect(getOutputLevel({ ...BASE, workspace: "w", aiPeer: "a" } as any)).toBe("info");
  expect(getOutputLevel({ ...BASE, workspace: "w", aiPeer: "a", outputLevel: "nonsense" } as any)).toBe("info");
  expect(getOutputLevel({ ...BASE, workspace: "w", aiPeer: "a", outputLevel: "off" } as any)).toBe("off");
});

// ============================================
// HONCHO_OUTPUT_LEVEL env override
// ============================================

test("HONCHO_OUTPUT_LEVEL overrides the file config", () => {
  withEnvLevel("off", () => {
    const cfg = resolveConfig({ ...BASE, outputLevel: "verbose" } as any, "claude_code", "/nonexistent-dir");
    expect(cfg?.outputLevel).toBe("off");
  });
});

test("an INVALID HONCHO_OUTPUT_LEVEL falls back to the resolved value, never silencing output", () => {
  withEnvLevel("VERBOSE!!", () => {
    // File said "verbose" -> a typo'd env var must not downgrade or mute it.
    expect(resolveConfig({ ...BASE, outputLevel: "verbose" } as any, "claude_code", "/nonexistent-dir")?.outputLevel).toBe("verbose");
    // No file value -> the default, NOT "off".
    expect(resolveConfig({ ...BASE } as any, "claude_code", "/nonexistent-dir")?.outputLevel).toBe("info");
  });
  expect(parseOutputLevel("nope")).toBeUndefined();
  expect(parseOutputLevel("")).toBeUndefined();
  expect(parseOutputLevel(undefined)).toBeUndefined();
  for (const level of OUTPUT_LEVELS) expect(parseOutputLevel(level)).toBe(level);
});

test("HONCHO_OUTPUT_LEVEL applies on the env-only path too (no config file)", () => {
  const originalKey = process.env.HONCHO_API_KEY;
  process.env.HONCHO_API_KEY = "k";
  try {
    withFakeHome(() => {
      // Point HOME at a dir with no .honcho/config.json so loadConfig falls
      // through to loadConfigFromEnv, which does NOT run mergeWithEnvVars.
      const bare = mkdtempSync(join(tmpdir(), "honcho-bare-"));
      const prevHome = process.env.HOME;
      process.env.HOME = bare;
      try {
        withEnvLevel("error", () => {
          expect(loadConfig("claude_code", bare)?.outputLevel).toBe("error");
        });
        withEnvLevel("bogus", () => {
          expect(loadConfig("claude_code", bare)?.outputLevel).toBe("info");
        });
      } finally {
        process.env.HOME = prevHome;
      }
    });
  } finally {
    if (originalKey === undefined) delete process.env.HONCHO_API_KEY;
    else process.env.HONCHO_API_KEY = originalKey;
  }
});

// ============================================
// saveConfig must not persist an env-only override
// ============================================

test("saveConfig does NOT persist an env-derived outputLevel to disk", () => {
  withFakeHome((_home, configPath) => {
    withEnvLevel("verbose", () => {
      // Simulates the resolved config loadConfig() hands back while the env var
      // is set: outputLevel === the env value, which is per-invocation only.
      saveConfig({ ...BASE, workspace: "personal", aiPeer: "claude", outputLevel: "verbose" } as any);
      const written = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(written.hosts.claude_code.outputLevel).toBeUndefined();
    });
  }, { ...BASE, hosts: { claude_code: { workspace: "personal" } } });
});

test("saveConfig preserves an existing on-disk outputLevel when the env var shadows it", () => {
  withFakeHome((_home, configPath) => {
    withEnvLevel("off", () => {
      saveConfig({ ...BASE, workspace: "personal", aiPeer: "claude", outputLevel: "off" } as any);
      const written = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(written.hosts.claude_code.outputLevel).toBe("error");
    });
  }, { ...BASE, hosts: { claude_code: { workspace: "personal", outputLevel: "error" } } });
});

test("saveConfig DOES persist an explicitly chosen outputLevel that differs from the env override", () => {
  withFakeHome((_home, configPath) => {
    withEnvLevel("verbose", () => {
      saveConfig({ ...BASE, workspace: "personal", aiPeer: "claude", outputLevel: "error" } as any);
      const written = JSON.parse(readFileSync(configPath, "utf-8"));
      expect(written.hosts.claude_code.outputLevel).toBe("error");
    });
  }, { ...BASE, hosts: { claude_code: { workspace: "personal" } } });
});

// ============================================
// Emitter behavior at each level
// ============================================

const CONCLUSIONS = ["robsherman prefers concise answers", "robsherman uses bun for this repo"];

test("visInjectionMessage: bullets at verbose, header only at info, silent below", () => {
  setOutputLevel("verbose");
  const verbose = visInjectionMessage("user-prompt", { conclusions: CONCLUSIONS, queryLabel: "prompt" });
  expect(verbose).toContain("injected 2 conclusions (query: prompt)");
  expect(verbose).toContain(CONCLUSIONS[0]);
  expect(verbose.split("\n")).toHaveLength(3);

  setOutputLevel("info");
  const info = visInjectionMessage("user-prompt", { conclusions: CONCLUSIONS, queryLabel: "prompt" });
  expect(info).toContain("injected 2 conclusions (query: prompt)");
  expect(info).not.toContain(CONCLUSIONS[0]);
  expect(info.split("\n")).toHaveLength(1);

  for (const level of ["error", "off"] as OutputLevel[]) {
    setOutputLevel(level);
    expect(visInjectionMessage("user-prompt", { conclusions: CONCLUSIONS, queryLabel: "prompt" })).toBe("");
  }
});

test("visDialecticMessage: full answer at verbose, status line at info, silent below", () => {
  const answer = "The user has previously decided to self-host Honcho behind Cloudflare Access.";

  setOutputLevel("verbose");
  expect(visDialecticMessage("user-prompt", "medium", 1200, answer)).toContain(answer);

  setOutputLevel("info");
  const info = visDialecticMessage("user-prompt", "medium", 1200, answer);
  expect(info).toContain("injected dialectic (medium · 1.2s)");
  expect(info).not.toContain(answer);

  for (const level of ["error", "off"] as OutputLevel[]) {
    setOutputLevel(level);
    expect(visDialecticMessage("user-prompt", "medium", 1200, answer)).toBe("");
  }
});

test("visComposedInjection: unchanged at verbose/info, empty at error/off", () => {
  for (const level of ["verbose", "info"] as OutputLevel[]) {
    setOutputLevel(level);
    expect(visComposedInjection("session-start", ["summary", "peer card"])).toBe(
      "[honcho] session-start ← injected summary + peer card"
    );
  }
  for (const level of ["error", "off"] as OutputLevel[]) {
    setOutputLevel(level);
    expect(visComposedInjection("session-start", ["summary"])).toBe("");
  }
});

test("visCapture / visSkipMessage / visStopMessage print at verbose+info and nothing at error/off", () => {
  for (const level of ["verbose", "info"] as OutputLevel[]) {
    setOutputLevel(level);
    expect(captureStdout(() => visCapture("Edit src/foo.ts"))).toHaveLength(1);
    expect(captureStdout(() => visSkipMessage("user-prompt", "trivial prompt"))).toHaveLength(1);
    expect(captureStdout(() => visStopMessage("out", "saved 3 assistant msg(s)"))).toHaveLength(1);
  }
  for (const level of ["error", "off"] as OutputLevel[]) {
    setOutputLevel(level);
    expect(captureStdout(() => visCapture("Edit src/foo.ts"))).toEqual([]);
    expect(captureStdout(() => visSkipMessage("user-prompt", "trivial prompt"))).toEqual([]);
    expect(captureStdout(() => visStopMessage("out", "saved 3 assistant msg(s)"))).toEqual([]);
  }
});

test("visStatusLine (the session-link banner) is dropped at error/off so 'off' is truly silent", () => {
  for (const level of ["verbose", "info"] as OutputLevel[]) {
    setOutputLevel(level);
    expect(visStatusLine("view your session in honcho GUI: https://example/x")).toContain("honcho GUI");
  }
  for (const level of ["error", "off"] as OutputLevel[]) {
    setOutputLevel(level);
    expect(visStatusLine("view your session in honcho GUI: https://example/x")).toBe("");
  }
});

test("an emitter that emits nothing yields a single well-formed JSON line, never a blank systemMessage", () => {
  setOutputLevel("info");
  const [line] = captureStdout(() => visCapture("Edit src/foo.ts"));
  const parsed = JSON.parse(line!);
  expect(parsed.systemMessage).toContain("captured: Edit src/foo.ts");

  // addSystemMessage must not attach an empty key when the emitter was suppressed.
  const payload = { hookSpecificOutput: { additionalContext: "x" } };
  expect(addSystemMessage(payload, "")).not.toHaveProperty("systemMessage");
  expect(addSystemMessage(payload, "   ")).not.toHaveProperty("systemMessage");
  expect(addSystemMessage(payload, "hi").systemMessage).toBe("hi");
});

// ============================================
// visError — the point of the "error" level
// ============================================

test("visError is visible at verbose, info AND error — silent only at off", () => {
  for (const level of ["verbose", "info", "error"] as OutputLevel[]) {
    setOutputLevel(level);
    const [line] = captureStdout(() => visError("user-prompt", "context fetch failed: 403"));
    expect(JSON.parse(line!).systemMessage).toContain("context fetch failed: 403");
    expect(visErrorLine("user-prompt", "boom")).toContain("boom");
  }
  setOutputLevel("off");
  expect(captureStdout(() => visError("user-prompt", "context fetch failed: 403"))).toEqual([]);
  expect(visErrorLine("user-prompt", "boom")).toBe("");
});

test("at 'error' a healthy turn is silent but a failure still speaks", () => {
  setOutputLevel("error");
  expect(captureStdout(() => visCapture("Edit src/foo.ts"))).toEqual([]);
  expect(visInjectionMessage("user-prompt", { conclusions: CONCLUSIONS })).toBe("");
  expect(captureStdout(() => visError("stop", "message upload failed: ECONNREFUSED"))).toHaveLength(1);
});

// ============================================
// visDiagnostics — verbose only, never leaks credential values
// ============================================

const DIAG_CONFIG = {
  ...BASE,
  workspace: "personal",
  aiPeer: "claude",
  endpoint: { baseUrl: "https://honcho.example.io" },
  accessClientId: "supersecret-id.access",
  accessClientSecret: "supersecret-value",
} as any;

test("visDiagnostics prints ONLY at verbose", () => {
  setOutputLevel("verbose");
  expect(visDiagnostics(DIAG_CONFIG, undefined, "/nonexistent-dir")).not.toBe("");
  for (const level of ["info", "error", "off"] as OutputLevel[]) {
    setOutputLevel(level);
    expect(visDiagnostics(DIAG_CONFIG, undefined, "/nonexistent-dir")).toBe("");
  }
});

test("visDiagnostics reports endpoint, workspace provenance, an Access BOOLEAN, and caller extras", () => {
  setOutputLevel("verbose");
  const out = visDiagnostics(DIAG_CONFIG, { retrieval: "1.4s" }, "/nonexistent-dir");
  expect(out).toContain("https://honcho.example.io");
  expect(out).toContain("workspace:");
  expect(out).toContain("source:");
  expect(out).toContain("cf-access headers: yes");
  expect(out).toContain("retrieval: 1.4s");
  // NEVER the credential values themselves.
  expect(out).not.toContain("supersecret-id.access");
  expect(out).not.toContain("supersecret-value");
});

test("visDiagnostics reports no Access headers when the pair is incomplete", () => {
  setOutputLevel("verbose");
  const halfConfigured = { ...DIAG_CONFIG, accessClientSecret: undefined };
  expect(visDiagnostics(halfConfigured, undefined, "/nonexistent-dir")).toContain("cf-access headers: no");
});

// ============================================
// THE INVARIANT: additionalContext is display-independent
// ============================================

const CTX = {
  context: { representation: "- robsherman prefers concise answers\n- robsherman uses bun" },
  matched: ["bun"],
  queryLabel: "prompt",
};
const DIALECTIC = { answer: "Background: the user self-hosts Honcho.", reasoning: "medium" as const, elapsedMs: 900 };

/** Emit one turn at `level` and return the parsed hook JSON (or null if nothing printed). */
function emitAt(level: OutputLevel): any {
  setOutputLevel(level);
  const lines = captureStdout(() =>
    emitPerTurn("robsherman", CTX, DIALECTIC, { sessionLink: "view your session in honcho GUI: https://example/x" })
  );
  return lines.length ? JSON.parse(lines[0]!) : null;
}

test("INVARIANT: additionalContext is byte-identical at 'off' and 'verbose'", () => {
  const off = emitAt("off");
  const verbose = emitAt("verbose");

  // Both levels must still emit the payload — memory quality does not depend on
  // how loud the terminal is. This is the whole point of the feature.
  expect(off.hookSpecificOutput.additionalContext).toBe(verbose.hookSpecificOutput.additionalContext);
  expect(off.hookSpecificOutput.additionalContext).toContain("Relevant conclusions:");
  expect(off.hookSpecificOutput.additionalContext).toContain("Dialectic recall:");
  expect(off.hookSpecificOutput.hookEventName).toBe(verbose.hookSpecificOutput.hookEventName);

  // ...while the human-facing half differs: absent at off, rich at verbose.
  expect(off).not.toHaveProperty("systemMessage");
  expect(verbose.systemMessage).toContain("injected 2 conclusions");
  expect(verbose.systemMessage).toContain(DIALECTIC.answer);
});

test("INVARIANT holds across all four levels; only systemMessage varies", () => {
  const payloads = OUTPUT_LEVELS.map(level => emitAt(level));
  const contexts = payloads.map(p => p.hookSpecificOutput.additionalContext);
  expect(new Set(contexts).size).toBe(1);

  const [verbose, info, error, off] = OUTPUT_LEVELS.map(level => emitAt(level));
  expect(verbose.systemMessage).toContain(DIALECTIC.answer);
  expect(info.systemMessage).toContain("injected 2 conclusions");
  expect(info.systemMessage).not.toContain(DIALECTIC.answer);
  expect(error).not.toHaveProperty("systemMessage");
  expect(off).not.toHaveProperty("systemMessage");
});

test("at 'off' the session-link banner does not leak through as a systemMessage", () => {
  setOutputLevel("off");
  const lines = captureStdout(() =>
    emitPerTurn("robsherman", null, null, { sessionLink: "view your session in honcho GUI: https://example/x" })
  );
  expect(lines).toEqual([]);
});

test("a failure line still reaches the user at 'error' even with nothing to inject", () => {
  setOutputLevel("error");
  const lines = captureStdout(() =>
    emitPerTurn("robsherman", null, null, {
      sessionLink: "view your session in honcho GUI: https://example/x",
      extraLines: [visErrorLine("user-prompt", "context fetch failed: 403")],
    })
  );
  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0]!);
  expect(parsed.systemMessage).toContain("context fetch failed: 403");
  // The routine banner is still suppressed — only the failure speaks.
  expect(parsed.systemMessage).not.toContain("honcho GUI");
  expect(parsed).not.toHaveProperty("hookSpecificOutput");
});

// ============================================
// set_config outputLevel
// ============================================

test("set_config rejects an invalid outputLevel and writes nothing", () => {
  withFakeHome((_home, configPath) => {
    const before = readFileSync(configPath, "utf-8");
    const res: any = handleSetConfig({ field: "outputLevel", value: "loud" });
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe(`outputLevel must be one of: ${OUTPUT_LEVELS.join(", ")}`);
    expect(readFileSync(configPath, "utf-8")).toBe(before);
  }, { ...BASE, hosts: { claude_code: { workspace: "personal" } } });
});

test("set_config persists a valid outputLevel to the host block", () => {
  withFakeHome((_home, configPath) => {
    withEnvLevel(undefined, () => {
      const res: any = handleSetConfig({ field: "outputLevel", value: "verbose" });
      expect(res.isError).toBeFalsy();
      expect(JSON.parse(readFileSync(configPath, "utf-8")).hosts.claude_code.outputLevel).toBe("verbose");
    });
  }, { ...BASE, hosts: { claude_code: { workspace: "personal" } } });
});

test("setOutputLevel/getCurrentOutputLevel round-trip, and the module default is info", () => {
  setOutputLevel(DEFAULT_OUTPUT_LEVEL);
  expect(getCurrentOutputLevel()).toBe("info");
  for (const level of OUTPUT_LEVELS) {
    setOutputLevel(level);
    expect(getCurrentOutputLevel()).toBe(level);
  }
});
