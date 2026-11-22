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

Written to be picked up cold. Design rationale lives in [DECISIONS.md](DECISIONS.md);
this file is state.

**The direction changed on 2026-11-23** (D15 to D22): no Telegram, a Host and a
Receiver sealed end to end, any number of bridges, screens that update without
an APK, Persian and English throughout. The code below predates that and still
speaks the old protocol. [ARCHITECTURE.md](ARCHITECTURE.md) and
[THREAT-MODEL.md](THREAT-MODEL.md) also still describe the Telegram design and
are rewritten with step 2.

**Nothing has run on a real phone, and no bridge is deployed.** That is still the
most important fact on this page.

---

## 1. What exists

| Piece | State under the new direction |
|---|---|
| SMS capture, SIM registry, encrypted outbox, key vault, OTP classifier | Kept as the Host core. Unit-tested, never run on hardware |
| Failover policy, relay client | Kept. Two hard-coded endpoints, to become n from a signed list (D17) |
| HPKE sealing, Kotlin and TypeScript, pinned by a fixture | Kept. Seals to the bridge today, to the Receiver after D16 |
| Bridge mailbox and identifier chain (`worker/`) | Kept. Holds messages for seconds, in memory; D16 needs bounded retention |
| Telegram calls, bot enrolment, webhook routes | Dead. To delete (D15) |
| Screens | A placeholder. To be the signed web bundle (D19) |
| Build | GitHub Actions, signed with the release key (D20) |

Tests as of the last full run: 57 Android, 20 bridge.

## 2. Not built

- The Receiver, in either form.
- Pairing (D18).
- The signed bundle and config loader, and the bridge list (D17, D19).
- Heartbeat with battery and charger state.
- The per-brand setup wizard and self-test.
- Bridge 1 on Arsalan. Bridge 2 is written but not deployed.
- The dormant self-update (D19).

## 3. Build order

1. ~~Actions builds and signs the Host APK.~~ Done.
2. Bridge 2 on Cloudflare; Host and Receiver PWA paired by code; a real SMS
   arrives. Telegram code deleted in the same step.
3. Signed bundle and config, proven by changing a screen without a new APK.
4. Wizard, health checks, heartbeat.
5. Bridge 1 on Arsalan.
6. Receiver APK.

## 4. Open debts

| Debt | Why it matters | When |
|---|---|---|
| Gradle dependency verification (D11) | A release resolves dependencies on reputation alone | Before the first tagged release |
| AndroidX pinned a generation back | The newer generation needs compileSdk 37 | When 37 is stable |
| Unverified on hardware | Sideloaded install with `RECEIVE_SMS` on Android 15+, service survival on Xiaomi and Samsung, silent self-update on Android 12+ | Step 2 |
| Deep hostnames on Cloudflare's free certificate | May force flatter bridge names | Step 2 |
| `dl.amirsalmani.com` from inside Iran | The first download may need a fallback on bridge 1 | Step 5 |
| Payment rails (D8), consent recording | Unchanged | Later |

## 5. Toolchain facts that cost hours

- AGP 9 has Kotlin built in; the standalone `kotlin-android` plugin is rejected.
- AGP 9 requires Build Tools 36+ and ignores an override to an earlier one.
- `platforms;android-37` appears in `sdkmanager --list` but will not install.
- `org.json` is a stub in Android unit tests and throws "not mocked". A real
  `org.json` is on the test classpath.
- `android-actions/setup-android@v3` fails on current runners. The runner's own
  SDK plus accepted licences is enough.
