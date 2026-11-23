/**
 * Identifiers the Receiver derives. The domain strings must match
 * bridge/src/ids.ts and the Host; a fixture in the tests pins them.
 */
import { b64url, fromB64url } from "./open";

const enc = new TextEncoder();

export async function sha256(...parts: Array<Uint8Array | string>): Promise<Uint8Array> {
  const bytes = parts.map((p) => (typeof p === "string" ? enc.encode(p) : p));
  const buf = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of bytes) {
    buf.set(b, at);
    at += b.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-256", buf));
}

export const randomKey = (bytes = 32) => b64url(crypto.getRandomValues(new Uint8Array(bytes)));

/** The box a Host deposits into. The key that opens it never leaves this device. */
export const boxIdFrom = async (boxKey: string) => b64url(await sha256(fromB64url(boxKey), "easyotp/box-id/v2"));

/** Where the two sides of a pairing meet, from the code one person reads to the other. */
export const slotIdFrom = async (code: string) => b64url(await sha256("easyotp/pair-slot/v1", code));
