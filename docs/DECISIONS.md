---
type: Reference
title: "Decision log"
description: "Format: one decision per entry. Date, what was chosen, what was rejected, why."
status: active
created: 2026-09-17
timestamp: 2026-09-17
tags: []
---

# Decision log

Format: one decision per entry. Date, what was chosen, what was rejected, why.
Decisions here are settled — reopen only with new evidence, don't re-derive.

---

## D1 — Native Kotlin, not Tauri (2026-08-30)

> **Amended by D19 (2026-11-23).** The capture path stays native for the reason below. The screens move to a signed web bundle.

**Chosen:** 100% native Android (Kotlin + Jetpack Compose). No Tauri, no WebView.

**Rejected:** Tauri v2 Android shell with a Kotlin plugin for the capture path.

**Why:** A Tauri app is a WebView + Rust process. When Android kills that process —
and it will, unattended, within hours — the Rust and JS are gone. A manifest-declared
`BroadcastReceiver` for `SMS_RECEIVED` still fires with the app dead, because it is
exempt from the implicit-broadcast ban. That means the entire critical path had to be
Kotlin regardless, leaving Tauri as a UI skin over a native engine: added toolchain,
added build surface, added APK size, zero benefit. Compose does the same job natively.

---

## D2 — Two front doors, one origin (2026-08-30)

> **Superseded by D17 (2026-11-23).** Bridges are now independent origins, and there can be any number of them.

**Chosen:** `otp.services.amirsalmani.com` (Cloudflare zone → Worker custom domain) and
`otp.services.rhinocloud.ir` (ArvanCloud CDN → origin `*.workers.dev`). Both terminate
at the same Worker.

**Rejected:** SMS fallback to a foreign number; independent second origin on an
Iranian VPS.

**Why (and the limit):** The dominant real-world failure is Iranian consumer ISPs
DPI/SNI-blocking Cloudflare edge. The Arvan leg defeats that, because Arvan's
international transit is not the path a consumer handset takes. It is fast (domestic,
sub-50ms) and survives most disruption.

It does **not** survive a full international cutoff — then Arvan→Cloudflare fails too.
These are two front doors on one origin, not two failure domains. With SMS fallback
declined, a national shutdown means messages queue on-device and deliver on restore.
This is an accepted trade, made knowingly, not an oversight.

**Escape hatch if it ever matters:** a second origin hosted inside Iran makes the two
legs genuinely independent failure domains. Deferred, not designed away.

**To verify before building the .ir leg:** whether ArvanCloud permits a foreign origin
at all, and whether it can override the Host header to the `workers.dev` hostname
(Workers route by Host; without the override the origin fetch 404s). Arvan's own docs
are unreachable from outside Iran — check from inside the country, or via the panel.

---

## D3 — Stateless relay, no database (2026-08-30)

> **Amended by D16 (2026-11-23).** A bridge now holds sealed messages until a Receiver collects them. It still holds nothing it can read.

**Chosen:** Worker persists nothing. All state — message archive, routing rules,
destinations, credentials — lives on the phone. One Durable Object per channel acts
as a **memory-only mailbox** for the seconds between a Telegram webhook arriving and
the phone's long-poll collecting it. No storage writes.

**Rejected:** D1 archive, KV-backed config, server-side dashboard.

**Why:** Bidirectional messaging needs a rendezvous point, because the phone is behind
CGNAT and cannot be reached inbound. A memory-only DO is the minimum structure that
provides one. Anything persistent turns the relay into a target holding other people's
OTPs, which is the exact thing the product exists to avoid. "We store nothing" has to
be literally true or it is worthless.

---

## D4 — Bring-your-own bot; pairing approved on-device (2026-08-30)

> **Superseded by D15 and D18 (2026-11-23).** Telegram is gone. Pairing is the spoken code.

**Chosen:** Each user creates their own bot via @BotFather and pastes the token into
the app. The app seals it and calls `/enroll`; the **Worker** calls Telegram
`setWebhook` on the phone's behalf, then discards the token. The token rides inside
the sealed envelope on every subsequent forward and is used transiently.

Destination pairing: user messages their own bot, the update lands at the Worker, is
parked in the DO mailbox, and the phone's long-poll retrieves it. The **app** then
prompts the holder to approve that chat_id.

**Rejected:** Server-side account system; server-held ACL; app calling Telegram directly.

**Why:** `api.telegram.org` is blocked in Iran, so the phone cannot call `setWebhook`
itself — the Worker must proxy it. And approving destinations on the device means the
authorization root is physical possession of the handset, with no server-side list to
breach or misconfigure. No accounts also means no PII and no user database.

---

## D5 — Crypto primitives (2026-08-30)

**Chosen:**
- Device identity: **ECDSA P-256** in Android Keystore, hardware-backed (StrongBox
  when available, TEE otherwise). Signs every request over a canonical body+timestamp.
- Payload sealing: **HPKE (RFC 9180)** — X25519 + HKDF-SHA256 + ChaCha20-Poly1305 —
  to the Worker's public key.
- Replay defence: timestamp window plus nonce.

