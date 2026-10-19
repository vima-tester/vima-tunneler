# vima-tunneler

[![CI](https://github.com/vima-tester/vima-tunneler/actions/workflows/ci.yml/badge.svg)](https://github.com/vima-tester/vima-tunneler/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/vima-tunneler.svg)](https://www.npmjs.com/package/vima-tunneler)
[![node](https://img.shields.io/node/v/vima-tunneler.svg)](https://nodejs.org)

**Run HTTP requests against your localhost APIs from a browser-based API
client — no CORS, no desktop app.**

Browsers can't read responses from `localhost` APIs: the request may fire, but
CORS blocks the response. `vima-tunneler` is a small daemon that runs once on
your machine, holds a persistent WebSocket to a relay server, and executes HTTP
requests against your local APIs on the web app's behalf. It's the same pattern
as Postman's Desktop Agent.

This package is **the local agent only**. The relay server and web UI are
separate projects that speak the wire protocol described in
[PROTOCOL.md](https://github.com/vima-tester/vima-tunneler/blob/main/PROTOCOL.md).

`vima-tunneler` is published on npm:
**[npmjs.com/package/vima-tunneler](https://www.npmjs.com/package/vima-tunneler)**.

```
Browser (web UI)
   |  "run this request" over HTTPS/WS
   v
Relay Server                <- not part of this package
   |  forwards job over the agent's open WebSocket
   v
vima-tunneler               <- this package, on your machine
   |  executes the real HTTP call, no CORS involved
   v
localhost:PORT (your local API)
   ^  response travels back up the same path
```

## Install

Requires **Node.js 20 or newer**. The package is available on npm as
[`vima-tunneler`](https://www.npmjs.com/package/vima-tunneler).

```bash
npm install -g vima-tunneler
```

Or run it without a global install:

```bash
npx vima-tunneler pair --code <code> --server https://relay.example.com
npx vima-tunneler start
```

To pin a specific release:

```bash
npm install -g vima-tunneler@<version>
```

## Quick start

Get a pairing code from the web app, then pair this machine once:

```bash
vima-tunneler pair --code <code> --server https://relay.example.com
```

Then leave the agent running while you use the web app:

```bash
vima-tunneler start
```

The agent connects to the relay and executes jobs until you stop it. Press
`Ctrl+C` to drain in-flight jobs and exit (~10 s max; press `Ctrl+C` again to
force exit).

## Commands

| Command | Purpose |
|---|---|
| `pair --code <code> [--server <url>]` | Exchange a pairing code for a long-lived token, store it locally, and print the agent ID. `--server` is effectively required — no default relay URL is baked in. |
| `start` | Connect to the relay and execute jobs until stopped. Reconnects automatically with jittered exponential backoff. If the relay rejects the token at the upgrade (HTTP 401/403), it logs the reason and exits non-zero instead of retrying forever. |
| `status` | Print the stored pairing state without connecting. |
| `logout` | Delete the stored config. |

## Configuration

Config is stored in `~/.vima-tunneler/config.json` and is written with
restrictive permissions: `0600` inside a `0700` directory on POSIX, with ACL
inheritance stripped on Windows (best-effort via `icacls`).

It is machine-level: pair once, then any project in the web app can use this
agent. Run `vima-tunneler logout` to remove it.

## Runtime knobs

| Environment variable | Default | Meaning |
|---|---|---|
| `VIMA_MAX_INFLIGHT` | `8` | Concurrent job cap; excess jobs get an immediate error frame ("agent busy"). |
| `VIMA_MAX_BODY_BYTES` | `26214400` (25 MB) | Response body cap; larger bodies abort mid-download with an error frame. |

Per-job timeouts come from the relay: each request frame may carry
`timeoutMs`, clamped by the agent to `[1000, 300000]`; the default is 30 s. A
request frame may also carry `insecureTLS: true` to skip certificate
verification for `https:` targets (see below).

## Security model

- **Loopback only.** The agent refuses to proxy any target whose hostname is
  not exactly `localhost`, `127.0.0.1`, `::1`, or `0.0.0.0`. It never becomes
  an open proxy into your network.
- **Token stays out of URLs.** The pairing token is sent as an
  `Authorization: Bearer` header on the WebSocket upgrade, so it cannot leak
  into access logs.
- **Restrictive config permissions.** The token file is `0600` inside a `0700`
  directory (POSIX); on Windows the ACL inheritance is stripped and only the
  current user keeps access (best-effort via `icacls`).
- **Redirects are not followed.** A local server cannot bounce the agent onto
  non-local targets.
- **TLS is verified by default.** Local `https://` servers with self-signed or
  otherwise untrusted certificates are rejected unless the relay sets
  `insecureTLS: true` on that specific request. Verification is never disabled
  globally, and the flag does not affect the relay connection.

## Reliability

Result delivery is at-least-once: every response/error frame carries a
monotonic `seq`; unacked frames are buffered in memory (cap 1000) and replayed
after reconnects. The relay acknowledges cumulatively with
`{"type":"ack","upto":N}` and must treat results as idempotent per `jobId`.
Half-open connections are detected via WebSocket pings (~60 s of silence forces
a reconnect).

See [PROTOCOL.md](https://github.com/vima-tester/vima-tunneler/blob/main/PROTOCOL.md)
for the full wire-protocol contract.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `no relay server given; pass --server <url>` | Pass the relay URL to `pair`. Without a scheme, `https://` is assumed. |
| `Not paired` from `start`/`status` | Run `vima-tunneler pair --code <code> --server <url>` first. |
| Agent exits with 401/403 | The token was rejected. Run `vima-tunneler logout`, then pair again with a fresh code. |
| Errors say "agent busy" | Raise `VIMA_MAX_INFLIGHT`, or wait for in-flight jobs to finish. |
| Large responses fail mid-download | Raise `VIMA_MAX_BODY_BYTES` (bytes). |
| Self-signed local HTTPS target is rejected | Have the relay send `insecureTLS: true` for that request — or use a trusted certificate. |

## Limitations (v1)

- No incremental streaming to the browser: responses are buffered whole
  before delivery (capped at 25 MB by default).
- Frames evicted from a full outbox, or lost across an agent restart, are
  not redelivered.
- One agent per machine; no configurable host allowlist beyond loopback;
  no auto-start on login.
- No explicit inbound request-body cap; large `request` frames are bounded
  only by the WebSocket library's default 100 MiB frame limit.
- A non-auth upgrade failure (e.g. a 5xx or a proxy error) is still retried
  indefinitely; only 401/403 are treated as terminal.

## Links

- **npm package:** https://www.npmjs.com/package/vima-tunneler
- **Source / issues:** https://github.com/vima-tester/vima-tunneler
- **Wire protocol:** [PROTOCOL.md](https://github.com/vima-tester/vima-tunneler/blob/main/PROTOCOL.md)

## Development

```bash
git clone https://github.com/vima-tester/vima-tunneler.git
cd vima-tunneler
npm ci
npm run build          # tsc -> dist/
npm test               # node:test suite
npm link               # optional: puts `vima-tunneler` on your PATH
```

## License

[Apache-2.0](https://github.com/vima-tester/vima-tunneler/blob/main/LICENSE)
