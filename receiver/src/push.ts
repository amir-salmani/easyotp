/**
 * Being woken when a message arrives while this app is closed (DECISIONS D30).
 *
 * The browser gives this app an address at its maker's push service. The app
 * leaves that address at each bridge, for each Host's box. A bridge that can
 * push sends it an empty push when a message arrives; the service worker then
 * says so (public/sw.js). The push carries nothing: the message is collected
 * and opened here, as always, when the app is opened.
 *
 * Not every bridge pushes. One that does not answers 404 and is skipped.
 */
import type { Identity } from "./inbox";

/**
 * The public half of the bridges' push signing key. Must match
 * VAPID_PUBLIC_KEY in bridge/wrangler.jsonc: the browser ties the address it
 * hands out to this key, and a bridge signing with another is refused.
 */
export const VAPID_PUBLIC_KEY = "BLmXanjp4rwi6T8Ri5hMKukG6Lcads7FZ8anl_Vi4DoVeNPgH0FAvCYkwXGdaGeyv_q0-2TIB_Tvz8deXCUpMgk";

const bytesOf = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Whether this browser can be woken at all. On an iPhone, only an app on the home screen can. */
export const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && typeof Notification !== "undefined";

/**
 * This app's push address, asking the browser for one if it has none. Null if
 * the browser will not give one. Call only once notifications are allowed.
 */
export async function pushAddress(registration: ServiceWorkerRegistration): Promise<string | null> {
  const key = bytesOf(VAPID_PUBLIC_KEY);
  try {
    let subscription = await registration.pushManager.getSubscription();
    const madeFor = subscription?.options.applicationServerKey;
    // An address made for an older signing key is useless to today's bridges.
    if (subscription && madeFor && !sameBytes(new Uint8Array(madeFor), key)) {
      await subscription.unsubscribe();
      subscription = null;
    }
    subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    return subscription.endpoint;
  } catch {
    return null;
  }
}

type Box = Pick<Identity, "boxId" | "boxKey">;

/** Leaves the address at every bridge for one Host's box. Resolves to how many bridges took it. */
export async function leaveAddress(bridges: readonly string[], box: Box, endpoint: string, fetchImpl: typeof fetch = (i, o) => fetch(i, o)): Promise<number> {
  const results = await Promise.all(
    bridges.map((bridge) =>
      fetchImpl(`${bridge}/v2/box/${box.boxId}/push`, {
        method: "POST",
        headers: { authorization: `Bearer ${box.boxKey}` },
        body: JSON.stringify({ endpoint }),
        signal: AbortSignal.timeout(15_000),
      }).then((res) => res.ok, () => false),
    ),
  );
  return results.filter(Boolean).length;
}

/** Takes the address back, when a Host is removed. Best effort: a bridge forgets an address nobody renews. */
export async function takeBackAddress(bridges: readonly string[], box: Box, fetchImpl: typeof fetch = (i, o) => fetch(i, o)): Promise<void> {
  await Promise.all(
    bridges.map((bridge) =>
      fetchImpl(`${bridge}/v2/box/${box.boxId}/push`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${box.boxKey}` },
        signal: AbortSignal.timeout(15_000),
      }).catch(() => undefined),
    ),
  );
}
