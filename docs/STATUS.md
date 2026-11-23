---
type: Reference
title: Status — 2026-11-23
description: Written to be picked up cold. What is true, what is only believed, and what to do.
status: active
created: 2026-09-17
timestamp: 2026-11-23
tags: []
---

# Status — 2026-11-23

Written to be picked up cold. Why things are as they are is in
[DECISIONS.md](DECISIONS.md); this file is state.

**Nothing has run on a real phone, no bridge is deployed, and no Receiver has a
screen.** That is still the most important fact on this page.

---

## 1. Built and tested

| Part | What works | Proof |
|---|---|---|
| Host: capture | SMS receiver, SIM identity by ICCID, sealed outbox, dedupe, backoff | Unit tests; never run on a phone |
| Host: delivery | Seals to each Receiver, deposits at every bridge, tracks bridge health | Unit tests against a fake connection |
| Bridge | Deposit, collect with hold, acknowledge, expiry, limits, key-only access | Tests on the Workers runtime and on Node |
| Bridge image | Runs unprivileged, read-only, 256 MB, clean exit on SIGTERM | CI runs it that way before publishing |
| Receiver library | Opens a sealed message, refuses a changed or re-labelled one | Unit tests |
| Pairing | Receiver's side, and the Host's side in TypeScript. The Receiver's key travels sealed. A bridge that swaps the key, reads it, renames a side or changes the nonce is caught | Unit tests against the real bridge code |
| Receiver web app | Install gate, pairing, several Hosts each with its own keys, a monitor per Host (alive, battery, network, ring), messages shown once, copy, a side panel with Hosts, settings and help, Persian and English, upgrade from the first version | A browser test against two local bridges: `npm run e2e`. Paired and received on an iPhone on 2026-11-23, with the stand-in Host |
| Host to Receiver | A message sealed by the Host's code opens in the Receiver's code | Fixture regenerated in CI every run |
| Build | Signed Host APK and bridge image from GitHub Actions | `build.yml` |

## 2. Not built

- **The Host app's side of pairing, and any Host screen.** Until then no real phone can be paired; `npm run fake-host` stands in.
- Web push, so a closed Receiver is woken by a new message.
- The Receiver APK.
- The Host's screens, wizard, health checks and self-test (D19, ARCHITECTURE 7).
- The signed bundle and config loader, and the signed bridge list (D17, D19).
- **The Host app's reports and commands (D26).** The Receiver shows a monitor and a ring button; only the simulator answers them.
- The dormant self-update (D19).

## 3. Deployed

| Thing | State |
|---|---|
| Bridge 1 | Live, with pairing. Its host took the new `live` image by itself about six minutes after `main` built. `npm run live-check` paired and delivered a message through it |
| Bridge 2 | Live, with pairing. Deployed by hand: `wrangler deploy` from `bridge/` |
| Receiver web app | Live at `pwa.easyotp.rhinocloud.ir`. Deployed by hand: `npm run deploy` from `receiver/` |
| Download links | `dl.amirsalmani.com/s/…` is live in the `amirsalmani-com` repository and returns 404 until the first release |
| A release | None. No tag has been cut |

## 4. Build order

1. ~~Actions builds and signs the Host APK.~~ Done.
2. ~~One repository, three parts; Telegram removed; the new bridge protocol.~~ Done.
3. ~~Bridge 2 deployed; Receiver web app with pairing.~~ Done. Next: the Host app's pairing and first screens, then a real SMS on a real phone.
4. Signed bundle and config, proven by changing a screen without a new APK.
5. Wizard, health checks, heartbeat.
6. ~~Bridge 1's image goes `live`.~~ Done.
7. Receiver APK.

## 5. Open debts

| Debt | Why it matters | When |
|---|---|---|
| Gradle dependency verification (D11) | A release resolves dependencies on reputation alone | Before the first release |
| False messages (THREAT-MODEL A5) | Whoever learns a Receiver's public key and box id can deposit a forged message | With pairing |
| Collect cost on bridge 2 | Held requests are billed by duration on Workers | Before real use; see BRIDGES |
| The service worker is not exercised by any test | The browser test runs a development build, which registers none. Opening offline was checked by reading only | With the first production browser test |
| No rate limit on deposit | A known box id can be flooded until its oldest messages fall out | With bridge 2's deploy |
| SIM identity on Android 10+ | An ordinary app gets an empty ICCID there, so the route is keyed by subscription id. That it stays with its SIM across reboots and re-insertion is assumed, not seen | Step 3, on a dual-SIM phone |
| No automated test of the outbox, the drain loop or the settings store | They need Android's SQLite and Keystore. Retry timing, dead rows and the unreadable-settings guard are checked by reading only | With the first on-device test run |
| Unverified on hardware | Sideloaded install with `RECEIVE_SMS` on Android 15+, service survival on Xiaomi and Samsung, silent self-update on Android 12+ | Step 3 |
| `targetSdk` is 36, `compileSdk` 37 | Moving the target changes how Android treats the service | After a phone on 37 has been tested |
| The test plugin pins the Workers compatibility date | `wrangler.jsonc` cannot name a date newer than the plugin's bundled runtime | When the plugin updates |
| `dl.amirsalmani.com` from inside Iran | The first download may need a fallback on bridge 1 | Step 6 |
| Payment rails (D8), consent screen | Unchanged | Later |

## 6. Toolchain facts that cost hours

- AGP 9 has Kotlin built in; the standalone `kotlin-android` plugin is rejected.
- `android-actions/setup-android@v3` fails on current runners. The runner's own
  SDK plus accepted licences is enough.
- On the Android unit-test compile classpath `org.json` resolves to the platform
  stub: methods the stub lacks, such as `keySet()`, do not compile, although a
  real `org.json` is there at run time.
- `node --test <directory>` on Node 22 tries to run the directory as a module.
  Name the files.
- `@cloudflare/vitest-pool-workers` is now `@cloudflare/vitest-plugin`. Tests
  call the Worker through `exports.default.fetch` from `cloudflare:workers`.
- The Persian cleanup script in the `humanizer-fa` skill rewrites commas and
  digits in English text and YAML. Run it on the Persian half of a file only.