**Rejected:** Ed25519 in Keystore.

**Why:** Android Keystore's Ed25519 support is narrow and version-dependent; ECDSA
P-256 is hardware-backed on effectively every device we target. HPKE means Arvan and
the Cloudflare edge relay opaque bytes — the `.ir` leg transits Iranian infrastructure
under Iranian jurisdiction, and sealing is what makes that an acceptable trade rather
than a bad one.

**Amended 2026-08-30, during implementation.** The per-request ECDSA signature was
**removed**. On a relay that stores nothing there is no device registry, so a signature
can only prove that *someone* holds *some* key — it verifies against no known identity
and is therefore decoration. Shipping unverifiable crypto is worse than shipping none,
because it invites the belief that authentication exists.

What replaced it is a one-way hash chain that *is* verifiable without state:

```
channelId  --H-->  secretToken  --H-->  webhookId
 (device)          (Telegram)            (public URL)
```

The relay authorises by hashing forward: a webhook delivery is genuine if
`H(presented secret) == webhookId` in the path, and a mailbox drain is authorised if
`H(H(presented channelId)) == webhookId`. Telegram knows `secretToken` and so can post
updates, but cannot read the mailbox. Anyone who scrapes the public webhook URL gets
`webhookId`, which grants nothing. No stored mapping is required at any point.

Authentication for `/forward` is the **bot token inside the sealed envelope**, which
matches reality — anyone holding that token could message the bot directly regardless.

Keystore-backed ECDSA returns when licensing does (D9): a license token bound to a
device public key makes proof-of-possession meaningful, because then the relay has
something to verify *against*.

---

## D6 — Multiple bots, not forum topics (2026-08-30)

> **Superseded by D15 (2026-11-23).** The routing table survives with Receivers in place of bots: SIM, pinned to ICCID, to N paired Receivers.

**Chosen:** Routing table on-device: SIM (pinned to **ICCID**, so it survives a slot
swap) → N destinations, each `(bot, chat_id, label)`. Different SIMs can target
entirely different bots owned by different people.

**Rejected:** One bot, per-SIM forum topics in a shared supergroup.

**Why:** The two-SIM household case is the small case. The product case is N people
who each want their own line in their own bot, not shared visibility into one group.
Separate bots make the trust boundary per-person and need no supergroup setup. Topics
remain possible for anyone who prefers a single bot; they are not the default.

---

## D7 — Foreground service type `specialUse` (2026-08-30)

**Chosen:** `android:foregroundServiceType="specialUse"`.

**Rejected:** `dataSync`.

**Why:** Android 15 caps `dataSync` foreground services at 6 hours per 24h. A
persistent forwarder using it dies daily, silently. `specialUse` has no such cap. The
Play Store justification requirement for `specialUse` does not bind us — distribution
is sideload/direct, and SMS permissions would disqualify us from Play anyway.

---

## D8 — Monetization and payment rails (2026-08-30)

**Chosen:** AGPL-3.0 for everything. Revenue is a subscription to the **hosted relay**,
billed through a **merchant of record** (Paddle or equivalent) once the Finnish `Oy`
exists. No billing code is written before then.

**Rejected:** routing payments through another person's foreign payment account;
open-core with paid modules; Stripe-direct.

**Why:** A foreign payment gateway is not available to an Iran-resident individual.
That constraint is temporary and already scheduled away — the Finland company decision
records that the `Oy` is registered *after* Tampere residency, and relocation is weeks
out. A Finnish `Oy` makes Paddle or Stripe routine.

Borrowing someone else's account is the tempting shortcut and the wrong trade: it
misrepresents beneficial ownership to the provider, moves legal and tax liability onto
whoever's name is on it, and typically ends in frozen funds when the mismatch surfaces.
For a product sold on "don't trust a random OTP forwarder — here is exactly who we
are," opaque ownership destroys the asset being sold. Weeks of delay is the cheaper
side of that trade.

**Merchant of record over Stripe-direct** because MoR absorbs global VAT/sales-tax
registration, invoicing, and chargebacks. Selling a small subscription into thirty
countries as a solo operator, tax compliance is the headache, not card processing.

**Sanctions reality:** paying customers are diaspora holding non-Iranian cards, which
is exactly the target market. Customers still inside Iran cannot be billed by any
Western processor and are served by the free self-hosted path — which the AGPL
guarantees rather than merely permits.

**Consequence:** ship free and self-hostable now. Revenue work starts when the `Oy`
does.

---

## D9 — Entitlement without a database (2026-08-30)

**Chosen:** Offline-verifiable **signed license tokens**. The billing system issues a
short-lived (≈7 day) Ed25519-signed token to the app; the app presents it with each
relay request; the relay verifies signature and expiry against a public key in its
environment. No lookup, no user record.

**Rejected:** the relay querying a subscriptions table.

**Why:** D3 says the relay stores nothing, and a paid tier is the obvious pressure to
break that. A subscriptions table on the relay reintroduces precisely the user database
this design exists to avoid, and parks billing identity next to message traffic — the
two things that must never be correlatable.

