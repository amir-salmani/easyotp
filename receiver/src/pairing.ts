/**
 * Pairing a Receiver with a Host (DECISIONS D18, D24).
 *
 * Two people are on a phone call. The Host shows eight digits; one person reads
 * them out and the other types them here. The devices then exchange three
 * messages through the bridges, and each shows a picture. If the pictures
 * match, the Host really received this Receiver's key, and nobody else did.
 *
 *   1. Host      commit   SHA-256(hostNonce), and a one-time public key
 *   2. Receiver  offer    sealed to that key: public key, box id, name, receiverNonce
 *   3. Host      reveal   hostNonce, name, and which offer it answers
 *
 *   picture = SHA-256(code, both nonces, public key, box id, one-time key, both names)
 *
 * Two things rest on the order.
 *
 * The key cannot be swapped. A bridge that puts its own key in the offer has
 * to do so before the Host's nonce is revealed, and it cannot change the nonce
 * the Receiver accepts afterwards, because the Receiver already holds its
 * commitment. So it cannot steer the two pictures to match: it gets one blind
 * try in 512, and a failed try is two people looking at different pictures.
 *
 * The key is not shown to the bridges. HPKE base mode lets anyone who knows a
 * Receiver's public key seal a message that opens on it, so the offer is
 * sealed to the Host's one-time key. A bridge can replace that key with its
 * own to read the offer, but the one-time key is in the picture, so that is
 * the same one blind try.
 *
 * The code itself is not a secret from a bridge, which can guess all hundred
 * million from the slot id. Nothing rests on it.
 */
import { b64url, fromB64url, newKeyPair, openBytes, sealBytes } from "./open";
import { sha256, slotIdFrom } from "./ids";
import { pictureFrom, type Picture } from "./pictures";

export type Fetch = typeof fetch;

export class PairingError extends Error {
  constructor(readonly reason: "unreachable" | "timeout" | "tampered" | "bad_code" | "cancelled") {
    super(reason);
  }
}

interface Commit { t: "commit"; c: string; e: string }
interface Offer { t: "offer"; enc: string; ct: string }
interface Reveal { t: "reveal"; n: string; label: string; o: string; enc?: string; ct?: string }
type Wire = Commit | Offer | Reveal;

/** What an offer carries once opened. */
interface OfferBody { pk: string; box: string; label: string; n: string }

export const CODE_SHAPE = /^[0-9]{8}$/;
const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const NONCE_SHAPE = /^[A-Za-z0-9_-]{22,43}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const MAX_LABEL = 40;

const utf8 = (s: string) => new TextEncoder().encode(s);
const encode = (m: Wire) => b64url(utf8(JSON.stringify(m)));
/** Names are shown to a person, so they are short and carry no control characters. */
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f\\u2028\\u2029]", "g");
/** Cutting at a fixed length can leave half of an emoji, which the two sides would then encode differently. */
const HALF = /[\uD800-\uDBFF]$/;
export const cleanLabel = (x: unknown) => (typeof x === "string" ? x.replace(CONTROL, "").slice(0, MAX_LABEL).replace(HALF, "") : "");

function decode(data: string): Wire | null {
  try {
    const m = JSON.parse(new TextDecoder().decode(fromB64url(data))) as Record<string, unknown>;
    const is = (x: unknown, shape: RegExp): x is string => typeof x === "string" && shape.test(x);
    if (m.t === "commit" && is(m.c, KEY_SHAPE) && is(m.e, KEY_SHAPE)) return { t: "commit", c: m.c, e: m.e };
    if (m.t === "offer" && is(m.enc, KEY_SHAPE) && is(m.ct, B64URL)) return { t: "offer", enc: m.enc, ct: m.ct };
    if (m.t === "reveal" && is(m.n, NONCE_SHAPE) && is(m.o, KEY_SHAPE)) {
      const sealed = is(m.enc, KEY_SHAPE) && is(m.ct, B64URL) ? { enc: m.enc, ct: m.ct } : {};
      return { t: "reveal", n: m.n, label: cleanLabel(m.label), o: m.o, ...sealed };
    }
  } catch {
    // Anything unreadable is not a pairing message. Anyone can write to a slot.
  }
  return null;
}

