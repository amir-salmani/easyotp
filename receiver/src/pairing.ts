/**
 * Pairing a Receiver with a Host (DECISIONS D18, D24).
 *
 * Two people are on a phone call. The Host shows eight digits; one person reads
 * them out and the other types them here. The devices then exchange three
 * messages through the bridges, and each shows a picture. If the pictures
 * match, the Host really received this Receiver's key.
 *
 *   1. Host      commit   SHA-256(hostNonce)
 *   2. Receiver  offer    public key, box id, label, receiverNonce
 *   3. Host      reveal   hostNonce, label
 *
 *   picture = SHA-256(code, hostNonce, receiverNonce, public key, box id)
 *
 * The order is the security. A bridge that swaps in its own key at step 2 has
 * to do so before the Host's nonce is revealed, and it cannot change the nonce
 * the Receiver accepts afterwards, because the Receiver already holds its
 * commitment. So it cannot steer the two pictures to match: it gets one blind
 * try in 512, and a failed try is two people looking at different pictures.
 *
 * The code itself is not a secret from a bridge, which can guess all hundred
 * million from the slot id. Nothing rests on it.
 */
import { b64url, fromB64url } from "./open";
import { sha256, slotIdFrom } from "./ids";
import { pictureFrom, type Picture } from "./pictures";

export type Fetch = typeof fetch;

export class PairingError extends Error {
  constructor(readonly reason: "unreachable" | "timeout" | "tampered" | "bad_code") {
    super(reason);
  }
}

interface Commit { t: "commit"; c: string }
interface Offer { t: "offer"; pk: string; box: string; label: string; n: string }
interface Reveal { t: "reveal"; n: string; label: string }
type Wire = Commit | Offer | Reveal;

export const CODE_SHAPE = /^[0-9]{8}$/;
const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;
const NONCE_SHAPE = /^[A-Za-z0-9_-]{22,43}$/;

const encode = (m: Wire) => b64url(new TextEncoder().encode(JSON.stringify(m)));

function decode(data: string): Wire | null {
  try {
    const m = JSON.parse(new TextDecoder().decode(fromB64url(data))) as Record<string, unknown>;
    const label = typeof m.label === "string" ? m.label.slice(0, 64) : "";
    if (m.t === "commit" && typeof m.c === "string" && KEY_SHAPE.test(m.c)) return { t: "commit", c: m.c };
    if (m.t === "reveal" && typeof m.n === "string" && NONCE_SHAPE.test(m.n)) return { t: "reveal", n: m.n, label };
    if (
      m.t === "offer" && typeof m.pk === "string" && KEY_SHAPE.test(m.pk) &&
      typeof m.box === "string" && KEY_SHAPE.test(m.box) && typeof m.n === "string" && NONCE_SHAPE.test(m.n)
    ) {
      return { t: "offer", pk: m.pk, box: m.box, label, n: m.n };
    }
  } catch {
    // Anything unreadable is not a pairing message. Anyone can write to a slot.
  }
  return null;
}

/** The same slot on every bridge. Whichever bridge carries a message first wins. */
class Channel {
  private cursors = new Map<string, number>();
  private closed = false;

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

  close(): void {
    this.closed = true;
  }

  /** Posts to every bridge. One taking it is enough. */
  async send(message: Wire): Promise<void> {
    const body = JSON.stringify({ v: 2, from: this.from, data: encode(message) });
    const results = await Promise.all(
      this.bridges.map((b) =>
        this.fetch(`${b}/v2/pair/${this.slotId}`, { method: "POST", body }).then((r) => r.ok, () => false),
      ),
    );
    if (!results.some(Boolean)) throw new PairingError("unreachable");
  }

