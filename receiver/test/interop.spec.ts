/**
 * Host (Kotlin, Tink) to Receiver (TypeScript, hpke-js).
 *
 * The two libraries can each be correct alone and still fail to talk to each
 * other, over settings that give no useful error:
 *
 *  - Tink's default `TINK` variant puts a five-byte key-id prefix on the
 *    ciphertext. That is a Tink convention, not RFC 9180, and hpke-js cannot
 *    open it. The Host must use `Variant.NO_PREFIX`.
 *  - HPKE `info` must match. Tink passes `contextInfo` into the key schedule;
 *    hpke-js defaults to empty. A mismatch is a bare decrypt failure.
 *
 * Neither shows in a unit test of one side. So the fixture is sealed by the
 * Host's real code (`ReceiverSealerTest`), from a payload built by its real
 * encoder, and opened here by the Receiver's real code. CI regenerates the
 * fixture on every run before running this; the committed copy is the last one
 * taken from CI.
 */
import { describe, expect, it } from "vitest";
import { fromB64url, open, openAny } from "../src/open";
import { INTEROP_PRIVATE_KEY, INTEROP_PUBLIC_KEY } from "./interop-keys";
import fixture from "./hpke-fixture.json";

describe("a message sealed by the Host", () => {
  it("was sealed to the key this test holds", () => {
    // A regenerated fixture paired with stale keys would otherwise show up as
    // an unexplained failure to open.
    expect(fixture.publicKey).toBe(INTEROP_PUBLIC_KEY);
  });

  it("opens, and says what the Host put in", async () => {
    const message = await open(INTEROP_PRIVATE_KEY, fixture.id, fixture.enc, fixture.ct);
    expect(message).toEqual(JSON.parse(fixture.plaintext));
    expect(message.v).toBe(2);
    expect(message.id).toBe(fixture.id);
    // Persian text and digits must survive both JSON encoders and the seal.
    expect(message.body).toContain("رمز");
    expect(message.code).toBe("4821");
  });

  it("has an encapsulated key of exactly 32 bytes", () => {
    // The Host splits Tink's output at a fixed offset. Any other length would
    // corrupt every message.
    expect(fromB64url(fixture.enc)).toHaveLength(32);
  });

  it("opens a status report, with what the phone would not say left as null", async () => {
    const status = await openAny(INTEROP_PRIVATE_KEY, fixture.status.id, fixture.status.enc, fixture.status.ct);
    expect(status).toEqual(JSON.parse(fixture.status.plaintext));
    expect(status).toMatchObject({ k: "status", every: 900, battery: 17, charging: false, net: null, pending: 2 });
  });
});
