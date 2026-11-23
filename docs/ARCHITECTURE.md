---
type: Reference
title: Architecture
description: A Host, a Receiver and any number of bridges that cannot read what they carry.
status: active
created: 2026-09-17
timestamp: 2026-11-23
tags: []
---

# Architecture

Two products, the Host and the Receiver, and bridges that connect them. Why each
choice was made is in [DECISIONS.md](DECISIONS.md); this file says what exists.

```
  Host (Android, in Iran)                         Receiver (anywhere)
  ───────────────────────                         ───────────────────
  SmsReceiver                                     collects from every bridge
     ↓ persist first                              opens with its private key
  Outbox (sealed at rest)                         shows each message once
     ↓                                                     ▲
  ForwarderService                                         │
     │ seal to each Receiver's public key                  │
     ├──────────▶ bridge 1  easyotp.arsalan.finlawgpt.ir ──┤
     ├──────────▶ bridge 2  easyotp.cfworker.rhinocloud.ir ┤
     └──────────▶ bridge n ────────────────────────────────┘
```

## The repository

| Directory | What it is | Runs on |
|---|---|---|
| `host/` | The Host app's native core, Kotlin | Android 8+ |
| `bridge/` | The bridge, TypeScript. One protocol, two entry points | Cloudflare Workers; Node in a container |
| `receiver/` | The Receiver: a web app, and the pairing and opening code under it | Browsers |
| `docs/` | This record | |

Gradle is at the root with one module, `:host`. `bridge/` and `receiver/` are
separate npm packages.

## 1. Capture (Host)

`SmsReceiver` is declared in the manifest, so it fires with the app process dead.

1. Read the PDUs and join the parts of a multipart SMS. A code split across two
   parts is useless in both halves.
2. Resolve the subscription to an **ICCID** through `SimRegistry`. The ICCID is
   the stable identity; slot and subscription id change across reboots and swaps.
   A message that cannot be attributed to a SIM is dropped, never guessed.
3. Write it to the outbox, sealed with a Keystore key. **Persist before anything
   else**: the process may be killed the moment the receiver returns.
4. Wake `ForwarderService`.

## 2. Delivery (Host to bridges)

`ForwarderService` is a `specialUse` foreground service (D7) that drains the
outbox. For each message:

1. Find the SIM's route: its label and its paired Receivers. No route, or consent
   not acknowledged, and the message stays queued.
2. Build the payload: SIM label, sender, body, the code if `MessageClassifier`
   found one, and the time.
3. Seal the payload to each Receiver's public key with HPKE (D5, D16).
4. Deposit each sealed message at **every bridge at once**. One bridge accepting
   is enough.

A message is done when every Receiver's copy has been accepted somewhere.
Otherwise it backs off, capped at five minutes, and tries again.

**The message id.** A bridge sees one cleartext field besides the box: the id,
which the Receiver uses to show a message once. It is
`SHA-256(install salt ‖ outbox key)`, truncated. The salt never leaves the phone,
so the id is stable across retries and bridges and means nothing to anyone else.

## 3. The bridge

A relay with no key and no accounts. It holds sealed messages until the Receiver
they are for collects them.

| Route | Who | What |
|---|---|---|
| `POST /v2/box/<boxId>` | Host | Deposit one sealed message |
| `GET /v2/box/<boxId>` | Receiver | Collect everything waiting; waits if the box is empty |
| `POST /v2/box/<boxId>/ack` | Receiver | Remove what has been collected |
| `POST /v2/pair/<slotId>` | either | Add a pairing message |
| `GET /v2/pair/<slotId>` | either | Read pairing messages; waits if there are none |
| `GET /health` | anyone | Liveness |

**Who may do what** is decided from the request alone:

```
boxKey  --SHA-256-->  boxId
(Receiver only)       (Host, bridge, the URL)
```

The Receiver makes `boxKey` and gives the Host only `boxId`. Knowing the id lets
a Host deposit. Collecting and acknowledging need the key, which the bridge
checks by hashing it forward. Nothing is stored to make that decision.

**What a bridge keeps.** A message stays until it is acknowledged or 48 hours
old. Collecting does not remove it, so a Receiver that dies between reading and
showing a message gets it again. A box holds at most 100 messages and 512 KB;
past that the oldest goes. A deposit is at most 16 KB.

**Two entry points, one protocol.** `core.ts` is the protocol and knows nothing
about where it runs. `worker.ts` stores a box in a Durable Object. `node.ts`
stores it in memory, mirrored to one file per box. [BRIDGES.md](BRIDGES.md) has
each bridge's contract and measured limits.

## 4. The Receiver

A web app at `pwa.easyotp.rhinocloud.ir`, in Persian and English. In a browser
tab it shows only how to add it to the home screen; it starts once opened from
there (D15).

| File | What it does |
|---|---|
| `src/open.ts` | Opens a sealed message, and refuses one whose id in the seal differs from the id it arrived under |
| `src/pairing.ts` | The Receiver's side of pairing (D24) |
| `src/inbox.ts` | Collects from every bridge, shows a message once, acknowledges only after it is stored |
| `src/app/` | The screens, and `db.ts`: keys, pairings and messages in IndexedDB on the device |

The private key and the box key are made on first use and exist only in that
device's storage. There is no account and no export.

A notification appears only while the app is open or in the background. Waking
a closed app needs web push, which is not built. The Android shell is not built.

## 5. Pairing

The Host shows eight digits, the person beside it reads them over a phone call,
and both screens then show a colour and a thing that must match (D18). Under
that are three messages through a pairing slot on the bridges (D24). Pairing
gives the Host a Receiver's public key and box id.

A slot is found by an id derived from the code, holds at most eight small
messages for ten minutes, and is never written to disk. Only a post creates
one; a read of a slot nobody has posted to is answered after a short wait.

The Receiver's side is built. The Host app's side is not: until it is,
`npm run fake-host` in `receiver/` stands in for a phone.

## 6. Updating without a new APK

Not built. The design is D19: the Host's native core is fixed, and its screens
and configuration arrive as signed files through the bridges.

## 7. Surviving the phone's manufacturer

Not built. The code is the same on every phone; what differs is the setup each
manufacturer demands before it stops killing background services. The Host will
detect the brand, open the right settings screen, and then send a test message
through the real path to prove it worked.

## 8. Permissions

`RECEIVE_SMS`, `READ_PHONE_STATE` (to identify the SIM), `INTERNET`,
`FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_SPECIAL_USE`,
`RECEIVE_BOOT_COMPLETED`, `POST_NOTIFICATIONS`,
`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`.

Not `READ_SMS`. `RECEIVE_SMS` delivers new messages; `READ_SMS` would also open
the whole inbox, which the Host has no reason to touch. Not a notification
listener and not accessibility.