Signed tokens keep the relay stateless and keep billing in a **separate Worker** with
its own storage that never sees message content or bot tokens. The cost is revocation
lag bounded by the token TTL: a cancelled subscription keeps working until the token
expires. That is an acceptable price for not holding a customer database next to
other people's OTPs.

---

## D10 — The build environment is published, not built locally (2026-08-30)

> **Superseded by D20 (2026-11-23).** There is no build image. GitHub Actions builds everything.

**Chosen:** CI builds the Android build image and pushes it to
`ghcr.io/<owner>/easyotp-build`. Workstations pull it. `./dev pull` is the normal
path; `./dev build-image` exists as a fallback.

**Rejected:** each developer building the image from the Dockerfile.

**Why:** the primary development machine is in Iran, and measured from it:

| Endpoint | Result |
|---|---|
| `dl.google.com` (Android SDK) | 404 — including permanently valid URLs |
| `developer.android.com` | 403 |
| Docker Hub | 403 |
| `ghcr.io` | reachable, pulls succeed |

Google restricts Android developer downloads from Iranian addresses and Docker Inc.
blocks Iran outright, so a local build fails at the base image before it ever reaches
the SDK. A proxy may or may not cover these depending on its routing rules; depending
on one is not a build system.

Publishing the image is also better on its own terms: the environment CI tests in is
byte-identical to the one on the workstation, which is the usual reason to do this
anyway. The blockade only forced a good practice earlier than convenient.

**Consequence:** contributors inside Iran need a `read:packages` token for ghcr.io and
nothing else. Contributors elsewhere can use either path. This is worth stating in
CONTRIBUTING — a project for Iranians that cannot be built from Iran would be a poor
joke.

---

## D11 — Dependency mirrors, and the supply-chain debt they create (2026-08-30)

> **Amended 2026-11-23.** The mirror is removed: nothing is built outside CI any more (D20). Dependency verification is still owed before a release.

**Chosen:** builds may resolve AndroidX and Gradle plugins through a third-party
mirror, opt-in per machine via `EASYOTP_MIRRORS=true`. CI and unrestricted
contributors use Google and Maven Central directly.

**Rejected:** making the mirror the default; vendoring artifacts into the repo.

**Why:** Google's Maven repository is served from `dl.google.com`, which is blocked
from the primary development machine (D10). Without a mirror the Android build cannot
resolve a single AndroidX artifact, so there is no build at all.

**The debt, stated plainly.** A mirror is an entity that can serve a *different* artifact
than the one the authoritative repository holds. For an app that handles other people's
one-time passwords, silently trusting one is exactly the supply-chain compromise the
threat model is supposed to care about — and it is invisible in a successful build.

Three things keep it honest rather than hidden:

1. **Opt-in and environment-scoped.** It cannot be switched on by a committed file, so
   a contributor never uses a mirror without having typed it.
2. **CI never uses it.** The published APK is built from the authoritative repositories.
3. **Gradle dependency verification is the real fix** — `gradle/verification-metadata.xml`
   with checksums generated in CI from Google and Maven Central, then enforced locally.
   The mirror may then serve bytes, but not *different* bytes.

Item 3 is **not yet implemented** and is the outstanding debt. It should land once the
dependency set stops moving, and before any release build. Until then, a mirrored local
build is a development convenience and must never produce a shipped artifact.

---

## D12 — Hand-written SQLite for the outbox, not Room (2026-08-30)

> **Still stands, and went further on 2026-11-23:** the Host now has no AndroidX dependency at all.

**Chosen:** a single `SQLiteOpenHelper` and a small DAO, roughly 150 lines.

**Rejected:** Room with KSP.

**Why:** the outbox is **one table**. Room's value is code generation across a schema
of many entities and relations; here it buys almost nothing and costs an annotation
processor. That processor is not free right now: AGP 9 provides Kotlin support built
in, KSP versions are pinned to exact Kotlin releases, and this project has already
spent several cycles on toolchain drift it did not choose. Adding a codegen plugin to
the critical path of a build that must work from a network where half the ecosystem is
blocked is a poor trade.

It also helps the security story. The outbox is where other people's messages sit at
rest, and a reviewer can read every statement that touches it without first knowing
what Room generated.

**Revisit if** the schema grows past two or three tables with relations between them.

---

## D13 — Encrypt the payload, not the database (2026-08-30)

**Chosen:** message content is sealed with an AES-256-GCM key held in the Android
Keystore and stored as an opaque blob. Queue metadata — the SIM's ICCID, timestamps,
delivery state, attempt counts — is stored in the clear.

**Rejected:** SQLCipher for whole-database encryption.

**Why:** SQLCipher encrypts everything including the columns the queue must sort and
filter on, costs several megabytes of native libraries per ABI, and puts a third-party
crypto implementation on the critical path. Sealing just the payload gives the property
that actually matters — an attacker with the database file gets no message bodies — and
leaves the queue ordinary SQL.

**What this deliberately does not protect:** the metadata. Someone with the file learns
that a given SIM received a message at a given time, and how many messages are pending.
On a device whose physical possession is already game over (THREAT-MODEL A4), spending
complexity to hide timing metadata from an attacker who is holding the SIM would be
theatre.

