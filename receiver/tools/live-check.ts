/**
 * Checks deployed bridges by doing what a Host and a Receiver do, from this
 * machine: pair by code, compare pictures, seal a message, leave it at every
 * bridge, collect it, acknowledge it. Uses throwaway keys and leaves nothing
 * behind.
 *
 *   npm run live-check                 every seed bridge together, then each alone
 *   npm run live-check -- <bridge>...  the bridges you name
 */
import { SEED_BRIDGES } from "../src/bridges";
import { boxIdFrom, randomKey } from "../src/ids";
import { collectFrom, type Identity } from "../src/inbox";
import { newKeyPair, seal, type Message } from "../src/open";
import { newCode, pairAsHost, pairAsReceiver } from "../src/pairing";

async function check(bridges: readonly string[]): Promise<void> {
  const keys = await newKeyPair();
  const boxKey = randomKey();
  const identity: Identity = { privateKey: keys.privateKey, boxKey, boxId: await boxIdFrom(boxKey) };
  const code = newCode();

  const started = Date.now();
  const [host, receiver] = await Promise.all([
    pairAsHost({ bridges, code, label: "live-check host", timeoutMs: 60_000 }),
    pairAsReceiver({ bridges, code, offer: { publicKey: keys.publicKey, boxId: identity.boxId, label: "live-check" }, timeoutMs: 60_000 }),
  ]);
  if (host.picture.colour !== receiver.picture.colour || host.picture.thing !== receiver.picture.thing) throw new Error("pictures differ");
  if (host.receiver.publicKey !== keys.publicKey) throw new Error("the Host holds a different key");
  const paired = Date.now() - started;

  const message: Message = { v: 2, id: randomKey(24), sim: "live-check", from: "+98200", body: "رمز: 4821", code: "4821", at: Date.now() };
  const { enc, ct } = await seal(host.receiver.publicKey, message);
  for (const bridge of bridges) {
    const res = await fetch(`${bridge}/v2/box/${host.receiver.boxId}`, { method: "POST", body: JSON.stringify({ v: 2, id: message.id, enc, ct }) });
    if (!res.ok) throw new Error(`deposit at ${bridge}: ${res.status}`);
  }

  const seen = new Map<string, Message>();
  const store = { has: async (id: string) => seen.has(id), put: async (m: Message) => void seen.set(m.id, m) };
  let fresh = 0;
  for (const bridge of bridges) {
    const pass = await collectFrom(bridge, identity, store);
    if (!pass.acknowledged) throw new Error(`${bridge} refused the acknowledgement`);
    fresh += pass.fresh.length;
  }
  if (fresh !== 1 || seen.get(message.id)?.body !== message.body) throw new Error(`expected the message once, got ${fresh}`);
  console.log(`ok   ${bridges.map((b) => new URL(b).host).join(" + ")}   paired in ${paired} ms, message delivered once`);
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
