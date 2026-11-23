/**
 * A stand-in for the Host phone, for trying the Receiver before the Host app
 * has screens. It does what the Host does: shows a code, pairs, shows the
 * picture, then seals each line you type as an SMS and leaves it at every
 * bridge.
 *
 *   npm run fake-host                       against the live bridges
 *   npm run fake-host -- <bridge>...        against the bridges you name
 *   FAKE_HOST_NAME="Mum's phone" npm run fake-host    to try a second Host
 */
import { createInterface } from "node:readline/promises";
import { SEED_BRIDGES } from "../src/bridges";
import { randomKey } from "../src/ids";
import { seal, type Message } from "../src/open";
import { newCode, pairAsHost } from "../src/pairing";
import { COLOURS, THINGS } from "../src/pictures";

const bridges = process.argv.length > 2 ? process.argv.slice(2) : [...SEED_BRIDGES];
const rl = createInterface({ input: process.stdin, output: process.stdout });

const code = newCode();
console.log(`\nBridges: ${bridges.join(", ")}`);
console.log(`\nRead this code to the person with the Receiver:\n\n    ${code.slice(0, 4)} ${code.slice(4)}\n\nWaiting for them to type it (ten minutes)...`);

const name = process.env.FAKE_HOST_NAME ?? "Fake Host";
// Ctrl-C at a prompt is how this ends. It is not an error.
process.on("uncaughtException", (e) => {
  if ((e as { code?: string }).code === "ABORT_ERR") {
    console.log("\nStopped.");
    process.exit(0);
  }
  throw e;
});
process.on("unhandledRejection", (e) => {
  if ((e as { code?: string }).code === "ABORT_ERR") {
    console.log("\nStopped.");
    process.exit(0);
  }
  throw e;
});

const paired = await pairAsHost({ bridges, code, label: name });
const colour = COLOURS[paired.picture.colour]!;
const thing = THINGS[paired.picture.thing]!;
console.log(`\n"${paired.peerLabel}" answered. Both screens must show:\n\n    ${thing.emoji}  ${thing.en} · ${colour.en}    (${thing.fa} · ${colour.fa})\n`);

if ((await rl.question("Is it the same on the Receiver? [y/N] ")).trim().toLowerCase() !== "y") {
  console.log("Not the same: nothing was saved and nothing will be sent.");
  process.exit(1);
}

console.log("\nPaired. Type a line and press Enter to send it as an SMS. Ctrl-C to stop.");
console.log('Try: "رمز پویا: 48217365 مبلغ 250000 ریال"\n');

for (;;) {
  const body = (await rl.question("> ")).trim();
  if (!body) continue;
  // The real Host finds the code with MessageClassifier; this is only a stand-in.
  const code = /(?<![0-9])[0-9]{4,8}(?![0-9])/.exec(body)?.[0] ?? null;
  const message: Message = { v: 2, id: randomKey(24), sim: `${name} SIM`, from: "+98200", body, code, at: Date.now() };
  const { enc, ct } = await seal(paired.receiver.publicKey, message);
  const results = await Promise.all(
    bridges.map((b) =>
      fetch(`${b}/v2/box/${paired.receiver.boxId}`, { method: "POST", body: JSON.stringify({ v: 2, id: message.id, enc, ct }) }).then(
        (r) => `${new URL(b).host} ${r.status}`,
        () => `${new URL(b).host} unreachable`,
      ),
    ),
  );
  console.log(`  sent: ${results.join(", ")}`);
}
