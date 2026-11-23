import { describe, expect, it } from "vitest";
import { newKeyPair, open, OpenError, seal, type Message } from "../src/open";

const message = (over: Partial<Message> = {}): Message => ({
  v: 2,
  id: "m".repeat(32),
  sim: "MCI",
  from: "+98200",
  body: "code 1234",
  code: "1234",
  at: 1_700_000_000_000,
  ...over,
});

describe("open", () => {
  it("opens what was sealed to its own key", async () => {
    const keys = await newKeyPair();
    const m = message();
    const { enc, ct } = await seal(keys.publicKey, m);
    expect(await open(keys.privateKey, m.id, enc, ct)).toEqual(m);
  });

  it("cannot open what was sealed to another Receiver", async () => {
    const mine = await newKeyPair();
    const theirs = await newKeyPair();
    const m = message();
    const { enc, ct } = await seal(theirs.publicKey, m);
    await expect(open(mine.privateKey, m.id, enc, ct)).rejects.toThrow(OpenError);
  });

  it("refuses a message a bridge changed in transit", async () => {
    const keys = await newKeyPair();
    const m = message();
    const { enc, ct } = await seal(keys.publicKey, m);
    const flipped = (ct[0] === "A" ? "B" : "A") + ct.slice(1);
    await expect(open(keys.privateKey, m.id, enc, flipped)).rejects.toThrow(OpenError);
  });

  it("refuses a message delivered under a different id than it was sealed with", async () => {
    // Otherwise a bridge could replay an old message under a fresh id and have
    // it shown twice.
    const keys = await newKeyPair();
    const m = message();
    const { enc, ct } = await seal(keys.publicKey, m);
    await expect(open(keys.privateKey, "x".repeat(32), enc, ct)).rejects.toThrow("id mismatch");
  });

  it("refuses a sealed payload that is not a message", async () => {
    const keys = await newKeyPair();
    const { enc, ct } = await seal(keys.publicKey, { v: 1, id: "m".repeat(32) } as unknown as Message);
    await expect(open(keys.privateKey, "m".repeat(32), enc, ct)).rejects.toThrow("not a message");
  });
});
