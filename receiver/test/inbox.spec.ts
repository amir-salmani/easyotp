import { describe, expect, it } from "vitest";
import { boxIdFrom, randomKey } from "../src/ids";
import { collectFrom, watch, type Identity, type InboxStore } from "../src/inbox";
import { newKeyPair, seal, type Message } from "../src/open";
import { localBridges } from "./local-bridge";

async function newIdentity() {
  const keys = await newKeyPair();
  const boxKey = randomKey();
  const identity: Identity = { privateKey: keys.privateKey, boxKey, boxId: await boxIdFrom(boxKey) };
  return { identity, publicKey: keys.publicKey };
}

function memoryStore() {
  const messages = new Map<string, Message>();
  const store: InboxStore = {
    has: async (id) => messages.has(id),
    put: async (m) => void messages.set(m.id, m),
  };
  return { store, messages };
}

const sms = (id: string, body = "code 4821"): Message => ({ v: 2, id: id.padEnd(24, "0"), sim: "MCI", from: "+98200", body, code: "4821", at: 1 });

/** What the Host does: seal once per Receiver, leave it at every bridge given. */
async function hostSends(net: ReturnType<typeof localBridges>, urls: string[], boxId: string, publicKey: string, m: Message) {
  const { enc, ct } = await seal(publicKey, m);
  for (const url of urls) {
    const res = await net.fetch(`${url}/v2/box/${boxId}`, { method: "POST", body: JSON.stringify({ v: 2, id: m.id, enc, ct }) });
    expect(res.status).toBe(200);
  }
}

describe("collecting", () => {
  it("shows a message once though every bridge delivers it", async () => {
    const net = localBridges(["one", "two"]);
    const { identity, publicKey } = await newIdentity();
    const { store, messages } = memoryStore();
    await hostSends(net, net.urls, identity.boxId, publicKey, sms("a"));

    const first = await collectFrom(net.urls[0]!, identity, store, net.fetch);
    const second = await collectFrom(net.urls[1]!, identity, store, net.fetch);
    expect(first.fresh.map((m) => m.body)).toEqual(["code 4821"]);
    expect(second.fresh).toEqual([]);
    expect(messages.size).toBe(1);
  });

  it("acknowledges only after storing, so a failed store is retried", async () => {
    const net = localBridges(["one"]);
    const { identity, publicKey } = await newIdentity();
    await hostSends(net, net.urls, identity.boxId, publicKey, sms("a"));

    const failing: InboxStore = { has: async () => false, put: async () => { throw new Error("disk full"); } };
    await expect(collectFrom(net.urls[0]!, identity, failing, net.fetch)).rejects.toThrow("disk full");
    expect(net.bridges[0]!.log.some((l) => l.endsWith("/ack"))).toBe(false);

    const { store, messages } = memoryStore();
    await collectFrom(net.urls[0]!, identity, store, net.fetch);
    expect(messages.size).toBe(1);
    expect((await collectFrom(net.urls[0]!, identity, store, net.fetch)).fresh).toEqual([]);
  });

  it("clears what it cannot open without ever showing it", async () => {
    const net = localBridges(["one"]);
    const { identity } = await newIdentity();
    const stranger = await newIdentity();
    const { store, messages } = memoryStore();
    // Sealed to someone else's key, but left in this Receiver's box.
    await hostSends(net, net.urls, identity.boxId, stranger.publicKey, sms("x"));

    const pass = await collectFrom(net.urls[0]!, identity, store, net.fetch);
    expect(pass).toEqual({ fresh: [], unreadable: 1, received: 1, acknowledged: true });
    expect(messages.size).toBe(0);
    expect((await collectFrom(net.urls[0]!, identity, store, net.fetch)).unreadable).toBe(0);
  });

  it("keeps receiving through the bridge that is up while another is down", async () => {
    const net = localBridges(["one", "two"]);
    net.bridges[0]!.down = true;
    const { identity, publicKey } = await newIdentity();
    const { store } = memoryStore();
    const seen: string[] = [];
    const status = new Map<string, boolean>();

    const stop = watch({
      bridges: net.urls, identity, store, fetch: net.fetch,
      onFresh: (ms) => seen.push(...ms.map((m) => m.id)),
      onBridge: (b, up) => void status.set(b, up),
    });
    await hostSends(net, [net.urls[1]!], identity.boxId, publicKey, sms("a"));
    await new Promise((r) => setTimeout(r, 300));
    stop();

    expect(seen).toEqual([sms("a").id]);
    expect(status.get(net.urls[0]!)).toBe(false);
    expect(status.get(net.urls[1]!)).toBe(true);
  });

  it("says when a bridge would not take the acknowledgement, and loses nothing", async () => {
    const net = localBridges(["one"]);
    const { identity, publicKey } = await newIdentity();
    const { store, messages } = memoryStore();
    await hostSends(net, net.urls, identity.boxId, publicKey, sms("a"));
    const noAck = ((input: RequestInfo | URL, init?: RequestInit) =>
      String(input).endsWith("/ack") ? Promise.resolve(new Response("{}", { status: 500 })) : net.fetch(input, init)) as typeof fetch;

    const pass = await collectFrom(net.urls[0]!, identity, store, noAck);
    expect(pass.acknowledged).toBe(false);
    expect(messages.size).toBe(1);
    // Handed over again, recognised, not shown twice.
    expect((await collectFrom(net.urls[0]!, identity, store, net.fetch)).fresh).toEqual([]);
  });

  it("does not spin against a bridge that keeps refusing the acknowledgement", async () => {
    const net = localBridges(["one"]);
    const { identity, publicKey } = await newIdentity();
    const { store } = memoryStore();
    await hostSends(net, net.urls, identity.boxId, publicKey, sms("a"));
    let collects = 0;
    const noAck = ((input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/ack")) return Promise.resolve(new Response("{}", { status: 500 }));
      collects++;
      return net.fetch(input, init);
    }) as typeof fetch;

    const stop = watch({ bridges: net.urls, identity, store, fetch: noAck, onFresh: () => undefined });
    await new Promise((r) => setTimeout(r, 900));
    stop();
    expect(collects).toBeLessThanOrEqual(2);
  });

  it("refuses to store a message whose time no clock can show", async () => {
    // It would be stored, then throw every time the list is drawn.
    const net = localBridges(["one"]);
    const { identity, publicKey } = await newIdentity();
    const { store, messages } = memoryStore();
    await hostSends(net, net.urls, identity.boxId, publicKey, { ...sms("a"), at: 1e18 });
    const pass = await collectFrom(net.urls[0]!, identity, store, net.fetch);
    expect(pass.unreadable).toBe(1);
    expect(messages.size).toBe(0);
  });

  it("gives up on a bridge that takes the request and never answers", async () => {
    const net = localBridges(["one"]);
    net.bridges[0]!.hung = true;
    const { identity } = await newIdentity();
    const { store } = memoryStore();
    const started = Date.now();
    await expect(collectFrom(net.urls[0]!, identity, store, net.fetch, undefined, 200)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("is refused a box it holds no key for", async () => {
    const net = localBridges(["one"]);
    const { identity } = await newIdentity();
    const other = await newIdentity();
    const { store } = memoryStore();
    await expect(collectFrom(net.urls[0]!, { ...identity, boxKey: other.identity.boxKey }, store, net.fetch)).rejects.toThrow("403");
  });
});