function offerBody(bytes: Uint8Array): OfferBody | null {
  try {
    const m = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (typeof m.pk === "string" && KEY_SHAPE.test(m.pk) && typeof m.box === "string" && KEY_SHAPE.test(m.box) &&
        typeof m.n === "string" && NONCE_SHAPE.test(m.n)) {
      return { pk: m.pk, box: m.box, label: cleanLabel(m.label), n: m.n };
    }
  } catch {
    // Falls through.
  }
  return null;
}

/** Long enough for a bridge's longest hold, with room. */
const READ_TIMEOUT_MS = 70_000;
const POST_TIMEOUT_MS = 15_000;
/** A bridge that answers at once with nothing is not asked again sooner than this. */
const MIN_POLL_MS = 1000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The same slot on every bridge. Whichever bridge carries a message first wins. */
class Channel {
  private cursors = new Map<string, number>();
  private epochs = new Map<string, number>();
  private abort = new AbortController();
  private finished = false;
  private fetch: Fetch;

  constructor(
    private bridges: readonly string[],
    private slotId: string,
    private from: "host" | "receiver",
    fetchImpl: Fetch,
  ) {
    // A browser's fetch refuses to run as a method of another object
    // ("Illegal invocation"), so it is wrapped, never stored bare.
    this.fetch = (input, init) => fetchImpl(input, init);
  }

  get closed(): boolean {
    return this.finished || this.abort.signal.aborted;
  }

  /**
   * The pairing is over. Nothing more is sent or read, but a poll already
   * waiting at a bridge is left to run out by itself rather than cut. Cutting
   * it buys nothing, and in Node it leaves the connection to a bridge on
   * Cloudflare unable to carry the next request.
   */
  close(): void {
    this.finished = true;
  }

  /** The person gave up. Everything in flight is cut at once. */
  cancel(): void {
    this.abort.abort();
  }

  private signal(timeoutMs: number): AbortSignal {
    return AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]);
  }

  /** Posts to every bridge and returns as soon as one has taken it. */
  async send(message: Wire): Promise<void> {
    if (this.closed) throw new PairingError("cancelled");
    const body = JSON.stringify({ v: 2, from: this.from, data: encode(message) });
    const post = async (bridge: string) => {
      const res = await this.fetch(`${bridge}/v2/pair/${this.slotId}`, { method: "POST", body, signal: this.signal(POST_TIMEOUT_MS) });
      if (!res.ok) throw new Error();
    };
    await Promise.any(this.bridges.map(post)).catch(() => {
      throw new PairingError(this.abort.signal.aborted ? "cancelled" : "unreachable");
    });
  }

  /** The first message from the other side that `pick` accepts, from any bridge. */
  async waitFor<T>(pick: (m: Wire) => Promise<T | null> | T | null, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    const other = this.from === "host" ? "receiver" : "host";
    const listen = async (bridge: string): Promise<T> => {
      for (;;) {
        if (this.closed) throw new PairingError("cancelled");
        if (Date.now() >= deadline) throw new PairingError("timeout");
        const asked = Date.now();
        let view: { epoch: number; messages: Array<{ seq: number; from: string; data: string }> };
        try {
          const after = this.cursors.get(bridge) ?? 0;
          const res = await this.fetch(`${bridge}/v2/pair/${this.slotId}?after=${after}`, { signal: this.signal(READ_TIMEOUT_MS) });
          if (!res.ok) throw new Error();
          view = (await res.json()) as typeof view;
        } catch {
          // A bridge that is down must not end the pairing; the other may be up.
          if (!this.closed) await sleep(1500);
          continue;
        }
        if (view.epoch !== (this.epochs.get(bridge) ?? 0)) {
          // The slot was replaced: it expired, or the bridge restarted. Its
          // messages are numbered from 1 again, so this side starts over too.
          this.epochs.set(bridge, view.epoch);
          if ((this.cursors.get(bridge) ?? 0) > 0) {
            this.cursors.set(bridge, 0);
            continue;
          }
        }
        for (const m of view.messages) {
          this.cursors.set(bridge, Math.max(this.cursors.get(bridge) ?? 0, m.seq));
          const wire = m.from === other ? decode(m.data) : null;
          const wanted = wire && (await pick(wire));
          if (wanted) return wanted;
        }
        const took = Date.now() - asked;
        if (!view.messages.length && took < MIN_POLL_MS) await sleep(MIN_POLL_MS - took);
      }
    };
    return Promise.any(this.bridges.map(listen)).catch((e: AggregateError) => {
      throw e.errors.find((x) => x instanceof PairingError) ?? new PairingError("timeout");
    });
  }
}

