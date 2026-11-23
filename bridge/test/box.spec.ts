/** The rules that decide whether a waiting message survives. */
import { describe, expect, it } from "vitest";
import { Box, LIMITS, type Sealed } from "../src/box";

const msg = (id: string, at = 1_000, ct = "c2VhbGVk"): Sealed => ({ id: id.padEnd(16, "x"), enc: "e".repeat(43), ct, at });

describe("Box", () => {
  it("keeps a message until it is acknowledged, not until it is read", async () => {
    const box = new Box();
    box.add(msg("a"));
    expect(await box.collect(1_000, 0)).toHaveLength(1);
    // A Receiver that died after reading gets it again.
    expect(await box.collect(1_000, 0)).toHaveLength(1);
    expect(box.ack([msg("a").id])).toBe(1);
    expect(await box.collect(1_000, 0)).toHaveLength(0);
  });

  it("stores the same deposit once", () => {
    const box = new Box();
    expect(box.add(msg("a"))).toBe("stored");
    expect(box.add(msg("a"))).toBe("duplicate");
    expect(box.count).toBe(1);
  });

  it("drops what has outlived the retention limit", async () => {
    const box = new Box([msg("old", 0)]);
    expect(await box.collect(LIMITS.retentionMs - 1, 0)).toHaveLength(1);
    expect(await box.collect(LIMITS.retentionMs, 0)).toHaveLength(0);
  });

  it("drops the oldest when a box is over its count", () => {
    const box = new Box();
    for (let i = 0; i <= LIMITS.maxMessages; i++) box.add(msg(`m${i}`));
    expect(box.count).toBe(LIMITS.maxMessages);
    expect(box.snapshot()[0]!.id).toBe(msg("m1").id);
  });

  it("drops the oldest when a box is over its size", () => {
    const box = new Box();
    const big = "c".repeat(200 * 1024);
    for (const id of ["a", "b", "c"]) box.add(msg(id, 1_000, big));
    expect(box.bytes).toBeLessThanOrEqual(LIMITS.maxBoxBytes);
    expect(box.snapshot().map((m) => m.id)).toEqual([msg("b").id, msg("c").id]);
  });

  it("wakes a waiting collector the moment a message arrives", async () => {
    const box = new Box();
    const waiting = box.collect(1_000, 5_000);
    expect(box.waiting).toBe(1);
    box.add(msg("a"));
    expect(await waiting).toHaveLength(1);
    expect(box.waiting).toBe(0);
  });

  it("answers an empty collect when the hold runs out, and forgets the waiter", async () => {
    const box = new Box();
    expect(await box.collect(1_000, 20)).toEqual([]);
    expect(box.waiting).toBe(0);
  });

  it("keeps only the newest of a tagged kind, and never lets it push a message out", () => {
    // A Host reports on itself every few minutes. Two days of that would
    // otherwise fill the box and drop the SMS it exists for.
    const box = new Box();
    box.add(msg("sms"));
    for (let i = 0; i < 300; i++) box.add({ ...msg(`s${i}`), tag: "status" });
    expect(box.count).toBe(2);
    expect(box.snapshot().map((m) => m.id)).toEqual([msg("sms").id, msg("s299").id]);
    // A different tag is a different kind.
    box.add({ ...msg("other"), tag: "other" });
    expect(box.count).toBe(3);
  });

  it("restores from a snapshot", () => {
    const first = new Box();
    first.add(msg("a"));
    expect(new Box(first.snapshot()).count).toBe(1);
  });
});
