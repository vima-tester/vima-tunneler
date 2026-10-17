import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pair, normalizeServerUrl } from "../src/commands/pair";
import { readConfig } from "../src/config";

const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "vima-pair-"));
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

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as import("node:net").AddressInfo).port)
    )
  );
}

test("normalizeServerUrl prepends https, strips slashes, rejects other schemes", () => {
  assert.equal(normalizeServerUrl("relay.example.com"), "https://relay.example.com");
  assert.equal(normalizeServerUrl("http://relay.example.com/"), "http://relay.example.com");
  assert.equal(
    normalizeServerUrl("  https://relay.example.com//  "),
    "https://relay.example.com"
  );
  assert.equal(normalizeServerUrl("localhost:8080"), "https://localhost:8080");
  assert.throws(() => normalizeServerUrl("ftp://relay.example.com"), /scheme/i);
  assert.throws(() => normalizeServerUrl("wss://relay.example.com"), /scheme/i);
});

test("pair exchanges a code for a token and persists the config", async () => {
  let seenBody = "";
  let seenAuth = "";
  const server = http.createServer((req, res) => {
    seenAuth = req.headers["authorization"] ?? "";
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seenBody = body;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ agentId: "agent-7", token: "tok-abc" }));
    });
  });
  const port = await listen(server);
  try {
    const cfg = await pair("CODE-123", `http://127.0.0.1:${port}`);
    assert.equal(cfg.agentId, "agent-7");
    assert.equal(cfg.token, "tok-abc");
    assert.equal(cfg.serverUrl, `http://127.0.0.1:${port}`);
    assert.deepEqual(readConfig(), cfg);
    assert.deepEqual(JSON.parse(seenBody), { code: "CODE-123" });
    assert.equal(seenAuth, "", "pairing must not send an Authorization header");
  } finally {
    server.close();
  }
});

test("pair fails without a server and on an unexpected response shape", async () => {
  await assert.rejects(pair("CODE", undefined), /no relay server/i);

  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ agentId: "agent-7" })); // token missing
  });
  const port = await listen(server);
  try {
    await assert.rejects(
      pair("CODE", `http://127.0.0.1:${port}`),
      /unexpected pairing response/i
    );
  } finally {
    server.close();
  }
});

test("pair surfaces a non-2xx response as a failure", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(410, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "expired code" }));
  });
  const port = await listen(server);
  try {
    await assert.rejects(pair("CODE", `http://127.0.0.1:${port}`));
  } finally {
    server.close();
  }
});
