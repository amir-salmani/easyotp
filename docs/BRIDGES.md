---
type: Reference
title: Bridges
description: Each bridge's contract, how it is deployed, and the limits measured in its path.
status: active
created: 2026-11-23
timestamp: 2026-11-23
tags: []
---

# Bridges

A bridge is the code in `bridge/`, deployed somewhere. Every bridge speaks the
protocol in [ARCHITECTURE.md](ARCHITECTURE.md) section 3, and none is required:
the Host sends through all of them and the Receiver collects from all of them.

| # | Name | Runs as | In front of it | State |
|---|---|---|---|---|
| 1 | `easyotp.arsalan.finlawgpt.ir` | Node container, `bridge/src/node.ts` | ArvanCloud CDN | Live since 2026-11-23 |
| 2 | `easyotp.cfworker.rhinocloud.ir` | Cloudflare Worker, `bridge/src/worker.ts` | Cloudflare | Live since 2026-11-23 |

Both names are settled. Each is two levels below its zone, which a CDN's
ordinary free certificate does not cover, but ArvanCloud issued one for
`*.arsalan.finlawgpt.ir` and Cloudflare issues one for a Worker's custom domain
by name.

## Bridge 1: the container

The host it runs on is shared and gives a workload very little. The image is
built for that, and CI runs it under the same constraints before publishing it.

| The host provides | The image must |
|---|---|
| `HOST`, `PORT`, `DATA_DIR`, `NODE_ENV=production` | Listen on `$HOST:$PORT`, plain HTTP, one port |
| A health check every 30 s: `node -e "fetch(...)"` inside the container | Answer `GET /health` with 2xx within 5 s, with `node` on `PATH`; be ready within 30 s |
| uid and gid 10001, no capabilities, no new privileges | Never assume root, including at start |
| A read-only root, `/data` to write in, 16 MB of `/tmp` | Write nowhere else, and keep `/data` under 256 MB itself |
| 256 MB of memory, hard | Stay far below it (measured: 17 MB idle) |
| No outbound network at all | Never call out |
| `SIGTERM`, then `SIGKILL` after 15 s | Exit on `SIGTERM`; held collects are cut and Receivers reconnect |
| The caller's address in `X-Forwarded-For` | Not rely on it: behind the CDN it is the CDN's edge |

Logs go to stdout, one line per event, and never carry a message or a key.

`node.ts` keeps its own total under `MAX_TOTAL_BYTES` (128 MB by default) and
answers `507` to deposits past it, so the 256 MB limit is never approached.

**Deploying.** Moving the tag `live` is the whole deploy. CI pushes `ghcr.io/amir-salmani/easyotp-bridge`. The tag `live`
moves only on a push to `main`. The host asks the registry every 15 minutes and
restarts the container when `live` points at a new image; a start counts only
once `/health` answers. Nobody logs in to deploy, and this repository's sessions
never touch that host. Rolling back to the previous image when a new one never
becomes healthy is designed there and has not been seen working. A change to the
contract is asked for as an issue on the host's own repository, never built into
the image.

**Measured in the path** (2026-11-23, through ArvanCloud's edge over HTTPS, to
the stand-in that held the place before the image):

| Check | Result |
|---|---|
| A quiet request held 58 s | Answered. The 55 s collect fits |
| The same, at the host's own front, without the CDN | Answered at 85 s, cut at 90 s |
| Request body of 64 KB | Accepted. 900 KB was accepted over HTTP; the front's limit is 1 MB |
| A 5 MB response | Complete in about 1 s |
| Caching | `X-Cache: BYPASS` with `cache-control: no-store` |

HTTP is redirected to HTTPS at the edge. Between the edge and the origin the
certificate is still the origin's internal one, which the CDN accepts.

## Bridge 2: the Worker

`wrangler deploy` from `bridge/`, by hand; CI does not deploy it. The
certificate for a new custom domain took about five minutes to appear, and the
name failed its TLS handshake until then. One Durable Object per box, SQLite-backed,
which is the kind the free plan runs. It answers only on its own name;
`workers.dev` is off, because that domain is filtered in Iran.

**Push.** Bridge 2 is the bridge that wakes a closed Receiver (D30). It holds
a signing key for that: the public half is `VAPID_PUBLIC_KEY` in
`wrangler.jsonc` and in `receiver/src/push.ts`, the private half is the Worker
secret `VAPID_PRIVATE_JWK`. Replacing the key makes every push address handed
out so far useless until its Receiver is opened again. Bridge 1 never calls
out, so it takes no push address and answers 404 to one.

**Known cost.** A Durable Object is billed for the time a request is held open,
and a Receiver that collects around the clock holds one open almost
continuously. The hold is 25 s here against 55 s on bridge 1, which does not
change the total. Push removes the reason to stay open for hours; a Receiver
that actually stops doing so once it has a push address is not built yet.

## Checking the bridges

`npm run live-check` in `receiver/` pairs, delivers a message and rings through
the deployed bridges, together and one at a time. The workflow `live-check` runs
the same thing from GitHub's machines.

Use the workflow when a check from a workstation fails. On 2026-11-23 the check
failed about half the time from one laptop, always as a stalled request to
bridge 2 and never as an error from it, while curl from the same laptop and
eighteen runs from GitHub all passed. Bridge 2's own log showed every request
answered. The laptop's connection to that one address was at fault, and what
exactly about it was not found.

## Adding a bridge

Deploy `bridge/` anywhere that can run a Worker or the container, then add it to
the bridge list. Today that list is `SEED_BRIDGES` in the Host's `Settings.kt`.
The signed list that makes this a one-line change with no new APK is D17 and is
not built.