  /** The first message from the other side that `pick` accepts, from any bridge. */
  async waitFor<T extends Wire>(pick: (m: Wire) => T | null, timeoutMs: number): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    const other = this.from === "host" ? "receiver" : "host";
    const listen = async (bridge: string): Promise<T> => {
      for (;;) {
        if (this.closed || Date.now() >= deadline) throw new PairingError("timeout");
        let messages: Array<{ seq: number; from: string; data: string }> = [];
        try {
          const after = this.cursors.get(bridge) ?? 0;
          const res = await this.fetch(`${bridge}/v2/pair/${this.slotId}?after=${after}`);
          if (!res.ok) throw new Error();
          messages = ((await res.json()) as { messages: typeof messages }).messages;
        } catch {
          // A bridge that is down must not end the pairing; the other may be up.
          await new Promise((r) => setTimeout(r, 1500));
          continue;
        }
        for (const m of messages) {
          this.cursors.set(bridge, Math.max(this.cursors.get(bridge) ?? 0, m.seq));
          const picked = m.from === other ? decode(m.data) : null;
          const wanted = picked && pick(picked);
          if (wanted) return wanted;
        }
      }
    };
    return Promise.any(this.bridges.map(listen)).catch(() => {
      throw new PairingError("timeout");
    });
  }
}

async function pictureOf(code: string, hostNonce: string, receiverNonce: string, pk: string, box: string) {
  return pictureFrom(
    await sha256("easyotp/pair-sas/v1", code, fromB64url(hostNonce), fromB64url(receiverNonce), fromB64url(pk), fromB64url(box)),
  );
}

const commitmentOf = async (hostNonce: string) => b64url(await sha256("easyotp/pair-commit/v1", fromB64url(hostNonce)));

export interface ReceiverOffer {
  publicKey: string;
  boxId: string;
  /** What the Host's owner will see this Receiver called. */
  label: string;
}

export interface PairingResult {
  /** Show this. The pairing counts only once both people say theirs is the same. */
  picture: Picture;
  /** What the other side calls itself. Not verified by anything but the picture. */
  peerLabel: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/** The Receiver's side. Resolves when there is a picture to compare. */
export async function pairAsReceiver(opts: {
  bridges: readonly string[];
  code: string;
  offer: ReceiverOffer;
  fetch?: Fetch;
  timeoutMs?: number;
  /** Abort to stop waiting, when the person gives up. */
  signal?: AbortSignal;
}): Promise<PairingResult> {
  if (!CODE_SHAPE.test(opts.code)) throw new PairingError("bad_code");
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const channel = new Channel(opts.bridges, await slotIdFrom(opts.code), "receiver", opts.fetch ?? fetch);
  opts.signal?.addEventListener("abort", () => channel.close());
  try {
    // The commitment must be in hand before this side says anything.
    const commit = await channel.waitFor((m) => (m.t === "commit" ? m : null), timeout);
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(16)));
    await channel.send({ t: "offer", pk: opts.offer.publicKey, box: opts.offer.boxId, label: opts.offer.label, n: nonce });
    const reveal = await channel.waitFor((m) => (m.t === "reveal" ? m : null), timeout);
    if ((await commitmentOf(reveal.n)) !== commit.c) throw new PairingError("tampered");
    return {
      picture: await pictureOf(opts.code, reveal.n, nonce, opts.offer.publicKey, opts.offer.boxId),
      peerLabel: reveal.label,
    };
  } finally {
    channel.close();
  }
}

/**
 * The Host's side, as the Host app does it in Kotlin. Here for the tests and
 * for `tools/fake-host.mjs`, which stands in for a phone.
 */
export async function pairAsHost(opts: {
  bridges: readonly string[];
  code: string;
  label: string;
  fetch?: Fetch;
  timeoutMs?: number;
}): Promise<PairingResult & { receiver: ReceiverOffer }> {
  if (!CODE_SHAPE.test(opts.code)) throw new PairingError("bad_code");
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const channel = new Channel(opts.bridges, await slotIdFrom(opts.code), "host", opts.fetch ?? fetch);
  try {
    const nonce = b64url(crypto.getRandomValues(new Uint8Array(32)));
    await channel.send({ t: "commit", c: await commitmentOf(nonce) });
    const offer = await channel.waitFor((m) => (m.t === "offer" ? m : null), timeout);
    // Only now, with the offer fixed, is the nonce given away.
    await channel.send({ t: "reveal", n: nonce, label: opts.label });
    return {
      picture: await pictureOf(opts.code, nonce, offer.n, offer.pk, offer.box),
      peerLabel: offer.label,
      receiver: { publicKey: offer.pk, boxId: offer.box, label: offer.label },
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
