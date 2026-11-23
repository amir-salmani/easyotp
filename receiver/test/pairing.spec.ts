import { describe, expect, it } from "vitest";
import { boxIdFrom, randomKey, slotIdFrom } from "../src/ids";
import { b64url, fromB64url, newKeyPair } from "../src/open";
import { newCode, pairAsHost, pairAsReceiver, PairingError } from "../src/pairing";
import { COLOURS, THINGS } from "../src/pictures";
import { localBridges } from "./local-bridge";

async function offer(label = "Amir's phone") {
  const keys = await newKeyPair();
  return { publicKey: keys.publicKey, boxId: await boxIdFrom(randomKey()), label };
}

/** Rewrites one kind of pairing message as it passes through, as a hostile bridge would. */
function tamper(inner: typeof fetch, kind: string, change: (m: Record<string, unknown>) => void): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await inner(input, init);
    if (init?.method === "POST" || !String(input).includes("/v2/pair/")) return res;
    const body = (await res.json()) as { messages: Array<{ data: string }> };
    for (const m of body.messages) {
      const wire = JSON.parse(new TextDecoder().decode(fromB64url(m.data))) as Record<string, unknown>;
      if (wire.t !== kind) continue;
      change(wire);
      m.data = b64url(new TextEncoder().encode(JSON.stringify(wire)));
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

describe("pairing", () => {
  it("ends with both sides showing the same picture, and the Host holding the Receiver's key", async () => {
    const net = localBridges(["one", "two"]);
    const code = newCode();
    const mine = await offer();
    const [host, receiver] = await Promise.all([
      pairAsHost({ bridges: net.urls, code, label: "Mum's phone", fetch: net.fetch }),
      pairAsReceiver({ bridges: net.urls, code, offer: mine, fetch: net.fetch }),
    ]);
    expect(host.picture).toEqual(receiver.picture);
    expect(host.receiver).toEqual(mine);
    expect(receiver.peerLabel).toBe("Mum's phone");
    expect(host.peerLabel).toBe("Amir's phone");
  });

  it("works whichever side arrives first", async () => {
    const net = localBridges(["one"]);
    const code = newCode();
    const receiver = pairAsReceiver({ bridges: net.urls, code, offer: await offer(), fetch: net.fetch });
    await new Promise((r) => setTimeout(r, 120));
    const host = await pairAsHost({ bridges: net.urls, code, label: "h", fetch: net.fetch });
    expect((await receiver).picture).toEqual(host.picture);
  });

  it("completes with one bridge down", async () => {
    const net = localBridges(["one", "two"]);
    net.bridges[0]!.down = true;
    const code = newCode();
    const [host, receiver] = await Promise.all([
      pairAsHost({ bridges: net.urls, code, label: "h", fetch: net.fetch }),
      pairAsReceiver({ bridges: net.urls, code, offer: await offer(), fetch: net.fetch }),
    ]);
    expect(host.picture).toEqual(receiver.picture);
  });

  it("two different codes never meet", async () => {
    expect(await slotIdFrom("12345678")).not.toBe(await slotIdFrom("12345679"));
    const net = localBridges(["one"]);
    const receiver = pairAsReceiver({ bridges: net.urls, code: "11111111", offer: await offer(), fetch: net.fetch, timeoutMs: 300 });
    const host = pairAsHost({ bridges: net.urls, code: "22222222", label: "h", fetch: net.fetch, timeoutMs: 300 });
    await expect(receiver).rejects.toThrow(PairingError);
    await expect(host).rejects.toThrow(PairingError);
  });

  it("refuses a code that is not eight digits before touching the network", async () => {
    const net = localBridges(["one"]);
    await expect(pairAsReceiver({ bridges: net.urls, code: "1234", offer: await offer(), fetch: net.fetch })).rejects.toThrow("bad_code");
    expect(net.bridges[0]!.log).toEqual([]);
  });
});

describe("a bridge that interferes with pairing (THREAT-MODEL A6)", () => {
  it("cannot swap in its own key without the pictures differing", async () => {
    // The hostile bridge replaces the Receiver's key and box with its own on
    // the way to the Host. The Host does end up holding the wrong key; what
    // must hold is that the two people see different pictures. One try in 512
    // matches by luck, so this runs 24 pairings and allows at most two.
    const attacker = await offer("attacker");
    let matches = 0;
    for (let i = 0; i < 24; i++) {
      const net = localBridges(["one"]);
      const code = newCode();
      const hostile = tamper(net.fetch, "offer", (m) => {
        m.pk = attacker.publicKey;
        m.box = attacker.boxId;
      });
      const [host, receiver] = await Promise.all([
        pairAsHost({ bridges: net.urls, code, label: "h", fetch: hostile }),
        pairAsReceiver({ bridges: net.urls, code, offer: await offer(), fetch: net.fetch }),
      ]);
      expect(host.receiver.publicKey).toBe(attacker.publicKey);
      if (host.picture.colour === receiver.picture.colour && host.picture.thing === receiver.picture.thing) matches++;
    }
    expect(matches).toBeLessThanOrEqual(2);
  });

  it("cannot change the Host's nonce after committing to it", async () => {
    // Choosing the nonce late is how a bridge would steer the Receiver's
    // picture toward the one the Host shows. The commitment forbids it.
    const net = localBridges(["one"]);
    const code = newCode();
    const hostile = tamper(net.fetch, "reveal", (m) => {
      m.n = b64url(crypto.getRandomValues(new Uint8Array(32)));
    });
    const host = pairAsHost({ bridges: net.urls, code, label: "h", fetch: net.fetch });
    const receiver = pairAsReceiver({ bridges: net.urls, code, offer: await offer(), fetch: hostile });
    await expect(receiver).rejects.toThrow("tampered");
    await host;
  });
});

describe("pictures", () => {
  it("are 512 combinations with no repeated word in either language", () => {
    expect(COLOURS).toHaveLength(8);
    expect(THINGS).toHaveLength(64);
    for (const list of [COLOURS, THINGS]) {
      expect(new Set(list.map((x) => x.fa)).size).toBe(list.length);
      expect(new Set(list.map((x) => x.en)).size).toBe(list.length);
    }
    expect(new Set(THINGS.map((x) => x.emoji)).size).toBe(64);
  });
});