The Keystore key is non-exportable and hardware-backed where the device offers it, so
the blobs are useless if the database is copied off the device without the key.

---

## D14 — HttpURLConnection, not OkHttp (2026-09-06)

**Chosen:** the platform HTTP client.

**Rejected:** OkHttp.

**Why:** OkHttp 5.5.0 requires compiling against API 37, which is catalogued but
not installable from the stable SDK channel (D10 records the same wall for the
AndroidX generation). Rather than hunt for an older OkHttp release and pin another
dependency to a version nobody upstream is testing, note that Android's
`HttpURLConnection` is *implemented on top of OkHttp* by the platform. The
connection pooling and TLS handling are already there.

What this app asks of an HTTP client is small: POST a sub-kilobyte JSON body with
short timeouts, and later hold a long-poll open for about a minute. All of that is
`setConnectTimeout`, `setReadTimeout`, and a stream.

It also removes a dependency from a security product's supply chain, which is not
nothing while dependency verification is still outstanding (D11).

**Revisit if** the client needs HTTP/2 multiplexing, interceptors, or certificate
pinning against a rotating key set. None of those are on the M1..M3 path.

---

## D15 — Three products, no Telegram (2026-11-23)

**Chosen:** a **Host** and a **Receiver**, and nothing else is a product.

| Product | Where it runs | What it does |
|---|---|---|
| Host APK | the phone holding the SIMs | captures SMS, seals each message to its paired Receivers, sends it through the bridges |
| Receiver PWA, `pwa.easyotp.rhinocloud.ir` | any phone or computer | shows the messages. Works only once added to the home screen, under the name EasyOTP |
| Receiver APK | Android | the same screens in a native shell with native notifications. No SMS permission |

**Rejected:** Telegram as the destination, in any form.

**Why:** Telegram reads every message a bot sends, which the old README had to
admit in its second section. It also made the relay unseal each message to call
the Bot API, and it asked an ordinary person to create a bot with @BotFather.
Owning the Receiver removes all three.

**Consequence:** `worker/src/telegram.ts`, the bot half of `EnrollmentClient` and
the webhook routes are dead code and get deleted.

---

## D16 — Sealed from Host to Receiver; a bridge holds only ciphertext (2026-11-23)

**Chosen:** the Host seals each message with HPKE (the D5 suite, unchanged) to
the public key of each paired Receiver. A bridge stores the sealed message until
that Receiver collects it, bounded by a retention limit, then deletes it.

**Rejected:** sealing to the bridge, as D5 did.

**Why:** with the Receiver holding the private key, no bridge and no network in
between can read a message. THREAT-MODEL A2, "the relay operator can technically
read plaintext", stops being true, and so does the reason an Iranian-hosted
bridge was a hard trade.

**What changes in D3:** "stores nothing" becomes "stores nothing it can read".
A Receiver is often offline, so a mailbox that lasts seconds is not enough. The
retention limit and where a bridge keeps the bytes are per-bridge settings.

**Leverage:** the Kotlin and TypeScript halves of the sealing are already pinned
to each other by a fixture regenerated in CI. The TypeScript half moves from the
Worker into the Receiver.

---

## D17 — Bridges 1 to n, announced by a signed list (2026-11-23)

**Chosen:** a bridge is a dumb, interchangeable relay. The Host sends every
message to every bridge that answers. A Receiver asks every bridge and shows each
message once, using the dedupe key the Host already computes.

| # | Bridge | Path |
|---|---|---|
| 1 | `easyotp.arsalan.finlawgpt.ir` | ArvanCloud CDN, origin in Tehran |
| 2 | `easyotp.cfworker.rhinocloud.ir` | Cloudflare, a Worker |

The set of bridges is a small file signed with a key held offline. Every bridge
serves it; Hosts and Receivers re-read it and verify the signature. **Adding
bridge 3 is one signed line and needs no new APK.** An APK ships with the list
as it stood at build time, as the seed.

**Rejected:** endpoints compiled into the app (`Settings.kt` today); bridges that
sync with each other.

**Why:** D2 had two front doors on one Worker, so one Cloudflare account was a
single point of failure. Two origins in two countries under two operators fail
independently. Bridge 1 runs on capacity that can be switched off at an hour's
notice, which is acceptable only because no single bridge is required.

**Unverified:** whether Cloudflare's free certificate covers hostnames two levels
below `rhinocloud.ir`. Checked at deploy; the fallback is flatter names.

---

## D18 — Pairing by a spoken code and a matching picture (2026-11-23)

**Chosen:** «کد اتصال» (first called «کد آشنایی», renamed on 2026-11-23 because
it read like a referral code). The Host shows eight digits, valid ten minutes. The
person holding it reads them over a phone call; the other person types them into
the Receiver. Both screens then show the same picture and word, and both people
confirm they match.

**Rejected:** QR codes; pairing links; accounts.

