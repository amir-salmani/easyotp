/** A Host's reports on itself, and asking a Host to do something. */
import { describe, expect, it } from "vitest";
import { sendCommand } from "../src/commands";
import { boxIdFrom, randomKey } from "../src/ids";
import { collectFrom, type Identity, type InboxStore } from "../src/inbox";
import { newKeyPair, openAny, seal, type Message, type Status } from "../src/open";
import { newCode, pairAsReceiver } from "../src/pairing";
import { simHost } from "../tools/sim-host";
import { localBridges } from "./local-bridge";

async function pairedPair(net: ReturnType<typeof localBridges>, onCommand?: (cmd: string) => void) {
  const keys = await newKeyPair();
  const boxKey = randomKey();
  const identity: Identity = { privateKey: keys.privateKey, boxKey, boxId: await boxIdFrom(boxKey) };
  const code = newCode();
  const [host, receiver] = await Promise.all([
    simHost({ bridges: net.urls, code, label: "Mum's phone", fetch: net.fetch, every: 60, onCommand }),
    pairAsReceiver({ bridges: net.urls, code, offer: { publicKey: keys.publicKey, boxId: identity.boxId, label: "me" }, privateKey: keys.privateKey, fetch: net.fetch }),
  ]);
  const messages: Message[] = [];
  const reports: Status[] = [];
  const store: InboxStore = {
    has: async (id) => messages.some((m) => m.id === id),
    put: async (m) => void messages.push(m),
    status: async (s) => void reports.push(s),
  };
  const collect = async () => {
    for (const url of net.urls) await collectFrom(url, identity, store, net.fetch);
  };
  return { host, receiver, identity, messages, reports, collect };
}

describe("a Host's reports", () => {
  it("reach the Receiver as a report, never as a message", async () => {
    const net = localBridges(["one"]);
    const p = await pairedPair(net);
    await p.host.sendStatus({ battery: 41, charging: false, net: "cell", pending: 2 });
    await p.collect();
    expect(p.messages).toEqual([]);
    expect(p.reports).toHaveLength(1);
    expect(p.reports[0]).toMatchObject({ k: "status", battery: 41, charging: false, net: "cell", pending: 2, every: 60 });
  });

  it("do not pile up at a bridge: only the newest waits", async () => {
    const net = localBridges(["one"]);
    const p = await pairedPair(net);
    for (const battery of [80, 60, 40]) await p.host.sendStatus({ battery });
    await p.host.sendSms("code 4821", "4821");
    await p.collect();
    expect(p.reports.map((r) => r.battery)).toEqual([40]);
    expect(p.messages).toHaveLength(1);
  });

  it("are refused when they claim something no phone could", async () => {
    const net = localBridges(["one"]);
    const p = await pairedPair(net);
    const bad = { v: 2, k: "status", id: randomKey(24), at: Date.now(), every: 60, battery: 250, charging: true, net: "wifi", pending: 0 } as unknown as Status;
    const { enc, ct } = await seal(p.host.receiver.publicKey, bad);
    await net.fetch(`${net.urls[0]}/v2/box/${p.identity.boxId}`, { method: "POST", body: JSON.stringify({ v: 2, id: bad.id, enc, ct }) });
    await p.collect();
    expect(p.reports).toEqual([]);
  });
});

describe("asking a Host to do something", () => {
  it("makes it ring once, and the Host says that it did", async () => {
    const net = localBridges(["one", "two"]);
    const heard: string[] = [];
    const p = await pairedPair(net, (cmd) => heard.push(cmd));
    expect(p.receiver.host).not.toBeNull();
    p.host.start();
    try {
      const id = await sendCommand(net.urls, p.receiver.host!, "buzz", net.fetch);
      for (let i = 0; i < 40 && !p.reports.some((r) => r.ack === id); i++) {
        await new Promise((r) => setTimeout(r, 50));
        await p.collect();
      }
      expect(p.reports.some((r) => r.ack === id)).toBe(true);
      // Left at two bridges, obeyed once.
      expect(heard).toEqual(["buzz"]);
    } finally {
      p.host.stop();
    }
  });

  it("is sealed: a bridge sees neither the command nor where a Host listens for them", async () => {
    const net = localBridges(["one"]);
    const p = await pairedPair(net);
    const everything = net.bridges[0]!.seen.join("\n");
    // The channel was handed over inside the pairing, sealed to the Receiver.
    expect(everything).not.toContain(p.receiver.host!.publicKey);
    expect(everything).not.toContain(p.receiver.host!.boxId);
  });

  it("cannot be given by someone who was never paired", async () => {
    // A stranger knows the Host's command box id (a bridge does), but not the
    // key commands are sealed to.
    const net = localBridges(["one"]);
    const heard: string[] = [];
    const p = await pairedPair(net, (cmd) => heard.push(cmd));
    p.host.start();
    try {
      const stranger = await newKeyPair();
      await sendCommand(net.urls, { publicKey: stranger.publicKey, boxId: p.receiver.host!.boxId }, "buzz", net.fetch);
      await new Promise((r) => setTimeout(r, 400));
      expect(heard).toEqual([]);
    } finally {
      p.host.stop();
    }
  });

  it("is dropped if it turns up in a Receiver's own box", async () => {
    const net = localBridges(["one"]);
    const p = await pairedPair(net);
    const { enc, ct } = await seal(p.host.receiver.publicKey, { v: 2, k: "cmd", id: "c".repeat(24), at: 1, cmd: "buzz" });
    await net.fetch(`${net.urls[0]}/v2/box/${p.identity.boxId}`, { method: "POST", body: JSON.stringify({ v: 2, id: "c".repeat(24), enc, ct }) });
    await p.collect();
    expect(p.messages).toEqual([]);
    expect(p.reports).toEqual([]);
    expect((await openAny(p.identity.privateKey, "c".repeat(24), enc, ct)).id).toBe("c".repeat(24));
  });
});
