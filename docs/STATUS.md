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

**Everything works end to end on an emulator and nothing has yet run on a real
Android phone.** That is the most important fact on this page: a real SIM, a
real carrier and a phone left alone for days are what is left to prove.

---

## 1. Built and tested

| Part | What works | Proof |
|---|---|---|
| Host: capture | SMS receiver, SIM identity, sealed outbox, dedupe, backoff. Nothing is kept until the owner has agreed and someone is paired | Unit tests; the emulator check |
| Host: delivery | Seals to each Receiver that reads the SIM, deposits at every bridge, tracks bridge health | Unit tests against a fake connection; the emulator check |
| Host: pairing | The Host's side in Kotlin: commit, open the sealed offer, reveal, hand over a command channel | Unit tests; a written-down pairing both sides recompute; the emulator check |
| Host: reports and commands | A status report about every fifteen minutes and on request; rings and vibrates when asked; answers naming the command | The emulator check. The fifteen-minute alarm itself was not waited for |
| Host: screens | Setup one permission at a time, home, pairing with code and picture, which SIMs a Receiver reads, disconnect, test message, the phone's name. Persian and English | The emulator check drives them; seen in a browser against a stand-in |
| Receiver web app | Install gate, pairing, several Hosts each with its own keys, a monitor per Host, messages shown once, copy, side panel, Persian and English | `npm run e2e`. Used on an iPhone on 2026-11-23 |
| Receiver Android app | The same screens in an APK, with Android notifications | Paired with the Host app on one emulator and showed its SMS. Notifications were not looked at |
| Bridge | Deposit, collect with hold, acknowledge, expiry, limits, key-only access, pairing slots | Tests on the Workers runtime and on Node |
| Bridge image | Runs unprivileged, read-only, 256 MB, clean exit on SIGTERM | CI runs it that way before publishing |
| Host to Receiver | An SMS and a status report sealed by the Host's code open in the Receiver's | Fixture regenerated in CI every run |
| Build | Signed Host and Receiver APKs and the bridge image from GitHub Actions | `build.yml` |

**The emulator check** is `npm run emulator-check` in `receiver/`: the Host app
on Android 16, the live bridges, and a script playing the Receiver. It passed
on 2026-11-24 with a debug build and with the shrunk release build.

## 2. Not built

- Waking a closed Receiver: web push for the PWA, a background collector for the Android app.
- The signed screen bundle and config loader, and the signed bridge list (D17, D19). The Host's screens ship inside the APK.
- Per-brand guidance for the settings each manufacturer hides its app-killer behind (ARCHITECTURE 7).
- The dormant self-update (D19).
- Checking a SIM's balance by USSD.

## 3. Deployed

| Thing | State |
|---|---|
| Bridge 1 | Live. Its host follows the `live` image tag, which moves when `main` builds |
| Bridge 2 | Live. Deployed by hand: `wrangler deploy` from `bridge/` |
| Receiver web app | Live at `pwa.easyotp.rhinocloud.ir`. Deployed by hand: `npm run deploy` from `receiver/` |
| Download links | `dl.amirsalmani.com/s/…` is live and returns 404 until the first release |
| A release | None. No tag has been cut. Every push builds signed APKs as workflow artifacts |

## 4. Build order

1. ~~Actions builds and signs the Host APK.~~ Done.
2. ~~One repository; the new bridge protocol.~~ Done.
3. ~~Bridges deployed; Receiver web app; Host pairing and screens; Receiver APK.~~ Done. **Next: a real SMS on a real phone**, then the first release.
4. Signed bundle and config, proven by changing a screen without a new APK.
5. Per-brand setup guidance.
6. Waking a closed Receiver.

## 5. Open debts

| Debt | Why it matters | When |
|---|---|---|
| Gradle dependency verification (D11) | A release resolves dependencies on reputation alone | Before the first release |
| False messages (THREAT-MODEL A5) | Whoever learns a Receiver's public key and box id can deposit a forged message. Pairing keeps both from a bridge | Open |
| Collect cost on bridge 2 | Held requests are billed by duration on Workers | Before real use; see BRIDGES |
| The service worker is not exercised by any test | The browser test runs a development build, which registers none. Opening offline was checked by reading only | With the first production browser test |
| A stalled connection to a bridge | Seen once, from one laptop, to bridge 2 only (BRIDGES). The Receiver now gives up on a collect after 75 s and tries again, so a stall costs a delay and not the session. Whether a phone ever sees it is unknown | Watch for it |
| No rate limit on deposit | A known box id can be flooded until its oldest messages fall out | With bridge 2's deploy |
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