**Why:** the Host is in Iran and the Receiver is abroad, so the two devices are
almost never in the same room, and the person beside the Host may be elderly.
Reading a number aloud and naming a fruit needs no camera and no typing. The
picture is derived from the keys both sides ended up with, so anyone sitting in
the middle shows two different pictures. That check, not the secrecy of the
digits, is what makes the pairing safe.

---

## D19 — A fixed native core, and screens that update without an APK (2026-11-23)

**Chosen:** the Host is two layers.

| Layer | Contents | How it changes |
|---|---|---|
| Native core | SMS capture, the sealed outbox, crypto, the background service, permissions | only by a new APK |
| Signed bundle | every screen, the wizard, texts, per-brand guides | fetched through the bridges, verified, cached for offline use |
| Signed config | the bridge list (D17), OTP rules, sender filters | the same route |

The same web screens are the Receiver PWA and the inside of the Receiver APK.

**Rejected:** Compose screens compiled into the APK (the plan in D1);
server-driven UI that needs the network to draw a screen.

**Why:** the app is installed once on a phone nobody will touch again. Android
allows native code and permissions to change only through a new APK, so the
native part is kept small enough that it should not need to. Everything a person
sees can then improve without anyone in Iran doing anything. The bundle is
cached, so a screen never depends on the network.

**The bundle is code, so it is signed.** The core verifies it against a key
compiled into the APK before loading it. A bridge can withhold an update; it
cannot alter one.

**Escape hatch:** the core can install a new APK of itself, signed with the same
release key. It is dormant by default and exists for a security fix in the core.
Whether Android 12+ really allows this with no prompt is **unverified** and must
be proven on a phone.

---

## D20 — Every APK is built and signed in GitHub Actions (2026-11-23)

**Chosen:** `.github/workflows/build.yml` runs the tests, regenerates and checks
the cross-language fixtures, and builds the release APK signed with the one
release key. A tag `v*` publishes a GitHub Release.

**Rejected:** local release builds; the published build image of D10.

**Why:** the workstation has no Android SDK and should not need one. One place
that builds means one place that holds the key.

**The release key** is PKCS12, alias `easyotp`, RSA 4096. It exists in two
places: Actions secrets, and the sops-encrypted secrets repository. Its
certificate's SHA-256 is

```
FA:73:5C:EC:02:67:E0:66:61:1C:E1:AF:A3:1C:50:E6:61:D0:FB:8B:51:D6:ED:2E:39:A5:E8:FB:06:6B:BC:5A
```

and the build fails if an APK is signed with anything else. **Losing this key
strands every installed phone**, because Android accepts an update only from the
key that signed the first install.

**Still owed:** Gradle dependency verification (D11), before the first release.

---

## D21 — One download, from a short link on amirsalmani.com (2026-11-23)

**Chosen:** an APK is downloaded once per person, from
`dl.amirsalmani.com/s/<id>`. The link streams the named asset of the latest
GitHub Release from that domain, and each id is counted. The service lives in
the `amirsalmani-com` repository, not here.

**Rejected:** app stores as the first channel; a raw GitHub link.

**Why:** one id per recipient shows which links were used. Asset names are the
contract between the two repositories: `easyotp-host.apk`, `easyotp-receiver.apk`.

**Unverified:** whether `dl.amirsalmani.com`, which is on Cloudflare, is reachable
from every Iranian network. Bridge 1 can serve the same file as a fallback.

---

## D22 — Persian and English, everywhere, always (2026-11-23)

**Chosen:** every screen, every message a person reads and every public document
exists in both languages. Persian is right-to-left and is the default on a
device set to Persian; a language switch is always reachable.

**Rejected:** Persian only now, English "later".

**Why:** the person beside the Host reads Persian. The person holding the
Receiver may read either. Adding a second language to finished screens costs
more than building both from the first one.

---

## D23 — A box per Receiver, opened by a key the bridge never stores (2026-11-23)

**Chosen:** the bridge protocol in ARCHITECTURE section 3. A Receiver makes a
random `boxKey` and gives the Host `boxId`, a domain-separated SHA-256 of it. The id permits
depositing; collecting and acknowledging need the key. A message stays at a
bridge until acknowledged or 48 hours old.

**Rejected:** accounts or registered devices on the bridge; removing a message
when it is collected; the timestamp-and-replay-window check of the old relay.

**Why:** a bridge that keeps no accounts cannot be breached for them, and one
hash is enough to tell the Receiver from everyone else. Keeping a message until
it is acknowledged means a Receiver that crashes mid-read loses nothing. The
replay window existed to protect a relay that acted on what it opened. This one
opens nothing, and a repeated deposit is stored once.

**The cleartext id.** The Receiver needs an id to show a message once, and the
bridge sees it. The Host derives it from a per-install salt and the outbox key,
so it is stable across retries and bridges and unlinkable to the text by anyone
else.

**What this leaves open:** anyone who learns a Receiver's public key and box id
can put a false message in front of it (THREAT-MODEL A5). Having the Host sign
each message closes that, and is deferred until pairing exists to carry the
Host's key.

---

## D24 — Pairing: commit, offer, reveal, then a picture out of 512 (2026-11-23)

**Chosen:** the exchange behind D18. The code read over the phone only names
where the two devices meet on the bridges. Three messages follow:

