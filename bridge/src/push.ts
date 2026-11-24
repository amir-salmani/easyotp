/**
 * Telling a closed Receiver that something is waiting (DECISIONS D30).
 *
 * A Receiver that is not open collects nothing, and a code is useless ten
 * minutes late. A Receiver may therefore leave the address its browser was
 * given for push messages. When a message arrives for its box, the bridge
 * sends that address a push with nothing in it. The browser wakes the
 * Receiver's service worker, which says "a new message has arrived"; the
 * Receiver then collects it the usual way.
 *
 * The push carries no content, so there is nothing in it to protect and no
 * key of a Receiver's involved. What the bridge holds is its own signing key
 * (VAPID, RFC 8292), which only proves to the push service that the push
 * comes from this application. It opens nothing.
 *
 * What this costs in privacy is written in THREAT-MODEL: the bridge learns
 * which push address belongs to a box, and the push service learns when a
 * message arrived.
 */
import { b64url } from "./ids";

/** What a Receiver leaves: where to push, and when it last said so. */
export interface PushAddress {
  endpoint: string;
  at: number;
}

/** A Receiver renews its address whenever it is opened. One not renewed for this long is dropped. */
export const PUSH_ADDRESS_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_ENDPOINT = 1024;

/**
 * The push services of the browsers. An address anywhere else is refused:
 * without this list a box's owner could make the bridge send requests to any
 * host they name.
 */
const PUSH_HOSTS = [
  /^web\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

export function endpointOk(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.port === "" && url.username === "" && PUSH_HOSTS.some((host) => host.test(url.hostname));
}

export interface Vapid {
  /** The public half, base64url, as the Receiver passed it to its browser. */
  publicKey: string;
  /** The private half, as a JSON Web Key. */
  privateJwk: JsonWebKey;
  /** A contact for the push service, as an https or mailto address. Not a person's. */
  subject: string;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/** The Authorization header a push service asks for: a short-lived token signed with the VAPID key. */
export async function vapidAuthorization(vapid: Vapid, endpoint: string, now: number): Promise<string> {
  const header = b64url(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  // Good for twelve hours and for this one push service.
  const claims = b64url(utf8(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 60 * 60, sub: vapid.subject })));
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(new Uint8Array(signature))}, k=${vapid.publicKey}`;
}

/**
 * Sends one empty push.
 *
 * `gone` means the push service says the address no longer exists, and it
 * should be forgotten. Anything else that is not success is `failed`: the
 * Receiver still gets its message the next time it is opened.
 */
export async function tickle(vapid: Vapid, endpoint: string, now: number, fetchImpl: typeof fetch = fetch): Promise<"sent" | "gone" | "failed"> {
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        authorization: await vapidAuthorization(vapid, endpoint, now),
        // If the device is off, keep trying for an hour. After that the code is stale anyway.
        ttl: "3600",
        urgency: "high",
        "content-length": "0",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 404 || res.status === 410) return "gone";
    return res.ok ? "sent" : "failed";
  } catch {
    return "failed";
  }
}
