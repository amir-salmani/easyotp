/**
 * Opening what a Host sealed.
 *
 * A Host seals each SMS to this Receiver's public key with HPKE (RFC 9180:
 * X25519, HKDF-SHA256, ChaCha20-Poly1305, base mode, empty info). The private
 * key never leaves the Receiver, so nothing between the two can read a message
 * (DECISIONS D16).
 *
 * Base mode is public-key encryption: anyone who knows the public key can seal
 * a message that opens here. So the public key is treated as a secret between
 * this Receiver and its Hosts: at pairing it travels sealed, and a bridge only
 * ever learns the box id (DECISIONS D24, THREAT-MODEL A5).
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
  /**
   * Absent for an SMS. "call" while the Host's phone rings, "missed" for a
   * call nobody took, "sent" for an SMS the phone sent because a Receiver
   * asked (DECISIONS D31). For "sent", `from` is who it was sent to.
   */
  kind?: "call" | "missed" | "sent";
  /** Which SIM, as the Host knows it. A reply names it so the phone sends from the same line. */
  simKey?: string;
  /** For "sent": whether the phone handed it to the network. */
  ok?: boolean;
  /** For "sent" that was refused or failed: a code from the Host's closed list. */
  why?: string;
  /** For "sent": the name of the Receiver that asked. */
  by?: string;
  /** What the Host phone's owner calls `from` in their contacts, if they let names be sent. */
  name?: string;
}

/**
 * A Host's report on itself, sent every `every` seconds and whenever it is
 * asked. It is how a Receiver knows the phone at home is still alive before
 * the day a code is needed. Must match `Status` in the Host app.
 */
export interface Status {
  v: 2;
  k: "status";
  id: string;
  /** When the Host made this report, in milliseconds. */
  at: number;
  /** How often it reports, in seconds. Silence for much longer means trouble. */
  every: number;
  /** 0 to 100, or null if the phone will not say. */
  battery: number | null;
  charging: boolean | null;
  net: "wifi" | "cell" | "none" | null;
  /** SMS captured and not yet delivered to a bridge. */
  pending: number;
  /** The command this report answers, if it answers one. */
  ack?: string;
  /** What this Receiver may ask for beyond ringing: "sms" to send, "calls" to decline. */
  can?: string[];
}

/** Something a Receiver asks a Host to do. Sealed to a key only paired Receivers were given. */
export interface Command {
  v: 2;
  k: "cmd";
  id: string;
  at: number;
  /**
   * `buzz`: ring and vibrate, so someone nearby notices the phone. `hush`:
   * stop ringing. `ping`: report now. A Host that does not know a command
   * ignores it, so a new one can be added without breaking an old phone.
   */
  cmd: "buzz" | "ping" | "hush" | "sms" | "decline";
  /** For `sms`: who to send to. */
  to?: string;
  /** For `sms`, and for `decline` when the caller should be told why. */
  text?: string;
  /** For `sms`: the SIM to send from, as a message's `simKey` named it. */
  sim?: string;
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
    // A time a Date cannot hold would throw wherever it is shown.
    typeof m.at === "number" && Number.isFinite(m.at) && Math.abs(m.at) <= 8.64e15
  );
}

function isStatus(x: unknown): x is Status {
  if (typeof x !== "object" || x === null) return false;
  const s = x as Record<string, unknown>;
  const time = (n: unknown) => typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= 8.64e15;
  return (
    s.v === 2 && s.k === "status" && typeof s.id === "string" && time(s.at) &&
    typeof s.every === "number" && s.every > 0 && s.every <= 86_400 &&
    (s.battery === null || (typeof s.battery === "number" && s.battery >= 0 && s.battery <= 100)) &&
    (s.charging === null || typeof s.charging === "boolean") &&
    (s.net === null || s.net === "wifi" || s.net === "cell" || s.net === "none") &&
    typeof s.pending === "number" && s.pending >= 0 &&
    (s.ack === undefined || typeof s.ack === "string")
  );
}

function isCommand(x: unknown): x is Command {
  if (typeof x !== "object" || x === null) return false;
  const c = x as Record<string, unknown>;
  return c.v === 2 && c.k === "cmd" && typeof c.id === "string" && typeof c.at === "number" && Number.isFinite(c.at) && ["buzz", "ping", "hush", "sms", "decline"].includes(c.cmd as string);
}

/**
 * Opens anything a paired device sealed: an SMS, a Host's report on itself, or
 * a command. As with `open`, the id inside must match the id it arrived under.
 */
export async function openAny(privateKey: string, envelopeId: string, enc: string, ct: string): Promise<Message | Status | Command> {
  const plaintext = await openBytes(privateKey, enc, ct);
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new OpenError("not a message");
  }
  if (!isMessage(payload) && !isStatus(payload) && !isCommand(payload)) throw new OpenError("not a message");
  if (payload.id !== envelopeId) throw new OpenError("id mismatch");
  return payload;
}

/**
 * Opens one sealed message.
 *
 * @param envelopeId the id the bridge delivered it under. It must match the id
 *   inside the seal, or a bridge could replay an old message under a new id
 *   and have it shown a second time.
 */
export async function open(privateKey: string, envelopeId: string, enc: string, ct: string): Promise<Message> {
  const plaintext = await openBytes(privateKey, enc, ct);
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

/** Opens sealed bytes. Says nothing about why it failed: a detailed failure is a decryption oracle. */
export async function openBytes(privateKey: string, enc: string, ct: string): Promise<Uint8Array> {
  try {
    const recipient = await suite.createRecipientContext({
      recipientKey: await suite.kem.deserializePrivateKey(buffer(privateKey)),
      enc: buffer(enc),
    });
    return new Uint8Array(await recipient.open(buffer(ct)));
  } catch {
    throw new OpenError("could not open");
  }
}

/** Seals bytes to a public key. */
export async function sealBytes(publicKey: string, plaintext: Uint8Array): Promise<{ enc: string; ct: string }> {
  const sender = await suite.createSenderContext({
    recipientPublicKey: await suite.kem.deserializePublicKey(buffer(publicKey)),
  });
  const ct = await sender.seal(plaintext.slice().buffer as ArrayBuffer);
  return { enc: b64url(new Uint8Array(sender.enc)), ct: b64url(new Uint8Array(ct)) };
}

/** Seals an SMS, a status or a command to a public key. */
export const seal = (publicKey: string, payload: Message | Status | Command) => sealBytes(publicKey, new TextEncoder().encode(JSON.stringify(payload)));
