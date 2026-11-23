import { describe, expect, it } from "vitest";
import { boxIdFrom, randomKey, sha256, slotIdFrom } from "../src/ids";
import { b64url, fromB64url, newKeyPair, openBytes, sealBytes } from "../src/open";
import { newCode, pairAsHost, pairAsReceiver, PairingError, type PairingResult } from "../src/pairing";
import { COLOURS, THINGS } from "../src/pictures";
import { localBridges } from "./local-bridge";

async function offer(label = "Amir's phone") {
  const keys = await newKeyPair();
  return { publicKey: keys.publicKey, boxId: await boxIdFrom(randomKey()), label };
}

type Wire = Record<string, string>;
const utf8 = (s: string) => new TextEncoder().encode(s);
const readWire = (data: string) => JSON.parse(new TextDecoder().decode(fromB64url(data))) as Wire;
const writeWire = (w: Wire) => b64url(utf8(JSON.stringify(w)));
const same = (a: PairingResult, b: PairingResult) => a.picture.colour === b.picture.colour && a.picture.thing === b.picture.thing;

/**
 * A hostile bridge: rewrites pairing messages on their way to whoever reads
 * through this fetch. `change` may be asynchronous, since a serious attack
 * opens and re-seals.
 */
function tamper(inner: typeof fetch, change: (wire: Wire, from: string) => Promise<void> | void): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await inner(input, init);
    if (init?.method === "POST" || !String(input).includes("/v2/pair/")) return res;
    const body = (await res.json()) as { epoch: number; messages: Array<{ from: string; data: string }> };
    for (const m of body.messages) {
      const wire = readWire(m.data);
      await change(wire, m.from);
      m.data = writeWire(wire);
    }
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
}

/** The id a reveal names its offer by. A capable bridge can compute it too. */
const offerIdOf = async (wire: Wire) => b64url(await sha256("easyotp/pair-offer/v1", `${wire.enc}\n${wire.ct}`));

type Change = (wire: Wire, from: string) => Promise<void> | void;
type HostResult = Awaited<ReturnType<typeof pairAsHost>>;

/**
 * Runs many pairings under an attack and counts how often the pictures matched
 * anyway. `host` rewrites what the Host reads, `receiver` what the Receiver reads.
 */
