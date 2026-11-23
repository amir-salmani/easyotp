/** Pairing slots: a few small messages, for ten minutes, for whoever knows the id. */
import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { Slot, Slots, SLOT_LIMITS } from "../src/slot";
import { b64url } from "../src/ids";

const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

describe("Slot", () => {
  it("numbers messages and hands over only the ones not yet seen", async () => {
    const slot = new Slot(0);
    expect(slot.post("host", "a")).toBe(1);
    expect(slot.post("receiver", "b")).toBe(2);
    expect(await slot.read(0, 0)).toHaveLength(2);
    expect(await slot.read(1, 0)).toEqual([{ seq: 2, from: "receiver", data: "b" }]);
  });

  it("wakes a waiting reader when the other side posts", async () => {
    const slot = new Slot(0);
    const waiting = slot.read(0, 5_000);
    slot.post("receiver", "offer");
    expect(await waiting).toHaveLength(1);
    expect(slot.waiting).toBe(0);
  });

  it("takes no more than a pairing needs", () => {
    const slot = new Slot(0);
    for (let i = 0; i < SLOT_LIMITS.maxMessages; i++) expect(slot.post("host", "x")).toBe(i + 1);
    expect(slot.post("host", "x")).toBe("full");
  });

  it("ends after ten minutes", () => {
    const slot = new Slot(1_000);
    expect(slot.expired(1_000 + SLOT_LIMITS.lifetimeMs - 1)).toBe(false);
    expect(slot.expired(1_000 + SLOT_LIMITS.lifetimeMs)).toBe(true);
  });
});

describe("Slots", () => {
  it("starts an expired slot afresh, so an old pairing cannot leak into a new one", async () => {
    const slots = new Slots(10);
    slots.post("s", "host", "old", 0);
    expect(await slots.read("s", 0, 0, SLOT_LIMITS.lifetimeMs)).toEqual([]);
  });

  it("refuses new slots at its limit, and frees expired ones first", () => {
    const slots = new Slots(2);
    expect(slots.post("a", "host", "x", 0)).toBe(1);
    expect(slots.post("b", "host", "x", 0)).toBe(1);
    expect(slots.post("c", "host", "x", 1)).toBe("full");
    expect(slots.post("c", "host", "x", SLOT_LIMITS.lifetimeMs)).toBe(1);
    expect(slots.count).toBe(1);
  });
});

describe("pairing over the bridge", () => {
  const url = () => `https://bridge.test/v2/pair/${random()}`;
  const post = (u: string, body: unknown) =>
    exports.default.fetch(u, { method: "POST", body: JSON.stringify(body) });

  it("carries messages between the two sides in order", async () => {
    const u = url();
    const waiting = exports.default.fetch(`${u}?after=0`);
    expect(await (await post(u, { v: 2, from: "host", data: "Y29tbWl0" })).json()).toMatchObject({ seq: 1 });
    const first = (await (await waiting).json()) as { messages: unknown[] };
    expect(first.messages).toEqual([{ seq: 1, from: "host", data: "Y29tbWl0" }]);

    await post(u, { v: 2, from: "receiver", data: "b2ZmZXI" });
    const next = (await (await exports.default.fetch(`${u}?after=1`)).json()) as { messages: Array<{ from: string }> };
    expect(next.messages.map((m) => m.from)).toEqual(["receiver"]);
  });

  it("refuses anything that is not a pairing message", async () => {
    const u = url();
    expect((await post(u, { v: 2, from: "bridge", data: "eA" })).status).toBe(400);
    expect((await post(u, { v: 2, from: "host", data: "not base64!" })).status).toBe(400);
    expect((await post(u, { v: 1, from: "host", data: "eA" })).status).toBe(400);
    expect((await post(u, { v: 2, from: "host", data: "A".repeat(SLOT_LIMITS.maxDataBytes + 1) })).status).toBe(413);
    expect((await exports.default.fetch(`${u}?after=x`)).status).toBe(400);
    expect((await exports.default.fetch("https://bridge.test/v2/pair/short")).status).toBe(404);
  });

  it("stops taking messages once a slot is full", async () => {
    const u = url();
    for (let i = 0; i < SLOT_LIMITS.maxMessages; i++) await post(u, { v: 2, from: "host", data: "eA" });
    expect((await post(u, { v: 2, from: "host", data: "eA" })).status).toBe(409);
  });
});
