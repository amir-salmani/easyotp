/**
 * Waking a closed Receiver (DECISIONS D30). The bridge sends an empty push to
 * an address the Receiver left. What must hold: only the box's owner can leave
 * one, it can only point at a browser's push service, the push carries
 * nothing, and reports and advertising wake nobody.
 */
import { exports } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { b64url, boxIdFrom } from "../src/ids";
import { endpointOk, tickle, vapidAuthorization } from "../src/push";
import testKey from "./vapid-test-key.json";

const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
const APPLE = "https://web.push.apple.com/QGuS3xYzExample";

async function newBox() {
  const boxKey = random();
  const boxId = await boxIdFrom(boxKey);
  return { boxKey, boxId, url: `https://bridge.test/v2/box/${boxId}` };
}

const sealed = (extra: Record<string, unknown> = {}) => ({ v: 2, id: random(16), enc: random(), ct: random(200), ...extra });
const deposit = (url: string, body: unknown) => exports.default.fetch(url, { method: "POST", body: JSON.stringify(body) });
const leave = (url: string, boxKey: string, endpoint: unknown) =>
  exports.default.fetch(`${url}/push`, { method: "POST", headers: { authorization: `Bearer ${boxKey}` }, body: JSON.stringify({ endpoint }) });

/** Every request the bridge makes to the outside while a test runs. */
let pushes: Array<{ url: string; headers: Headers; body: string }>;
let answer: number;

beforeEach(() => {
  pushes = [];
  answer = 201;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    pushes.push({ url: req.url, headers: req.headers, body: await req.text() });
    return new Response(null, { status: answer });
  });
});
afterEach(() => vi.restoreAllMocks());

const settled = () => new Promise((r) => setTimeout(r, 200));

