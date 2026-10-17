import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { status } from "../src/commands/status";
import { logout } from "../src/commands/logout";
import { clearConfig, configPath, readConfig, writeConfig } from "../src/config";

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "vima-cmd-"));
let prevHome: string | undefined;

before(() => {
  prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

after(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

beforeEach(() => clearConfig());

const CFG = {
  agentId: "agent-9",
  token: "secret",
  serverUrl: "https://relay.example.com",
  pairedAt: "2026-01-01T00:00:00.000Z",
};

async function capture(fn: () => Promise<void>): Promise<string> {
  const lines: unknown[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => void lines.push(a.join(" "));
  console.error = (...a: unknown[]) => void lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
  return lines.join("\n");
}

test("status prints the pairing state, or reports Not paired", async () => {
  assert.match(await capture(status), /Not paired/);

  writeConfig(CFG);
  const out = await capture(status);
  assert.match(out, /agent-9/);
  assert.match(out, /https:\/\/relay\.example\.com/);
  assert.match(out, /2026-01-01/);
});

test("logout removes the config only when paired", async () => {
  assert.match(await capture(logout), /nothing to remove/i);

  writeConfig(CFG);
  assert.ok(fs.existsSync(configPath()));

  assert.match(await capture(logout), /Removed/);
  assert.equal(readConfig(), null);
  assert.ok(!fs.existsSync(configPath()));
});
