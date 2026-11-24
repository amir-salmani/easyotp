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
| `receiver/` | The screens, TypeScript: the Receiver web app, and the Host's screens beside it | Browsers; a WebView inside each app |
| `receiver-apk/` | The Receiver as an Android app: a window and notifications around the same screens | Android 8+ |
| `shell/` | What the two apps share: serving bundled screens to a WebView | |
| `bridge/` | The bridge, TypeScript. One protocol, two entry points | Cloudflare Workers; Node in a container |
| `docs/` | This record | |

Gradle is at the root with three modules, `:host`, `:receiver-apk` and
`:shell`. `bridge/` and `receiver/` are separate npm packages. The apps' screens
are built from `receiver/` into each app's assets before Gradle runs
(`npm run build:host`, `npm run build:apk`); they are not in git.

## 1. Capture (Host)

`SmsReceiver` is declared in the manifest, so it fires with the app process dead.

1. Read the PDUs and join the parts of a multipart SMS. A code split across two
   parts is useless in both halves.
2. Resolve the subscription to an **ICCID** through `SimRegistry`. The ICCID is
   the stable identity; slot and subscription id change across reboots and swaps.
   A message that cannot be attributed to a SIM is dropped, never guessed.
3. Stop if nobody reads this SIM: the owner has not agreed yet, or no Receiver
   is paired to it. Until then this is a phone receiving its own messages and
   nothing is kept (D27).
4. Write it to the outbox, sealed with a Keystore key. **Persist before anything
   else**: the process may be killed the moment the receiver returns.
5. Wake `ForwarderService`.

## 2. Delivery (Host to bridges)

`ForwarderService` is a `specialUse` foreground service (D7) that drains the
outbox. For each message:

1. Find who reads this SIM. Every paired Receiver does, unless the owner
   narrowed one to particular SIMs (D27).
2. Build the payload: SIM label, sender, body, the code if `MessageClassifier`
   found one, and the time.
3. Seal the payload to each Receiver's public key with HPKE (D5, D16).
4. Deposit each sealed message at **every bridge at once**. One bridge accepting
   is enough.

A message is done when every Receiver's copy has been accepted somewhere.
Otherwise it backs off, capped at five minutes, and tries again.

**Reports and commands (D26).** An alarm wakes the service about every twelve
minutes to send each Receiver a status report: battery, charging, network and
how many SMS are waiting. An alarm, because a thread's timer does not run on a
phone in deep sleep. For each Receiver the service also waits for commands, at
one bridge at a time, and looks at the others on every alarm (D28). `buzz`
rings as an alarm for twenty seconds and vibrates; either command is answered
with a report that names it.

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

**What a bridge keeps.** A deposit may carry a tag; only the newest message
with a given tag is kept, which is how a Host's report on itself replaces the
last one (D26). A message stays until it is acknowledged or 48 hours
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
| `src/commands.ts` | Seals a command to a Host and leaves it at every bridge |
| `src/spam.ts` | Decides which messages are listed under Spam |
| `src/app/` | The screens, and `db.ts`: keys, pairings and messages in IndexedDB on the device |

Every paired Host gets its own key pair and its own box (D25), made when the
pairing starts and kept only if the picture is confirmed. They exist only in
that device's storage. There is no account and no export. Removing a Host
deletes its keys and its messages together.

Above the messages is a monitor for each Host: whether it is alive, when it
was last heard, its battery and network, and buttons to make it ring or report
now (D26).

**Spam.** Advertising is listed apart from the messages, so it does not bury
the codes. A person marks a sender as spam, or not spam, under any message, and
that covers everything the sender has sent and will send. Messages that carry
the carriers' opt-out line, or a sale with a link, are set aside without being
asked; one that carries a code never is. Sorting is done on the Receiver and
changes only where a message is listed: the Host forwards everything, nothing
is deleted, and spam raises no notification.

Behind a gear on the message list is a side panel: the Hosts, with rename and
remove; language, notifications and deleting all messages; and the help.

**Notifications.** While the app is open or in the background it notifies of
a new message itself. With it closed, a bridge wakes it: the app leaves its
browser's push address at the bridges (`src/push.ts`), bridge 2 sends an empty
push when a message arrives, and the service worker says a message is waiting
(D30). Spam raises neither.

**As an Android app.** `receiver-apk/` packs the same build into an APK and
shows it in a WebView. Inside it the screens skip the install step and the
service worker, and ask the app to raise notifications (`src/app/shell.ts`,
`ShellApi` in `MainActivity.kt`). It asks for no SMS permission and runs
nothing in the background.

## 5. Pairing

The Host shows eight digits, the person beside it reads them over a phone call,
and both screens then show a colour and a thing that must match (D18). Under
that are three messages through a pairing slot on the bridges (D24). Pairing
gives the Host a Receiver's public key and box id.

A slot is found by an id derived from the code, holds at most eight small
messages for ten minutes, and is never written to disk. Only a post creates
one; a read of a slot nobody has posted to is answered after a short wait.

Both sides are built: `src/pairing.ts` for the Receiver, `HostPairing.kt` for
the Host. They are two implementations of one protocol, held together by a
pairing written down in `receiver/test/pairing-vectors.json` that a test on
each side recomputes. `npm run fake-host` in `receiver/` still stands in for a
phone when there is none to hand.

## 6. The Host's screens, and updating them

The Host's screens are a web build (`receiver/src/host-app/`) shown in a
WebView. They are kept apart from the native core by one narrow interface,
`HostApi.kt`, mirrored in `native.ts`:

- `state()` returns everything the screens draw, as JSON;
- the other methods are the buttons: ask for a permission, start or answer a
  pairing, choose a Receiver's SIMs, remove one, send a test message.

The screens hold no key and make no request. The shell refuses any request
they make that is not for a bundled file, and sends a content security policy
that says the same (`WebShell.kt`).

Today the build ships inside the APK. Fetching a signed build through the
bridges, so screens change without a new APK, is D19 and is not built. The
split it needs is in place.

## 7. Surviving the phone's manufacturer

Partly built. Setup asks for the battery exemption Android itself offers, and
the home screen has a button that sends a test message through the real path
and says whether a bridge took it. Not built: detecting the brand and opening
the extra settings screen each manufacturer hides its own app-killer behind.

## 8. Permissions

`RECEIVE_SMS`, `READ_PHONE_STATE` (to identify the SIM), `INTERNET`,
`FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_SPECIAL_USE`,
`RECEIVE_BOOT_COMPLETED`, `POST_NOTIFICATIONS`,
`REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`, `ACCESS_NETWORK_STATE` (for the status
report), `VIBRATE` and `WAKE_LOCK` (to ring, and to finish a send before the
phone sleeps again).

They are asked for one at a time, each after a sentence saying what it is for.
On Android 15 and later an app installed from outside the store is refused
`RECEIVE_SMS` until the owner allows "restricted settings" for it; setup says
so and opens the right screen.

Not `READ_SMS`. `RECEIVE_SMS` delivers new messages; `READ_SMS` would also open
the whole inbox, which the Host has no reason to touch. Not a notification
listener and not accessibility.