| # | From | Carries |
|---|---|---|
| 1 | Host | a commitment (the hash of a nonce it has not shown yet) and a one-time public key |
| 2 | Receiver | sealed to that one-time key: its public key, its box id, its name, a nonce of its own |
| 3 | Host | the nonce it committed to, its name, and which offer it is answering |

Both then show a hash of the code, both nonces, the public key, the box id, the
one-time key and both names, as one of 8 colours and one of 64 things, named in
Persian and English.

**Rejected:** a picture computed from the code and the key alone; treating the
eight digits as a secret; a password-authenticated key exchange.

**Why:** a bridge carries all three messages and could swap in its own key. A
picture computed only from things the bridge can see would let it try keys
until its picture matched. The order closes that: the swap has to happen at
message 2, before the Host's nonce exists outside the Host, and the Receiver
will not accept a different nonce at message 3 because it already holds the
commitment. So a bridge gets one blind try, and a miss is two people looking at
different pictures.

The eight digits are not secret from a bridge, which can try all hundred
million against the slot id. Nothing rests on them. A password-authenticated
exchange would make them count, at the price of a second cryptographic
construction in two languages; the picture gives the property with a hash.

**The Receiver's key stays between the two devices.** HPKE base mode lets
anyone who knows a Receiver's public key seal a message that opens on it, so a
bridge that saw the key at pairing could forge an SMS for ever after. The offer
is therefore sealed to the Host's one-time key. A bridge can replace that key
with its own to read the offer, but the one-time key is in the picture, so
reading costs the same one blind try as swapping. The first version of this
exchange sent the offer in the clear; a review caught it before any phone was
paired.

**Names are in the picture** because they are shown beside the confirm button,
and a bridge that could rewrite one could write instructions there.

**A code is used once.** The slot it names keeps an attempt's messages for ten
minutes, so the Receiver clears the code after any failure and the reveal names
the offer it answers.

**The cost, stated:** one try in 512. That is weaker than the six-digit
comparisons other products use, and it was chosen because what is compared is
said aloud by people who may be elderly, in two languages: a colour and a thing
is the most that survives a phone call. Each failed try is visible to both
people and ends the pairing.

**The lists are protocol.** The order of the colours and the things is fixed in
`receiver/src/pictures.ts`. An entry may be reworded, never moved.

**Built:** the Receiver's side, and the Host's side in TypeScript for the tests
and the stand-in Host. **Not built:** the Host app's side in Kotlin.

---

## D25 — A Receiver makes new keys and a new box for every Host (2026-11-23)

**Chosen:** each pairing gets its own key pair and its own box. A Receiver
listening to three Hosts holds three private keys and collects from three boxes.

**Rejected:** one identity per Receiver, offered to every Host, which is how the
first version worked.

**Why:** with one box, nothing says which Host a message came from, so a
Receiver could not name the sender or show one Host's messages alone. With one
key, removing a Host removed nothing: that Host could go on sealing messages
this device would open. Separate keys make removal final. The Host's keys are
deleted with it, and whatever is sent to its box afterwards is never collected
and could not be opened if it were.

It also keeps Hosts from learning anything about each other. Two Hosts paired
to the same Receiver hold different keys and different box ids, and neither can
tell that the other exists.

**Cost:** one held request per Host per bridge while the app is open.

**Upgrading:** a device paired under the first version had one identity and a
list of Host names. On first launch they become a single Host that keeps that
identity, so nobody has to pair again. The browser test starts from that state
and checks that a message still arrives.

---

## D26 — A Host reports on itself, and can be asked to ring (2026-11-23)

**Chosen:** two things added to what travels between a paired Host and Receiver.

| What | Direction | Carries |
|---|---|---|
| A status report | Host to Receiver | when it was made, how often to expect one, battery, charging, network, SMS not yet delivered |
| A command | Receiver to Host | `buzz` (ring and vibrate) or `ping` (report now). The Host answers with a report naming the command |

Both are sealed like an SMS. A report is deposited with the tag `status`, and a
bridge keeps only the newest message with a given tag.

**Rejected:** a heartbeat the bridge understands; a bridge-side "last seen";
commands in the clear.

**Why:** the phone sits unattended in another country, and the first anyone
learns of a dead battery is the day a code does not arrive. A report every few
minutes turns that into something seen in advance, and ringing the phone gets
someone nearby to plug it in. Keeping both sealed means a bridge still learns
nothing but timing; the tag tells it only that a message replaces the previous
one, which the timing already gave away.

Without the tag, two days of reports would fill a box past its hundred messages
and push out the SMS it exists for.

**The command channel.** At pairing the Host makes a key and a box for that one
Receiver's commands and sends them sealed to the key the Receiver just offered
(in the reveal, D24). A bridge sees the box id later, in a deposit URL, and
never the key, so it cannot make a phone ring.

**"Alive"** means the newest report is younger than two and a half of the
Host's own intervals. The interval travels in the report, so the Receiver does
not need to know it in advance.