/**
 * Every field on its own line, so no two different sets of fields can produce
 * the same bytes. Names are base64, so a name cannot contain a line break.
 */
export interface SasFields {
  code: string; hostNonce: string; receiverNonce: string; pk: string; box: string;
  oneTimeKey: string; hostLabel: string; receiverLabel: string;
}

/** The bytes both pictures are drawn from. The Host app computes the same in `PairCodec.sas`. */
export async function sasOf(f: SasFields): Promise<Uint8Array> {
  const lines = [
    "easyotp/pair-sas/v2", f.code, f.hostNonce, f.receiverNonce, f.pk, f.box, f.oneTimeKey,
    b64url(utf8(f.hostLabel)), b64url(utf8(f.receiverLabel)),
  ];
  return sha256(lines.join("\n"));
}

const pictureOf = async (f: SasFields): Promise<Picture> => pictureFrom(await sasOf(f));

export const commitmentOf = async (hostNonce: string) => b64url(await sha256("easyotp/pair-commit/v1", fromB64url(hostNonce)));
/** Which offer a reveal answers, so a reveal left over from another attempt is ignored. */
export const offerId = async (offer: { enc: string; ct: string }) => b64url(await sha256("easyotp/pair-offer/v1", `${offer.enc}\n${offer.ct}`));

export interface ReceiverOffer {
  publicKey: string;
  boxId: string;
  /** What the Host's owner will see this Receiver called. */
  label: string;
}

/** Where a Receiver sends a Host commands, and the key it seals them to. */
export interface HostChannel {
  publicKey: string;
  boxId: string;
}

export interface PairingResult {
  /** Show this. The pairing counts only once both people say theirs is the same. */
  picture: Picture;
  /** What the other side calls itself. Part of the picture, so it is as trustworthy as the picture. */
  peerLabel: string;
}

/**
 * The Host tells the Receiver where to send commands by sealing it to the key
 * the Receiver just offered. Only something that opened the offer can do that,
 * so a bridge cannot plant a channel of its own without being the one blind
 * try in 512 that the picture already allows.
 */
