/**
 * The pairing, written down (test/pairing-vectors.json).
 *
 * The Host app pairs with its own code, in Kotlin. This test and
 * `PairingVectorsTest` in the Host each recompute the same file, so the two
 * implementations cannot drift apart without one of them failing. If this test
 * fails after a deliberate change to the protocol, run `npm run make-vectors`
 * and expect the Host's test to fail next, which is the point.
 */
import { describe, expect, it } from "vitest";
import { boxIdFrom, slotIdFrom } from "../src/ids";
import { b64url, openAny, openBytes } from "../src/open";
import { cleanLabel, commitmentOf, offerId, sasOf } from "../src/pairing";
import { pictureFrom } from "../src/pictures";
import v from "./pairing-vectors.json";

describe("the written-down pairing", () => {
  it("meets at the same slot and box", async () => {
    expect(await slotIdFrom(v.code)).toBe(v.slotId);
    expect(await boxIdFrom(v.receiver.boxKey)).toBe(v.receiver.boxId);
  });

  it("commits to the same nonce and names the same offer", async () => {
    expect(await commitmentOf(v.hostNonce)).toBe(v.commitment);
    expect(await offerId(v.offer)).toBe(v.offerId);
  });

  it("cuts a long name without leaving half an emoji", () => {
    expect(cleanLabel(v.rawLabel)).toBe(v.hostLabel);
    expect(v.hostLabel.endsWith("📱")).toBe(false);
    expect(/[\uD800-\uDBFF]$/.test(v.hostLabel)).toBe(false);
  });

  it("opens the offer with the one-time key", async () => {
    const body = JSON.parse(new TextDecoder().decode(await openBytes(v.oneTime.privateKey, v.offer.enc, v.offer.ct)));
    expect(body).toEqual({ pk: v.receiver.publicKey, box: v.receiver.boxId, label: v.receiver.label, n: v.receiver.nonce });
  });

  it("draws the same picture", async () => {
    const sas = await sasOf({
      code: v.code, hostNonce: v.hostNonce, receiverNonce: v.receiver.nonce, pk: v.receiver.publicKey,
      box: v.receiver.boxId, oneTimeKey: v.oneTime.publicKey, hostLabel: v.hostLabel, receiverLabel: v.receiver.label,
    });
    expect(b64url(sas)).toBe(v.sas);
    expect(pictureFrom(sas)).toEqual(v.picture);
  });

  it("opens the command", async () => {
    const command = await openAny(v.command.keys.privateKey, v.command.id, v.command.enc, v.command.ct);
    expect(command).toMatchObject({ k: "cmd", cmd: v.command.cmd, id: v.command.id });
  });
});