**Built:** both sides, the bridge's tag, and a Host simulator in TypeScript
used by the tests and the stand-in. How the Host app waits for a command
without paying for it is D28. **Unverified:** that a command reaches a real
phone that has been asleep for hours; an emulator does not sleep like one.


---

## D27 — A Receiver reads every SIM unless narrowed, and consent is given once (2026-11-24)

**Chosen:** a paired Receiver gets the messages of every SIM in the phone,
including one put in later. The owner can limit a Receiver to particular SIMs
from the Host's home screen. Consent is one acknowledgement at setup, before
which nothing is captured at all.

**Rejected:** a route per SIM with its own consent and its own list of
Receivers, which is what the first code had; choosing SIMs as a step of
pairing.

**Why:** the person setting this up is often an older relative following
instructions over a phone call. Most phones in question hold one SIM, and a
pairing that ends with a question about routing keys is one more place to get
stuck. The household with two SIMs and two readers is real, so the choice
exists, one tap away, after the pairing has already worked.

**Nothing is kept that has nowhere to go.** Before the acknowledgement, and
for a SIM no Receiver reads, the capture path stores nothing. If the settings
cannot be read it stores the message anyway: "nobody is paired" would then be
a guess, and a wrong guess loses someone's code.

**Costs:** a second Receiver sees a spouse's bank codes unless someone narrows
it. The picture step names who is being connected, and the home screen shows
what each one reads.

---

## D28 — The Host waits for commands at one bridge, and reports from an alarm (2026-11-24)

**Chosen:** for each paired Receiver the Host holds one waiting request, at the
first bridge that answers, and moves to the next only when that one fails. On
every status alarm it also looks once at each of the others. Reports are driven
by an inexact alarm about every twelve minutes and state an interval of
fifteen.

**Rejected:** waiting at every bridge at once, as a Receiver does; polling on a
timer inside the service; a push service.

**Why:** a Receiver is open for minutes. A Host waits all day, every day, and a
held request is what a bridge on Workers is billed for by the second
(BRIDGES). Waiting at all of them delivers nothing sooner when the first is up.
A Receiver leaves a command at every bridge, so one that only reached another
bridge is still found, at the next alarm.

A timer in the service does not run while the phone is in deep sleep; an alarm
does, about once every nine minutes at most. Stating fifteen and firing at
twelve leaves room for a late alarm before a Receiver calls the phone silent
at two and a half intervals.

A push service would wake the phone properly, and would mean Google's servers
and a Google account on a phone in Iran.

**Costs:** a ring can take up to one alarm interval when the Host's usual
bridge is the one the Receiver could not reach. **Unverified:** how long a
waiting request survives on a sleeping phone with the battery exemption
granted; that needs hardware.

---

## D29 — The Host's screens are a web build behind one narrow interface (2026-11-24)

**Chosen:** the screens are built from the same project as the Receiver's and
shown in a WebView. They reach the phone only through `HostApi`: one call that
returns what to draw, and one per button. Pairing, keys, sealing and every
network request stay in Kotlin. The WebView refuses the screens any request
that is not for a bundled file.

**Rejected:** pairing in the WebView with the Receiver's TypeScript, which
already existed and would have saved writing it twice; native screens.

**Why:** D19 wants screens that can be replaced without a new APK. Whatever can
be replaced that way must not be able to read a key or send anything, or the
signature on a screen update becomes the only thing between a bridge and every
message. With the keys in Kotlin and the page offline, the worst a bad screen
can do is show the wrong thing.

Two implementations of pairing can drift, so one pairing is written down
(`receiver/test/pairing-vectors.json`) and a test on each side recomputes it.

**Not built yet:** fetching and verifying a signed screen build (D19). Today
the build is inside the APK.

---

## D30 — A bridge wakes a closed Receiver with an empty push (2026-11-24)

**Chosen:** a Receiver with notifications on leaves, at each bridge and for
each Host's box, the address its browser was given for push messages. When a
message arrives for that box, a bridge that can push sends that address a push
with nothing in it. The Receiver's service worker shows "a new SMS has arrived"
and the Receiver collects and opens the message, as before, when it is opened.

| Part | What it does |
|---|---|
| `POST /v2/box/<id>/push`, `DELETE` | leave an address, take it back. Needs the box key |
| Allowed addresses | only the push services of the browsers; anything else is refused |
| Reports | never pushed: a tagged message wakes nobody |
| `quiet` on a deposit | a Host marks what reads as advertising; a bridge does not push for it |
| An address not renewed for sixty days, or one the push service calls gone | forgotten |

**Rejected:** a push that carries the sealed message, opened by the service
worker; a push that names the SIM or the sender; the Host pushing directly;
keeping the Receiver's request open in the background; a separate push server.

**Why:** a code is useless ten minutes late, and until now a Receiver that was
not open received nothing. A browser will wake a closed web app only through
its maker's push service, so something has to call that service when a message
arrives, and the bridge is the one thing that is there at that moment.

**Empty on purpose.** The push says only "look". A push with content would
mean a second key and a second place a message can be opened, in a service
worker with a few seconds to live, and it would hand the push service a
ciphertext per message. The notification cannot name the SIM, and that is the
price: the lock screen says a message came, never from whom.

