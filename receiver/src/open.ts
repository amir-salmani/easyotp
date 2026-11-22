/**
 * Opening what a Host sealed.
 *
 * A Host seals each SMS to this Receiver's public key with HPKE (RFC 9180:
 * X25519, HKDF-SHA256, ChaCha20-Poly1305, base mode, empty info). The private
 * key never leaves the Receiver, so nothing between the two can read a message
 * (DECISIONS D16).
 *
 * Base mode is public-key encryption: anyone who knows the public key can seal
 * a message that opens here. What makes a message trustworthy is that only a
 * paired Host was ever told this Receiver's public key and box id.
 */
import { CipherSuite, DhkemX25519HkdfSha256, HkdfSha256 } from "@hpke/core";
import { Chacha20Poly1305 } from "@hpke/chacha20poly1305";

const suite = new CipherSuite({
  kem: new DhkemX25519HkdfSha256(),
  kdf: new HkdfSha256(),
  aead: new Chacha20Poly1305(),
});

/** One SMS, as the Host describes it. Must match `Payload` in the Host app. */
export interface Message {
  v: 2;
  /** The same id the bridge carries in the clear. Shown once per id. */
  id: string;
  /** The label the Host's owner gave the SIM. */
  sim: string;
  /** Who the SMS came from, as the phone reports it. */
  from: string;
  body: string;
  /** The one-time code found in the body, if any. */
  code: string | null;
  /** When the phone received the SMS, in milliseconds. */
  at: number;
}

export class OpenError extends Error {}

export function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const buffer = (s: string) => fromB64url(s).buffer as ArrayBuffer;

/** A new Receiver identity. The private half is stored on this device only. */
export async function newKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
  const pair = await suite.kem.generateKeyPair();
  return {
    publicKey: b64url(new Uint8Array(await suite.kem.serializePublicKey(pair.publicKey))),
    privateKey: b64url(new Uint8Array(await suite.kem.serializePrivateKey(pair.privateKey))),
  };
}

function isMessage(x: unknown): x is Message {
  if (typeof x !== "object" || x === null) return false;
  const m = x as Record<string, unknown>;
  return (
    m.v === 2 &&
    typeof m.id === "string" &&
    typeof m.sim === "string" &&
    typeof m.from === "string" &&
    typeof m.body === "string" &&
    (m.code === null || typeof m.code === "string") &&
    typeof m.at === "number"
  );
}

/**
 * Opens one sealed message.
 *
 * @param envelopeId the id the bridge delivered it under. It must match the id
 *   inside the seal, or a bridge could replay an old message under a new id
 *   and have it shown a second time.
 */
export async function open(privateKey: string, envelopeId: string, enc: string, ct: string): Promise<Message> {
  let plaintext: ArrayBuffer;
  try {
    const recipient = await suite.createRecipientContext({
      recipientKey: await suite.kem.deserializePrivateKey(buffer(privateKey)),
      enc: buffer(enc),
    });
    plaintext = await recipient.open(buffer(ct));
  } catch {
    // Deliberately says nothing more: a detailed failure is a decryption oracle.
    throw new OpenError("could not open");
  }
  let message: unknown;
  try {
    message = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new OpenError("not a message");
  }
  if (!isMessage(message)) throw new OpenError("not a message");
  if (message.id !== envelopeId) throw new OpenError("id mismatch");
  return message;
}

/** For tests and for a Receiver that sends itself a test message. */
export async function seal(publicKey: string, message: Message): Promise<{ enc: string; ct: string }> {
  const sender = await suite.createSenderContext({
    recipientPublicKey: await suite.kem.deserializePublicKey(buffer(publicKey)),
  });
  const ct = await sender.seal(new TextEncoder().encode(JSON.stringify(message)).buffer as ArrayBuffer);
  return { enc: b64url(new Uint8Array(sender.enc)), ct: b64url(new Uint8Array(ct)) };
}
