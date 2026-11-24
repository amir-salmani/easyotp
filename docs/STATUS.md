---
type: Reference
title: Status — 2026-11-24
description: Written to be picked up cold. What is true, what is only believed, and what to do.
status: active
created: 2026-09-17
timestamp: 2026-11-24
tags: []
---

# Status — 2026-11-24

Written to be picked up cold. Why things are as they are is in
[DECISIONS.md](DECISIONS.md); this file is state.

**It has run on one real phone for one evening.** On 2026-11-24 the Host was
set up on a Nothing Phone (2) with Android 16 and two Iranian SIMs, paired with
the web app on an iPhone, forwarded real SMS and rang when asked. What is left
to prove is time: the same phone left alone for days, and a ring reaching it
from deep sleep.

---

## 1. Built and tested

| Part | What works | Proof |
|---|---|---|
| Host: capture | SMS receiver, SIM identity, sealed outbox, dedupe, backoff. Nothing is kept until the owner has agreed and someone is paired | Unit tests; the emulator check |
| Host: delivery | Seals to each Receiver that reads the SIM, deposits at every bridge, tracks bridge health | Unit tests against a fake connection; the emulator check |
| Host: pairing | The Host's side in Kotlin: commit, open the sealed offer, reveal, hand over a command channel | Unit tests; a written-down pairing both sides recompute; the emulator check |
| Host: reports and commands | A status report about every fifteen minutes and on request; rings and vibrates when asked; answers naming the command | The emulator check. The fifteen-minute alarm itself was not waited for |
| Host: screens | Setup one permission at a time, home, pairing with code and picture, which SIMs a Receiver reads, disconnect, test message, the phone's name. Persian and English | The emulator check drives them; seen in a browser against a stand-in |
| Answers and calls | A Receiver answers an SMS, sends an advertiser its opt-out code, sees calls and declines one with a line to the caller; the Host decides each send by fixed rules | Unit tests of the rules; the emulator check; the browser test |
| Receiver web app | Install gate, pairing, several Hosts each with its own keys, a monitor per Host, messages shown once, copy, a Spam list with advertising set aside, side panel, Persian and English | `npm run e2e`. Used on an iPhone on 2026-11-23 |
| Receiver Android app | The same screens in an APK, with Android notifications | Paired with the Host app on one emulator and showed its SMS. Notifications were not looked at |
| Bridge | Deposit, collect with hold, acknowledge, expiry, limits, key-only access, pairing slots | Tests on the Workers runtime and on Node |
| Bridge image | Runs unprivileged, read-only, 256 MB, clean exit on SIGTERM | CI runs it that way before publishing |
| Host to Receiver | An SMS and a status report sealed by the Host's code open in the Receiver's | Fixture regenerated in CI every run |
| Build | Signed Host and Receiver APKs and the bridge image from GitHub Actions | `build.yml` |

**The emulator check** is `npm run emulator-check` in `receiver/`: the Host app
on Android 16, the live bridges, and a script playing the Receiver. It passed
on 2026-11-24 with a debug build and with the shrunk release build.

## 2. Not built

- Waking the Receiver's Android app when it is closed (the web app is woken by a push from bridge 2, D30).
- The Receiver's Android app taking new screens without a new APK, as the Host does (D32).
- The dormant self-update of the Host's native core (D19).

## 3. Deployed

| Thing | State |
|---|---|
| Bridge 1 | Live. Its host follows the `live` image tag, which moves when `main` builds |
| Bridge 2 | Live. Deployed by hand: `wrangler deploy` from `bridge/` |
| Receiver web app | Live at `pwa.easyotp.rhinocloud.ir`. Deployed by hand: `npm run deploy` from `receiver/` |
| Download links | `dl.amirsalmani.com/s/…` is live and returns 404 until the first release |
| A release | None. The tag `gen1` marks the first working generation and publishes nothing. Every push builds signed APKs as workflow artifacts |
| Signed files | Bridge 2 serves the signed bridge list and Host screens (D32). Bridge 1 serves them once `main` builds |

## 4. Build order

1. ~~Android apps, pairing, reports, ring, push, spam, answers and calls, contact names.~~ Done; tagged `gen1`.
2. ~~Review of the second half, and its fixes.~~ Done.
3. ~~Per-maker setup, deposit pace, signed list and screens (D32), dependency checksums.~~ Done.
4. **Next: a night on the real phone, left alone.** Then the first release.
5. Waking the Receiver's Android app.

## 5. Open debts

| Debt | Why it matters | When |
|---|---|---|
| False messages (THREAT-MODEL A5) | Whoever learns a Receiver's public key and box id can deposit a forged message. Pairing keeps both from a bridge | Open |
| Collect cost on bridge 2 | Held requests are billed by duration on Workers | Before real use; see BRIDGES |
| The service worker is not exercised by any test | The browser test runs a development build, which registers none. Opening offline was checked by reading only | With the first production browser test |
| A stalled connection to a bridge | Seen once, from one laptop, to bridge 2 only (BRIDGES). The Receiver now gives up on a collect after 75 s and tries again, so a stall costs a delay and not the session. Whether a phone ever sees it is unknown | Watch for it |
| SIM identity on Android 10+ | An ordinary app gets an empty ICCID there, so the route is keyed by subscription id. That it stays with its SIM across reboots and re-insertion is assumed, not seen | Step 3, on a dual-SIM phone |
| The outbox, the drain loop and the settings store have no test of their own | They need Android's SQLite and Keystore. The emulator check runs them on the happy path; retry timing, dead rows and the unreadable-settings guard are checked by reading only | When it bites |
| The emulator check is not in CI | It needs an emulator and reaches the live bridges. It is run by hand before a release | Before the second release |
| A command to a sleeping phone | The Host waits for commands on a held request. Whether that survives hours of deep sleep on a real phone is unknown (D28) | Step 3, on hardware |
| A second Receiver reads every SIM by default | Right for one SIM, a surprise for two (D27) | Watch the first household that has two |
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