**The bridge holds a signing key, and it opens nothing.** A push service
accepts a push only from the application that the address was made for, proved
by a signature (VAPID). That key is the bridge's, has nothing to do with any
Receiver's key, and a leak of it lets someone send empty notifications.

**Only bridge 2 pushes.** Bridge 1 is run where it is told to reach nothing
outside (BRIDGES), and could not reach Apple from inside Iran anyway. It
answers 404 to an address and the Receiver moves on. A message that reached
only bridge 1 therefore wakes nobody; it is collected when the Receiver is
next opened.

**Advertising.** The Receiver sorts advertising under Spam and stays quiet
about it, but it is the bridge that decides to wake a closed Receiver, and a
bridge cannot read. So the Host marks such a message `quiet`. That is one bit
about a message that a bridge did not have before. A sender the person marked
as spam by hand is not covered: only the Receiver knows that list.

**This also settles the cost of a Receiver left open** (BRIDGES): with a push
to rely on, nobody needs to hold a request to bridge 2 for hours.

**Costs:** the push service learns when a message arrived, and the bridge
which address belongs to which box (THREAT-MODEL A9). Both only for a Receiver
whose owner turned notifications on.

**Built:** the bridge's side on Workers, the Receiver web app's side, the
Host's `quiet` mark. **Unverified:** delivery to a real iPhone. **Not built:**
the same for the Receiver's Android app, where a web view has no push; and a
Receiver that stops holding its request open once push is known to work.

---

## D31 — A Receiver may answer an SMS and decline a call, if the phone's owner says so (2026-11-24)

**Chosen:** two powers beyond reading, both off until switched on at the Host.

| Power | Switched on | What a Receiver can then do |
|---|---|---|
| Sending | per Receiver | answer an SMS from the SIM it came to; send an advertiser its own opt-out code |
| Calls | for the phone | be told the phone is ringing and from whom, and that a call was missed; end a ringing call, with or without a line to the caller |

A send is refused unless every one of these holds (`SendPolicy.kt`):

- the owner switched sending on for that Receiver, and it reads that SIM;
- the number wrote to or called that SIM in the last thirty days;
- that Receiver has sent fewer than twenty in the last twenty-four hours;
- the text is at most 200 characters;
- the command is no more than ten minutes old by the phone's clock.

Every SMS sent is told to every Receiver of that SIM, with who asked. A
refusal is told to the one who asked, with a reason from a closed list.

**Rejected:** sending to any number; no daily limit; sending switched on by a
Receiver; answering calls or carrying their audio; reading the SMS inbox or
the call log to decide who is known.

**Why:** the person abroad is the one who needs to answer "is this you? reply
1", or to tell a caller they will ring back. Reading alone leaves them asking
whoever is near the phone to type for them.

**Sending is a different power from reading.** A lost Receiver that can read
sees codes. One that can send could answer a bank, subscribe to a paid
service, or write to anyone as the SIM's owner. So it is narrowed to what the
need is, an answer: only to a number that contacted the SIM first, a few a
day, never from a stale command, and visible to everyone afterwards. The
switch is on the Host because the Host is the device a thief of the Receiver
does not hold.

**Who is "known" is kept as a salted hash and a time.** The policy only ever
asks whether this exact number has been heard from, so the number has no
reason to be stored a second time.

**Calls.** The Host learns that the phone rings and the number, as its own
screen shows. It never answers and hears nothing. Android's announcement of a
ringing phone does not say which SIM: on the first real two-SIM phone it
carried the number and nothing else, and every call was left out. So each SIM
is asked for its own call state. If that still does not single one out, the
call is left out rather than listed under the wrong line.

**Names.** A third switch sends, with a message or a call, the name the owner
saved for that number in the phone's contacts (`READ_CONTACTS`, asked for only
then). One name is looked up at the moment a message is sealed and travels
inside the seal. The contact list is never read as a whole or stored.

**Four new permissions,** `READ_CONTACTS` among them, asked for only when
their switch is turned on and never at setup: `SEND_SMS`, `READ_CALL_LOG` (Android gives the ringing number
only to an app that holds it; the log itself is never read) and
`ANSWER_PHONE_CALLS` (to end a call; the app never answers one).

**On the wire.** A call and a sent SMS travel as messages with a `kind`, so
they are stored, shown once and acknowledged like any SMS, and a Receiver from
before this shows them as plain messages. A reply and a decline are commands
(D26) with a destination and a text. Each report tells a Receiver what it may
ask for, so it shows only the buttons that will work.

**Costs:** more to go wrong on a phone nobody watches, and a wider permission
list for anyone reading the manifest. A Receiver left unlocked can now write
up to twenty answers a day as the SIM's owner (THREAT-MODEL A4).

**Built and run on an emulator:** a reply sent, a stranger refused, a call
declined with a message, a missed call reported. **Unverified on hardware:**
which SIM a call is attributed to on a dual-SIM phone, ending a call on each
manufacturer's Android, and whether a sideloaded install is allowed these
permissions without the "restricted settings" step.
