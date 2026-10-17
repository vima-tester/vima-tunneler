import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import {
  BodyTooLargeError,
  NonLocalTargetError,
  REQUEST_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  clampTimeout,
  executeRequest,
} from "../src/executor";
import { selfSignedCert, selfSignedKey } from "./fixtures/selfSigned";

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as import("node:net").AddressInfo).port)
    );
  });
}

test("clampTimeout bounds and type-guards", () => {
  assert.equal(clampTimeout(500), MIN_TIMEOUT_MS);
  assert.equal(clampTimeout(MAX_TIMEOUT_MS * 10), MAX_TIMEOUT_MS);
  assert.equal(clampTimeout(7_500), 7_500);
  assert.equal(clampTimeout("500"), undefined);
  assert.equal(clampTimeout(undefined), undefined);
});

function echoServer() {
  return http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(201, { "content-type": "application/octet-stream" });
      res.end(Buffer.concat(chunks));
    });
  });
}

test("executes against all loopback literal forms on a dual-stack bind", async () => {
  const payload = Buffer.from("bin \x00\x01\xff tail");
  const server = echoServer();
  await new Promise<number>((resolve) =>
    server.listen(0, undefined, () => resolve((server.address() as import("node:net").AddressInfo).port))
  ).then((p) => (server as unknown as { __port?: number }).__port = p);
  const port = (server as unknown as { __port: number }).__port;

  for (const host of ["127.0.0.1", "localhost", "[::1]"]) {
    const res = await executeRequest({
      jobId: "j",
      method: "POST",
      url: `http://${host}:${port}/echo`,
      bodyBase64: payload.toString("base64"),
    });
    assert.equal(res.status, 201);
    assert.deepEqual(Buffer.from(res.bodyBase64, "base64"), payload);
  }
  server.close();
});

test("localhost falls back across address families when one refuses", async () => {
  const payload = Buffer.from("ipv4-only");
  const server = echoServer();
  const port = await listen(server);

  const res = await executeRequest({
    jobId: "j",
    method: "POST",
    url: `http://localhost:${port}/echo`,
    bodyBase64: payload.toString("base64"),
  });
  assert.equal(res.status, 201);
  assert.deepEqual(Buffer.from(res.bodyBase64, "base64"), payload);
  server.close();
});

test("rejects non-local and malformed targets before any network call", async () => {
  for (const url of [
    "http://example.com/",
    "http://10.0.0.5:3000/",
    "http://localhost.evil.com/",
    "https://192.168.1.1/admin",
    "file:///etc/passwd",
    "not a url",
  ]) {
    await assert.rejects(
      executeRequest({ jobId: "j", method: "GET", url }),
      NonLocalTargetError
    );
  }
});

test("does not follow redirects; returns them as responses", async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/redir") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/" });
      res.end();
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("nope");
    }
  });
  const port = await listen(server);

  const redir = await executeRequest({
    jobId: "j",
    method: "GET",
    url: `http://localhost:${port}/redir`,
  });
  assert.equal(redir.status, 302);
  assert.equal(redir.headers["location"], "http://169.254.169.254/latest/");

  const nf = await executeRequest({
    jobId: "j",
    method: "GET",
    url: `http://localhost:${port}/missing`,
  });
  assert.equal(nf.status, 404);
  assert.equal(nf.headers["content-type"], "text/plain");
  server.close();
});

test("aborts oversized bodies mid-stream", async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end(Buffer.alloc(5_000, 7));
  });
  const port = await listen(server);
  const prev = process.env.VIMA_MAX_BODY_BYTES;
  process.env.VIMA_MAX_BODY_BYTES = "100";
  try {
    await assert.rejects(
      executeRequest({
        jobId: "j",
        method: "GET",
        url: `http://127.0.0.1:${port}/big`,
      }),
      BodyTooLargeError
    );
  } finally {
    if (prev === undefined) delete process.env.VIMA_MAX_BODY_BYTES;
    else process.env.VIMA_MAX_BODY_BYTES = prev;
  }
  server.close();
});

test("per-job timeoutMs overrides the default", { timeout: 10_000 }, async () => {
  const server = http.createServer(() => {
    /* hang */
  });
  const port = await listen(server);
  const t0 = Date.now();
  await assert.rejects(
    executeRequest({
      jobId: "j",
      method: "GET",
      url: `http://127.0.0.1:${port}/hang`,
      timeoutMs: MIN_TIMEOUT_MS,
    }),
    /timeout/i
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < REQUEST_TIMEOUT_MS, `took ${elapsed}ms`);
  server.close();
});

test("a timeout is not replayed against another address family", { timeout: 10_000 }, async () => {
  let connections = 0;
  const server = http.createServer(() => {
    connections += 1;
    /* hang */
  });
  const port = await listen(server);
  await assert.rejects(
    executeRequest({
      jobId: "j",
      method: "POST",
      url: `http://localhost:${port}/hang`,
      bodyBase64: Buffer.from("payload").toString("base64"),
      timeoutMs: MIN_TIMEOUT_MS,
    }),
    /timeout/i
  );
  assert.equal(connections, 1, "timed-out request must not be re-sent");
  server.close();
});

test("self-signed https targets are rejected by default, allowed via insecureTLS", async () => {
  const server = https.createServer(
    { key: selfSignedKey, cert: selfSignedCert },
    (_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("secure-ok");
    }
  );
  const port = await listen(server);
  try {
    await assert.rejects(
      executeRequest({
        jobId: "j",
        method: "GET",
        url: `https://127.0.0.1:${port}/`,
      }),
      /self[- ]signed|certificate|unable to verify/i
    );

    const res = await executeRequest({
      jobId: "j",
      method: "GET",
      url: `https://127.0.0.1:${port}/`,
      insecureTLS: true,
    });
    assert.equal(res.status, 200);
    assert.equal(Buffer.from(res.bodyBase64, "base64").toString(), "secure-ok");
  } finally {
    server.close();
  }
});

test("repeated set-cookie headers are newline-joined, not comma-joined", async () => {
  const server = http.createServer((_req, res) => {
    res.setHeader("Set-Cookie", [
      "a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT",
      "b=2; Path=/",
    ]);
    res.writeHead(200);
    res.end("ok");
  });
  const port = await listen(server);
  try {
    const res = await executeRequest({
      jobId: "j",
      method: "GET",
      url: `http://127.0.0.1:${port}/`,
    });
    const cookie = res.headers["set-cookie"];
    assert.ok(cookie, "expected a set-cookie header");
    assert.deepEqual(cookie.split("\n"), [
      "a=1; Expires=Wed, 21 Oct 2099 07:28:00 GMT",
      "b=2; Path=/",
    ]);
  } finally {
    server.close();
  }
});
