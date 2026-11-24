---
type: Reference
title: Threat model
description: What EasyOTP defends, against whom, and what it does not.
status: active
created: 2026-09-17
timestamp: 2026-11-23
tags: []
---

# Threat model

An SMS forwarder is a tool for intercepting credentials, pointed at yourself.
That is exactly what an attacker wants installed on your phone. Every choice
here follows from taking that seriously.

## Assets

| Asset | Where it lives | If lost |
|---|---|---|
| Messages in transit | Host, bridges, Receiver | Account takeover: bank, government, exchange |
| A Receiver's private key | The Receiver only | Everything sent to that Receiver can be read |
| A Receiver's box key | The Receiver only | Its sealed messages can be collected and deleted, not read |
| Pairings (public key and box id per Receiver) | Host, sealed at rest | An attacker can send that Receiver false messages |
| The outbox | Host, sealed at rest | Recent messages, senders, timing |
| The release signing key | CI secrets and the encrypted secrets repository | A forged update would be accepted by every installed phone |

## Adversaries

**A1. A network observer** (an Iranian ISP, a CDN in front of a bridge). Sees TLS
metadata, and a CDN that terminates TLS sees the request itself. Every message
is sealed to the Receiver before it leaves the Host, so what is visible is a box
id, a message id that means nothing off the phone, sizes and timing. An observer
learns that a phone forwards messages and roughly when. Not mitigated.

**A2. A bridge operator, or whoever takes over a bridge.** Holds sealed messages
and has no key, so **cannot read one**. Can withhold or delete them, which the
other bridges cover, and can see which box receives how much and when. Can
deposit into any box whose id it has seen, which is A5.

**A3. Someone with the Host phone in their hands.** Wins. It is the SIM. What
software can do is limit how much history they get: the outbox and the pairings
are sealed with a Keystore key, and nothing is included in backups.

**A4. Someone with a Receiver device, unlocked.** Reads everything that Receiver
can. Its private key cannot be taken back; the remedy is to remove that Receiver
at the Host and pair again.

**A5. Someone who learns a Receiver's public key and box id.** Can seal a
message that opens on that Receiver and deposit it: a false message, such as a
fake code prompt. Cannot read anything. HPKE base mode is public-key encryption
and does not say who sealed a message, so the public key is kept between the
two devices: at pairing it travels sealed to a one-time key of the Host's
(D24), and afterwards it is on the Host, sealed at rest. A bridge knows the box
id, from the deposit URL, and never the key. What remains is a breach of the
Host's settings, or the one blind try in 512 at pairing. Closing it fully means
the Host signing each message, which is not built.

**A6. Someone between the two people at pairing.** Would have to relay both
halves. The picture both screens show is derived from what each side ended up
with, and the order of the exchange stops a bridge from steering the two
pictures to match (D24). It has one blind try in 512, and a failed try is seen
by both people. Tested against a bridge that swaps the key, one that only reads
it, one that renames a side and one that changes the nonce.

**A7. A replayed or duplicated message.** A bridge can deliver the same sealed
message again. The Receiver shows a message once per id, and refuses a message
whose id in the seal differs from the id it was delivered under.

**A8. A forged update.** Screens and configuration are code and data that reach
the phone through bridges. They are signed, and the core verifies the signature
before use (D19). An APK update must carry the release key's signature, which
Android enforces. Not built yet.

## Not defended

- **Hiding that the app exists** from someone looking at the phone. It shows a
  permanent notification, by design and by Android's rules.
- **A compromised Android**, or hostile firmware from the manufacturer.
- **A national internet shutdown.** Messages wait on the phone.
- **Traffic analysis** by a bridge or a network: who, when, how much.

## Rules the code must hold

Each is a test or a property of the build, not an intention.

1. Nothing a person wrote or received, and no key, reaches a log, on the Host
   or a bridge. The bridge's logger accepts a closed set of scalar fields.
2. A bridge has no key and never opens anything. No sealing library is among
   its dependencies.
3. A box is opened only by its key. Its id, alone, opens nothing.
4. A message is removed from the Host's outbox only after every Receiver's copy
   was accepted by a bridge.
5. A message leaves a bridge only when acknowledged or expired.
6. The outbox and the settings are sealed at rest with a Keystore key and
   excluded from backup.
7. The Receiver shows a message only if the id in the seal matches the id it
   arrived under.
8. An APK is published only if it is signed with the release key (checked in CI).

## Legal and consent

The product forwards messages from SIM cards the operator physically holds.
Where a SIM belongs to someone else, which is the household case this was built
for, the Host records the owner's explicit acknowledgement before it captures
or forwards anything, and lets each Receiver be limited to particular SIMs
(D27). That is a product requirement, not legal advice: countries
differ on intercepting another person's messages. Sold commercially, this needs
review under Finnish and EU law first.