describe("a push address", () => {
  it("is accepted only for a browser's push service", () => {
    expect(endpointOk(APPLE)).toBe(true);
    expect(endpointOk("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
    expect(endpointOk("https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe(true);
    // Anything else would let a box's owner aim the bridge's requests at a host of their choosing.
    for (const bad of [
      "https://example.com/hook", "http://web.push.apple.com/x", "https://web.push.apple.com.evil.test/x",
      "https://evil.test/?web.push.apple.com", "https://web.push.apple.com:8443/x", "https://user@web.push.apple.com/x",
      "https://10.0.0.1/x", "not a url", 42, null, `https://web.push.apple.com/${"a".repeat(2000)}`,
    ]) {
      expect(endpointOk(bad), String(bad).slice(0, 60)).toBe(false);
    }
  });

  it("can be left only by whoever holds the box key", async () => {
    const box = await newBox();
    expect((await leave(box.url, random(), APPLE)).status).toBe(403);
    expect((await exports.default.fetch(`${box.url}/push`, { method: "POST", body: JSON.stringify({ endpoint: APPLE }) })).status).toBe(403);
    expect((await leave(box.url, box.boxKey, "https://example.com/hook")).status).toBe(400);
    expect((await leave(box.url, box.boxKey, APPLE)).status).toBe(200);
  });
});

describe("a deposit", () => {
  it("wakes the Receiver with a push that carries nothing", async () => {
    const box = await newBox();
    await leave(box.url, box.boxKey, APPLE);
    const message = sealed();
    expect((await deposit(box.url, message)).status).toBe(200);
    await settled();

    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.url).toBe(APPLE);
    // Nothing of the message, not even its id, leaves the bridge this way.
    expect(pushes[0]!.body).toBe("");
    expect(pushes[0]!.url + [...pushes[0]!.headers].join()).not.toContain(message.id);
    expect(pushes[0]!.headers.get("authorization")).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  });

  it("wakes nobody when no address was left", async () => {
    const box = await newBox();
    await deposit(box.url, sealed());
    await settled();
    expect(pushes).toHaveLength(0);
  });

  it("does not wake anyone for a report or for advertising", async () => {
    const box = await newBox();
    await leave(box.url, box.boxKey, APPLE);
    await deposit(box.url, sealed({ tag: "status" }));
    await deposit(box.url, sealed({ quiet: true }));
    await settled();
    expect(pushes).toHaveLength(0);
    expect((await deposit(box.url, sealed({ quiet: "yes" }))).status).toBe(400);
  });

  it("tells of a burst once", async () => {
    const box = await newBox();
    await leave(box.url, box.boxKey, APPLE);
    await deposit(box.url, sealed());
    await deposit(box.url, sealed());
    await deposit(box.url, sealed());
    await settled();
    expect(pushes).toHaveLength(1);
  });

  it("is not pushed again when a second bridge's copy arrives", async () => {
    const box = await newBox();
    await leave(box.url, box.boxKey, APPLE);
    const message = sealed();
    await deposit(box.url, message);
    await new Promise((r) => setTimeout(r, 3200));
    await deposit(box.url, message);
    await settled();
    expect(pushes).toHaveLength(1);
  });

  it("succeeds even when the push service is down", async () => {
    answer = 503;
    const box = await newBox();
    await leave(box.url, box.boxKey, APPLE);
    expect((await deposit(box.url, sealed())).status).toBe(200);
  });
});

describe("an address that is taken back or has died", () => {
  it("is not pushed to after the Receiver removes it", async () => {
    const box = await newBox();
    await leave(box.url, box.boxKey, APPLE);
    expect((await exports.default.fetch(`${box.url}/push`, { method: "DELETE" })).status).toBe(403);
    expect((await exports.default.fetch(`${box.url}/push`, { method: "DELETE", headers: { authorization: `Bearer ${box.boxKey}` } })).status).toBe(200);
    await deposit(box.url, sealed());
    await settled();
    expect(pushes).toHaveLength(0);
  });

  it("is forgotten once the push service says it is gone", async () => {
    answer = 410;
    const box = await newBox();
    await leave(box.url, box.boxKey, APPLE);
    await deposit(box.url, sealed());
    await settled();
    expect(pushes).toHaveLength(1);
    answer = 201;
    await new Promise((r) => setTimeout(r, 3200));
    await deposit(box.url, sealed());
    await settled();
    expect(pushes).toHaveLength(1);
  });
});

describe("the bridge's signature on a push", () => {
  const vapid = { publicKey: testKey.publicKey, privateJwk: testKey.privateJwk as JsonWebKey, subject: "https://example.test/easyotp" };
  const fromB64 = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

  it("verifies with the public key the Receiver gave its browser, and names the push service", async () => {
    const header = await vapidAuthorization(vapid, APPLE, 1_800_000_000_000);
    const [, token, k] = /^vapid t=([\w.-]+), k=([\w-]+)$/.exec(header)!;
    expect(k).toBe(testKey.publicKey);
    const [head, claims, signature] = token!.split(".");
    const key = await crypto.subtle.importKey("raw", fromB64(testKey.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromB64(signature!), new TextEncoder().encode(`${head}.${claims}`))).toBe(true);
    expect(JSON.parse(new TextDecoder().decode(fromB64(claims!)))).toEqual({ aud: "https://web.push.apple.com", exp: 1_800_000_000 + 43_200, sub: "https://example.test/easyotp" });
  });

  it("reports a dead address apart from a failure", async () => {
    const say = (status: number) => (async () => new Response(null, { status })) as unknown as typeof fetch;
    expect(await tickle(vapid, APPLE, Date.now(), say(201))).toBe("sent");
    expect(await tickle(vapid, APPLE, Date.now(), say(410))).toBe("gone");
    expect(await tickle(vapid, APPLE, Date.now(), say(404))).toBe("gone");
    expect(await tickle(vapid, APPLE, Date.now(), say(500))).toBe("failed");
    expect(await tickle(vapid, APPLE, Date.now(), (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).toBe("failed");
  });
});
