/**
 * Checks deployed bridges by doing what a Host and a Receiver do, from this
 * machine: pair by code, compare pictures, seal a message, leave it at every
 * bridge, collect it, acknowledge it, then ask the Host to ring and hear back. Uses throwaway keys and leaves nothing
 * behind.
 *
 *   npm run live-check                 every seed bridge together, then each alone
 *   npm run live-check -- <bridge>...  the bridges you name
 */
import { SEED_BRIDGES } from "../src/bridges";
import { boxIdFrom, randomKey } from "../src/ids";
import { collectFrom, type Identity } from "../src/inbox";
import { sendCommand } from "../src/commands";
import { newKeyPair, type Message, type Status } from "../src/open";
import { newCode, pairAsReceiver } from "../src/pairing";
import { simHost } from "./sim-host";

async function check(bridges: readonly string[]): Promise<void> {
  const keys = await newKeyPair();
  const boxKey = randomKey();
  const identity: Identity = { privateKey: keys.privateKey, boxKey, boxId: await boxIdFrom(boxKey) };
  const code = newCode();

  const started = Date.now();
  let rang = 0;
  const [host, receiver] = await Promise.all([
    simHost({ bridges, code, label: "live-check host", timeoutMs: 60_000, onCommand: (cmd) => void (cmd === "buzz" && rang++) }),
    pairAsReceiver({ bridges, code, offer: { publicKey: keys.publicKey, boxId: identity.boxId, label: "live-check" }, privateKey: keys.privateKey, timeoutMs: 60_000 }),
  ]);
  try {
    if (host.picture.colour !== receiver.picture.colour || host.picture.thing !== receiver.picture.thing) throw new Error("pictures differ");
    if (host.receiver.publicKey !== keys.publicKey) throw new Error("the Host holds a different key");
    if (!receiver.host) throw new Error("the Host gave no command channel");
    const paired = Date.now() - started;

    const sent = await host.sendSms("رمز: 4821", "4821");
    if (sent.some((r) => !r.endsWith(" 200"))) throw new Error(`deposit: ${sent.join(", ")}`);

    const seen = new Map<string, Message>();
    let status: Status | null = null;
    const store = {
      has: async (id: string) => seen.has(id),
      put: async (m: Message) => void seen.set(m.id, m),
      status: async (s: Status) => void (status = !status || s.at >= status.at ? s : status),
    };
    const pass = async () => {
      let fresh = 0;
      for (const bridge of bridges) {
        const result = await collectFrom(bridge, identity, store);
        if (!result.acknowledged) throw new Error(`${bridge} refused the acknowledgement`);
        fresh += result.fresh.length;
      }
      return fresh;
    };
    const fresh = await pass();
    if (fresh !== 1 || [...seen.values()][0]?.body !== "رمز: 4821") throw new Error(`expected the message once, got ${fresh}`);

    // Ask the Host to ring, and wait to be told that it did.
    host.start();
    const command = await sendCommand(bridges, receiver.host, "buzz");
    const deadline = Date.now() + 30_000;
    while ((status as Status | null)?.ack !== command) {
      if (Date.now() > deadline) throw new Error("the Host never answered the ring");
      await pass();
    }
    if (rang !== 1) throw new Error(`the Host rang ${rang} times`);
    console.log(`ok   ${bridges.map((b) => new URL(b).host).join(" + ")}   paired in ${paired} ms, message delivered once, ring answered`);
  } finally {
    host.stop();
  }
}

const named = process.argv.slice(2);
const sets = named.length ? [named] : [[...SEED_BRIDGES], ...SEED_BRIDGES.map((b) => [b])];
let failed = false;
for (const bridges of sets) {
  await check(bridges).catch((e: Error) => {
    failed = true;
    console.log(`FAIL ${bridges.map((b) => new URL(b).host).join(" + ")}   ${e.message}`);
  });
}
process.exit(failed ? 1 : 0);
