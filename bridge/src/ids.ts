/**
 * Box identifiers.
 *
 * A bridge keeps no accounts, so who may do what is decided from the request
 * alone, with one one-way step:
 *
 *     boxKey  --H-->  boxId
 *   (Receiver)       (Host, bridge, the URL)
 *
 * - `boxKey` is 32 random bytes made on the Receiver. Presenting it is what
 *   permits collecting from the box and acknowledging what was collected.
 * - `boxId` is what the Host learns at pairing and what appears in the URL. It
 *   permits depositing and nothing else: the hash cannot be run backwards.
 *
 * The bridge verifies by hashing the presented key forward, which needs no
 * stored state.
 */
const enc = new TextEncoder();
const BOX_ID_DOMAIN = "easyotp/box-id/v2";

export function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const p = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(p + "=".repeat((4 - (p.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** 32 bytes, base64url, unpadded. The shape of both a box key and a box id. */
export const KEY_SHAPE = /^[A-Za-z0-9_-]{43}$/;

export async function boxIdFrom(boxKey: string): Promise<string> {
  const key = fromB64url(boxKey);
  const domain = enc.encode(BOX_ID_DOMAIN);
  const buf = new Uint8Array(key.length + domain.length);
  buf.set(key, 0);
  buf.set(domain, key.length);
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", buf)));
}

/**
 * Constant-time string comparison. These compare secret-derived values, so an
 * early exit on the first differing character would leak them a byte at a time.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
