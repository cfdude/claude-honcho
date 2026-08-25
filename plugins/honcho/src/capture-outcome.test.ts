import { test, expect, afterEach } from "bun:test";
import {
  setOutputLevel,
  visCaptureWithError,
  visCaptureLine,
  visDurationLine,
} from "./visual.js";
import { DEFAULT_OUTPUT_LEVEL, OUTPUT_LEVELS } from "./config.js";

/**
 * The capture line must distinguish an upload that reached Honcho from one that
 * was SKIPPED by config. Before this, logToHonchoAsync's early return and a
 * successful upload both produced `null`, so every turn printed a bare
 * "captured:" even on a config where saveToolUse was absent and nothing was ever
 * sent. Also asserts the one-JSON-object invariant: post-tool-use gets exactly
 * one stdout write, and none at all when there's nothing to say.
 */

afterEach(() => setOutputLevel(DEFAULT_OUTPUT_LEVEL));

function captureStdout(fn: () => void): string[] {
  const original = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => lines.push(args.join(" "));
  try {
    fn();
  } finally {
    console.log = original;
  }
  return lines;
}

test("an uploaded capture says 'captured:', a skipped one says 'captured (local only):'", () => {
  setOutputLevel("info");

  const [uploaded] = captureStdout(() =>
    visCaptureWithError("Wrote a.txt", null, { uploaded: true }),
  );
  expect(JSON.parse(uploaded).systemMessage).toContain("captured: Wrote a.txt");
  expect(JSON.parse(uploaded).systemMessage).not.toContain("local only");

  const [skipped] = captureStdout(() =>
    visCaptureWithError("Wrote a.txt", null, { uploaded: false }),
  );
  expect(JSON.parse(skipped).systemMessage).toContain("captured (local only): Wrote a.txt");
});

test("visCaptureLine's default stays the uploaded wording (one-arg call sites unchanged)", () => {
  setOutputLevel("info");
  expect(visCaptureLine("Wrote a.txt")).toContain("captured: Wrote a.txt");
  expect(visCaptureLine("Wrote a.txt")).not.toContain("local only");
});

test("a skipped upload is not reported as an error", () => {
  setOutputLevel("error");
  // At "error" the capture line is suppressed; a skip is not a failure, so
  // nothing at all is printed.
  expect(captureStdout(() => visCaptureWithError("Wrote a.txt", null, { uploaded: false }))).toEqual([]);
});

test("a timeout/error surfaces at 'error' level and drops only at 'off'", () => {
  setOutputLevel("error");
  const [errLine] = captureStdout(() =>
    visCaptureWithError("Wrote a.txt", "capture upload timed out after 5000ms", { uploaded: false }),
  );
  const parsed = JSON.parse(errLine);
  expect(parsed.systemMessage).toContain("timed out after 5000ms");
  expect(parsed.systemMessage).not.toContain("captured");

  setOutputLevel("off");
  expect(
    captureStdout(() =>
      visCaptureWithError("Wrote a.txt", "capture upload timed out after 5000ms", { uploaded: false }),
    ),
  ).toEqual([]);
});

test("the duration self-report shows only at verbose", () => {
  setOutputLevel("verbose");
  expect(visDurationLine("post-tool-use", 42)).toContain("took 42ms");
  const [line] = captureStdout(() =>
    visCaptureWithError("Wrote a.txt", null, { uploaded: true, durationMs: 42 }),
  );
  expect(JSON.parse(line).systemMessage).toContain("took 42ms");

  for (const level of ["info", "error", "off"] as const) {
    setOutputLevel(level);
    expect(visDurationLine("post-tool-use", 42)).toBe("");
    const out = captureStdout(() =>
      visCaptureWithError("Wrote a.txt", null, { uploaded: true, durationMs: 42 }),
    );
    expect(out.join("\n")).not.toContain("took 42ms");
  }
});

test("every output level emits at most ONE parseable JSON object, never an empty systemMessage", () => {
  for (const level of OUTPUT_LEVELS) {
    setOutputLevel(level);
    for (const uploaded of [true, false]) {
      for (const error of [null, "capture upload failed: boom"]) {
        const out = captureStdout(() =>
          visCaptureWithError("Wrote a.txt", error, { uploaded, durationMs: 7 }),
        );
        expect(out.length).toBeLessThanOrEqual(1);
        for (const line of out) {
          const parsed = JSON.parse(line);
          expect(Object.keys(parsed)).toEqual(["systemMessage"]);
          expect(parsed.systemMessage.trim().length).toBeGreaterThan(0);
        }
      }
    }
  }
});
