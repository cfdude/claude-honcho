import { test, expect } from "bun:test";
import { homedir } from "node:os";
import { homeDirPath } from "./home.js";

// This file deliberately imports ONLY ./home.js and node:os. Nothing here can
// reach config.ts, so even a botched HOME restore cannot touch the developer's
// real ~/.honcho/config.json.

function withHome(value: string | undefined, fn: () => void) {
  const original = process.env.HOME;
  if (value === undefined) delete process.env.HOME;
  else process.env.HOME = value;
  try {
    fn();
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  }
}

test("homeDirPath honors a redirected process.env.HOME", () => {
  // The whole point of the helper: Bun's os.homedir() ignores $HOME, so this
  // would return the passwd entry without it.
  withHome("/tmp/honcho-fake-home", () => {
    expect(homeDirPath()).toBe("/tmp/honcho-fake-home");
  });
});

test("homeDirPath falls back to homedir() when HOME is the empty string", () => {
  // `||` not `??` — an exported-but-empty HOME= must not yield "/.honcho" paths.
  withHome("", () => {
    expect(homeDirPath()).toBe(homedir());
    expect(homeDirPath()).not.toBe("");
  });
});

test("homeDirPath falls back to homedir() when HOME is unset", () => {
  withHome(undefined, () => {
    expect(homeDirPath()).toBe(homedir());
  });
});