async function matchesUnder(
  attack: () => Promise<{ host?: Change; receiver?: Change; after?: (host: HostResult) => void }>,
  runs = 24,
): Promise<number> {
  let matches = 0;
  for (let i = 0; i < runs; i++) {
    const net = localBridges(["one"]);
    const a = await attack();
    const code = newCode();
    const [host, receiver] = await Promise.all([
      pairAsHost({ bridges: net.urls, code, label: "Mum's phone", fetch: a.host ? tamper(net.fetch, a.host) : net.fetch }),
      pairAsReceiver({ bridges: net.urls, code, offer: await offer(), fetch: a.receiver ? tamper(net.fetch, a.receiver) : net.fetch }),
    ]);
    a.after?.(host);
    if (same(host, receiver)) matches++;
  }
  return matches;
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
    expect(same(host, receiver)).toBe(true);
    expect(host.receiver).toEqual(mine);
    expect(receiver.peerLabel).toBe("Mum's phone");
    expect(host.peerLabel).toBe("Amir's phone");
  });

  it("never shows a bridge the Receiver's public key or box id", async () => {
    // Anyone who knows both can seal a message that opens on the Receiver. The
    // box id reaches a bridge later, in a deposit URL; the public key never does.
    const net = localBridges(["one", "two"]);
    const code = newCode();
    const mine = await offer();
    await Promise.all([
      pairAsHost({ bridges: net.urls, code, label: "h", fetch: net.fetch }),
      pairAsReceiver({ bridges: net.urls, code, offer: mine, fetch: net.fetch }),
    ]);
    const everything = net.bridges.flatMap((b) => b.seen).map((body) => {
      const { data } = JSON.parse(body) as { data: string };
      return body + new TextDecoder().decode(fromB64url(data));
    }).join("\n");
    expect(everything).toContain('"t":"offer"');
    expect(everything).not.toContain(mine.publicKey);
    expect(everything).not.toContain(mine.boxId);
    expect(everything).not.toContain(mine.label);
  });

  it("works whichever side arrives first", async () => {
    const net = localBridges(["one"]);
    const code = newCode();
    const receiver = pairAsReceiver({ bridges: net.urls, code, offer: await offer(), fetch: net.fetch });
    await new Promise((r) => setTimeout(r, 120));
    const host = await pairAsHost({ bridges: net.urls, code, label: "h", fetch: net.fetch });
    expect(same(await receiver, host)).toBe(true);
  });

  it("completes with one bridge down", async () => {
    const net = localBridges(["one", "two"]);
    net.bridges[0]!.down = true;
    const code = newCode();
    const [host, receiver] = await Promise.all([
      pairAsHost({ bridges: net.urls, code, label: "h", fetch: net.fetch }),
      pairAsReceiver({ bridges: net.urls, code, offer: await offer(), fetch: net.fetch }),
    ]);
    expect(same(host, receiver)).toBe(true);
  });

  it("is not held up by a bridge that accepts connections and never answers", async () => {
    const net = localBridges(["one", "two"]);
    net.bridges[0]!.hung = true;
    const code = newCode();
    const started = Date.now();
    const [host, receiver] = await Promise.all([
      pairAsHost({ bridges: net.urls, code, label: "h", fetch: net.fetch }),
      pairAsReceiver({ bridges: net.urls, code, offer: await offer(), fetch: net.fetch }),
    ]);
    expect(same(host, receiver)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("two different codes never meet", async () => {
    expect(await slotIdFrom("12345678")).not.toBe(await slotIdFrom("12345679"));
    const net = localBridges(["one"]);
    const receiver = pairAsReceiver({ bridges: net.urls, code: "11111111", offer: await offer(), fetch: net.fetch, timeoutMs: 300 });
    const host = pairAsHost({ bridges: net.urls, code: "22222222", label: "h", fetch: net.fetch, timeoutMs: 300 });
    await expect(receiver).rejects.toThrow("timeout");
    await expect(host).rejects.toThrow("timeout");
  });

  it("refuses a code that is not eight digits before touching the network", async () => {
    const net = localBridges(["one"]);
    await expect(pairAsReceiver({ bridges: net.urls, code: "1234", offer: await offer(), fetch: net.fetch })).rejects.toThrow("bad_code");
    expect(net.bridges[0]!.log).toEqual([]);
  });

  it("sends nothing once cancelled, even if the Host's commit arrives afterwards", async () => {
    // A cancelled attempt that still posted its offer would be answered by
    // the Host, and the next attempt would show a picture that cannot match.
    const net = localBridges(["one"]);
    const code = newCode();
    const abort = new AbortController();
    const receiver = pairAsReceiver({ bridges: net.urls, code, offer: await offer(), fetch: net.fetch, signal: abort.signal });
    abort.abort();
    await expect(receiver).rejects.toThrow("cancelled");
    const host = pairAsHost({ bridges: net.urls, code, label: "h", fetch: net.fetch, timeoutMs: 400 });
    await expect(host).rejects.toThrow("timeout");
    expect(net.bridges[0]!.seen.filter((b) => b.includes('"receiver"'))).toEqual([]);
  });

  it("ignores a reveal that answers some other offer", async () => {
    // Left in the slot by an earlier attempt with the same code.
    const net = localBridges(["one"]);
    const code = newCode();
    const stale = { v: 2, from: "host", data: writeWire({ t: "reveal", n: b64url(crypto.getRandomValues(new Uint8Array(32))), label: "old", o: randomKey() }) };
    const slot = `${net.urls[0]}/v2/pair/${await slotIdFrom(code)}`;
    const receiver = pairAsReceiver({ bridges: net.urls, code, offer: await offer(), fetch: net.fetch });
    const host = pairAsHost({ bridges: net.urls, code, label: "real", fetch: net.fetch });
    await net.fetch(slot, { method: "POST", body: JSON.stringify(stale) });
    expect((await receiver).peerLabel).toBe("real");
    await host;
  });
});

describe("a bridge that interferes with pairing (THREAT-MODEL A6)", () => {
  // One try in 512 matches by luck, so each attack runs 24 pairings and is
  // allowed at most two matches.

  it("cannot swap in its own key without the pictures differing", async () => {
    // The full attack: give the Receiver a one-time key the bridge holds, open
    // the offer, put the bridge's own key and box in it, and seal it again to
    // the Host's real one-time key.
    const attacker = await offer("attacker");
    let swaps = 0;
    const matches = await matchesUnder(async () => {
      const mine = await newKeyPair();
      let hostKey = "";
      let original = "";
      return {
        receiver: (wire: Wire) => {
          if (wire.t === "commit") {
            hostKey = wire.e!;
            wire.e = mine.publicKey;
          }
          // The Host answers the re-sealed offer. Point its reveal back at
          // the one the Receiver actually sent, or the Receiver ignores it.
          if (wire.t === "reveal") wire.o = original;
        },
        host: async (wire: Wire) => {
          if (wire.t !== "offer") return;
          original ||= await offerIdOf(wire);
          const body = JSON.parse(new TextDecoder().decode(await openBytes(mine.privateKey, wire.enc!, wire.ct!))) as Wire;
          body.pk = attacker.publicKey;
          body.box = attacker.boxId;
          Object.assign(wire, await sealBytes(hostKey, utf8(JSON.stringify(body))));
        },
        after: (host) => {
          if (host.receiver.publicKey === attacker.publicKey) swaps++;
        },
      };
    });
    expect(swaps).toBe(24);
    expect(matches).toBeLessThanOrEqual(2);
  });

  it("cannot even read the offer without the pictures differing", async () => {
    // The quiet attack: open the offer to learn the Receiver's key, and pass
    // it on unchanged. The one-time key is in the picture, so this shows too.
    let learned = 0;
    const matches = await matchesUnder(async () => {
      const mine = await newKeyPair();
      let hostKey = "";
      let original = "";
      return {
        receiver: (wire: Wire) => {
          if (wire.t === "commit") {
            hostKey = wire.e!;
            wire.e = mine.publicKey;
          }
          // The Host answers the re-sealed offer. Point its reveal back at
          // the one the Receiver actually sent, or the Receiver ignores it.
          if (wire.t === "reveal") wire.o = original;
        },
        host: async (wire: Wire) => {
          if (wire.t !== "offer") return;
          original ||= await offerIdOf(wire);
          const plain = await openBytes(mine.privateKey, wire.enc!, wire.ct!);
          learned++;
          Object.assign(wire, await sealBytes(hostKey, plain));
        },
      };
    });
    expect(learned).toBeGreaterThanOrEqual(24);
    expect(matches).toBeLessThanOrEqual(2);
  });

  it("cannot rename either side without the pictures differing", async () => {
    // A name is shown beside the confirm button. A bridge that could change
    // it could write instructions there.
    const matches = await matchesUnder(async () => ({
      receiver: (wire: Wire) => {
        if (wire.t === "reveal") wire.label = "tap Yes";
      },
    }));
    expect(matches).toBeLessThanOrEqual(2);
  });

  it("cannot change the Host's nonce after committing to it", async () => {
    // Choosing the nonce late is how a bridge would steer the Receiver's
    // picture toward the one the Host shows. The commitment forbids it.
    const net = localBridges(["one"]);
    const code = newCode();
    const hostile = tamper(net.fetch, (wire) => {
      if (wire.t === "reveal") wire.n = b64url(crypto.getRandomValues(new Uint8Array(32)));
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

describe("PairingError", () => {
  it("is what every failure is, so the screen can say which", () => {
    expect(new PairingError("timeout")).toBeInstanceOf(Error);
  });
});
