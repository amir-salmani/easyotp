/**
 * The bridge as deployed on Cloudflare: real requests, a real Durable Object.
 * Each block names the property in docs/THREAT-MODEL.md it holds to account.
 */
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { b64url, boxIdFrom, timingSafeEqual } from "../src/ids";

const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

async function newBox() {
  const boxKey = random();
  return { boxKey, boxId: await boxIdFrom(boxKey), url: `https://bridge.test/v2/box/${await boxIdFrom(boxKey)}` };
}

const sealed = (id = random(16)) => ({ v: 2, id, enc: random(), ct: random(200) });

const deposit = (url: string, body: unknown) =>
  exports.default.fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const collect = (url: string, boxKey: string) => exports.default.fetch(url, { headers: { authorization: `Bearer ${boxKey}` } });

const ack = (url: string, boxKey: string, ids: string[]) =>
  exports.default.fetch(`${url}/ack`, { method: "POST", headers: { authorization: `Bearer ${boxKey}` }, body: JSON.stringify({ ids }) });

describe("box identifiers", () => {
  it("derive one way: the id is not the key, and is stable", async () => {
    const boxKey = random();
    const boxId = await boxIdFrom(boxKey);
    expect(boxId).not.toBe(boxKey);
    expect(boxId).toHaveLength(43);
    expect(await boxIdFrom(boxKey)).toBe(boxId);
  });

  it("compare in constant time, and exactly", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("deposit and collect", () => {
  it("delivers a sealed message unchanged to the holder of the box key", async () => {
    const { boxKey, url } = await newBox();
    const m = sealed();
    expect((await deposit(url, m)).status).toBe(200);

    const got = (await (await collect(url, boxKey)).json()) as { messages: Array<Record<string, unknown>> };
    expect(got.messages).toHaveLength(1);
    expect(got.messages[0]).toMatchObject({ id: m.id, enc: m.enc, ct: m.ct });
  });

  it("keeps a message until it is acknowledged", async () => {
    const { boxKey, url } = await newBox();
    const m = sealed();
    await deposit(url, m);
    await collect(url, boxKey);
    const again = (await (await collect(url, boxKey)).json()) as { messages: unknown[] };
    expect(again.messages).toHaveLength(1);

    expect(await (await ack(url, boxKey, [m.id])).json()).toMatchObject({ removed: 1 });
    // Now empty, so this waits out the hold and answers with nothing.
    const after = (await (await collect(url, boxKey)).json()) as { messages: unknown[] };
    expect(after.messages).toHaveLength(0);
  });

  it("stores a repeated deposit once", async () => {
    const { boxKey, url } = await newBox();
    const m = sealed();
    await deposit(url, m);
    expect(await (await deposit(url, m)).json()).toMatchObject({ duplicate: true });
    const got = (await (await collect(url, boxKey)).json()) as { messages: unknown[] };
    expect(got.messages).toHaveLength(1);
  });

  it("answers a waiting collect when a message arrives", async () => {
    const { boxKey, url } = await newBox();
    const waiting = collect(url, boxKey);
    await deposit(url, sealed());
    const got = (await (await waiting).json()) as { messages: unknown[] };
    expect(got.messages).toHaveLength(1);
  });
});

describe("who may do what (THREAT-MODEL A2, A5)", () => {
  it("refuses to hand a box to someone who holds only its id", async () => {
    const { boxId, url } = await newBox();
    await deposit(url, sealed());
    // The id is public to the Host and the bridge. It must not open the box.
    expect((await collect(url, boxId)).status).toBe(403);
    expect((await exports.default.fetch(url)).status).toBe(403);
  });

  it("refuses another box's key", async () => {
    const mine = await newBox();
    const theirs = await newBox();
    await deposit(mine.url, sealed());
    expect((await collect(mine.url, theirs.boxKey)).status).toBe(403);
    expect((await ack(mine.url, theirs.boxKey, [random(16)])).status).toBe(403);
  });
});

describe("what a bridge accepts", () => {
  it("refuses anything that is not a sealed message", async () => {
    const { url } = await newBox();
    expect((await deposit(url, { ...sealed(), v: 1 })).status).toBe(400);
    expect((await deposit(url, { ...sealed(), enc: "short" })).status).toBe(400);
    expect((await deposit(url, { ...sealed(), ct: "not base64!" })).status).toBe(400);
    expect((await deposit(url, { ...sealed(), id: "x" })).status).toBe(400);
    expect((await exports.default.fetch(url, { method: "POST", body: "{" })).status).toBe(400);
  });

  it("refuses a message larger than any sealed SMS", async () => {
    const { url } = await newBox();
    expect((await deposit(url, { ...sealed(), ct: "A".repeat(20 * 1024) })).status).toBe(413);
  });

  it("answers health without touching anything", async () => {
    expect(await (await exports.default.fetch("https://bridge.test/health")).json()).toEqual({ ok: true });
  });

  it("lets a web Receiver on another origin call it, and is never cached", async () => {
    const { url } = await newBox();
    const preflight = await exports.default.fetch(url, { method: "OPTIONS" });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
    const res = await deposit(url, sealed());
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("has no route for anything else", async () => {
    expect((await exports.default.fetch("https://bridge.test/v2/box/short")).status).toBe(404);
    expect((await exports.default.fetch("https://bridge.test/forward", { method: "POST" })).status).toBe(404);
  });
});