async function openChannel(privateKey: string | undefined, reveal: Reveal): Promise<HostChannel | null> {
  if (!privateKey || !reveal.enc || !reveal.ct) return null;
  try {
    const m = JSON.parse(new TextDecoder().decode(await openBytes(privateKey, reveal.enc, reveal.ct))) as Record<string, unknown>;
    if (typeof m.pk === "string" && KEY_SHAPE.test(m.pk) && typeof m.box === "string" && KEY_SHAPE.test(m.box)) {
      return { publicKey: m.pk, boxId: m.box };
    }
  } catch {
    // Unreadable: this Host simply cannot be sent commands.
  }
  return null;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** The Receiver's side. Resolves when there is a picture to compare. */
export async function pairAsReceiver(opts: {
  bridges: readonly string[];
  code: string;
  offer: ReceiverOffer;
  fetch?: Fetch;
  timeoutMs?: number;
  /** Abort to stop at once, when the person gives up. Nothing is sent afterwards. */
  signal?: AbortSignal;
  /** The private half of the offered key. With it, the Host's command channel can be read. */
  privateKey?: string;
}): Promise<PairingResult & { host: HostChannel | null }> {
  if (!CODE_SHAPE.test(opts.code)) throw new PairingError("bad_code");
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const channel = new Channel(opts.bridges, await slotIdFrom(opts.code), "receiver", opts.fetch ?? fetch);
  opts.signal?.addEventListener("abort", () => channel.cancel());
  if (opts.signal?.aborted) channel.cancel();
  try {
    // The commitment must be in hand before this side says anything.
    const commit = await channel.waitFor((m) => (m.t === "commit" ? m : null), timeout);
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const label = cleanLabel(opts.offer.label);
    const body: OfferBody = { pk: opts.offer.publicKey, box: opts.offer.boxId, label, n: nonce };
    const offer: Offer = { t: "offer", ...(await sealBytes(commit.e, utf8(JSON.stringify(body)))) };
    const mine = await offerId(offer);
    await channel.send(offer);
    const reveal = await channel.waitFor((m) => (m.t === "reveal" && m.o === mine ? m : null), timeout);
    if ((await commitmentOf(reveal.n)) !== commit.c) throw new PairingError("tampered");
    return {
      picture: await pictureOf({
        code: opts.code, hostNonce: reveal.n, receiverNonce: nonce, pk: body.pk, box: body.box,
        oneTimeKey: commit.e, hostLabel: reveal.label, receiverLabel: label,
      }),
      peerLabel: reveal.label,
      host: await openChannel(opts.privateKey, reveal),
    };
  } finally {
    channel.close();
  }
}

/**
 * The Host's side, as the Host app will do it in Kotlin. Here for the tests and
 * for `tools/fake-host.ts`, which stands in for a phone.
 */
export async function pairAsHost(opts: {
  bridges: readonly string[];
  code: string;
  label: string;
  fetch?: Fetch;
  timeoutMs?: number;
  /** Where this Receiver should send commands. Made by the Host for this one Receiver. */
  commands?: HostChannel;
}): Promise<PairingResult & { receiver: ReceiverOffer }> {
  if (!CODE_SHAPE.test(opts.code)) throw new PairingError("bad_code");
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const channel = new Channel(opts.bridges, await slotIdFrom(opts.code), "host", opts.fetch ?? fetch);
  try {
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(32)));
    // Made for this one pairing and dropped after it.
    const oneTime = await newKeyPair();
    const label = cleanLabel(opts.label);
    await channel.send({ t: "commit", c: await commitmentOf(nonce), e: oneTime.publicKey });
    // The first offer that opens. Anything else in the slot is someone else's noise.
    const got = await channel.waitFor(async (m) => {
      if (m.t !== "offer") return null;
      const body = await openBytes(oneTime.privateKey, m.enc, m.ct).then(offerBody, () => null);
      return body && { body, id: await offerId(m) };
    }, timeout);
    // Only now, with the offer fixed, is the nonce given away.
    const commands = opts.commands
      ? await sealBytes(got.body.pk, utf8(JSON.stringify({ pk: opts.commands.publicKey, box: opts.commands.boxId })))
      : {};
    await channel.send({ t: "reveal", n: nonce, label, o: got.id, ...commands });
    return {
      picture: await pictureOf({
        code: opts.code, hostNonce: nonce, receiverNonce: got.body.n, pk: got.body.pk, box: got.body.box,
        oneTimeKey: oneTime.publicKey, hostLabel: label, receiverLabel: got.body.label,
      }),
      peerLabel: got.body.label,
      receiver: { publicKey: got.body.pk, boxId: got.body.box, label: got.body.label },
    };
  } finally {
    channel.close();
  }
}

/** Eight digits, for a Host to show. */
export function newCode(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0]! % 100_000_000;
  return n.toString().padStart(8, "0");
}
