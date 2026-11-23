/**
 * A stand-in for the Host phone, for trying the Receiver before the Host app
 * has screens. It shows a code, pairs, shows the picture, then reports on
 * itself every thirty seconds, rings when asked, and seals each line you type
 * as an SMS.
 *
 *   npm run fake-host                       against the live bridges
 *   npm run fake-host -- <bridge>...        against the bridges you name
 *   FAKE_HOST_NAME="Mum's phone" npm run fake-host    to try a second Host
 *
 * At the prompt: a line is sent as an SMS. `/battery 12` and `/unplug` change
 * what it reports, so the Receiver's warnings can be seen.
 */
import { createInterface } from "node:readline/promises";
import { SEED_BRIDGES } from "../src/bridges";
import { newCode } from "../src/pairing";
import { COLOURS, THINGS } from "../src/pictures";
import { simHost } from "./sim-host";
import { steadyFetch } from "./steady-fetch";

const bridges = process.argv.length > 2 ? process.argv.slice(2) : [...SEED_BRIDGES];
const name = process.env.FAKE_HOST_NAME ?? "Fake Host";
const rl = createInterface({ input: process.stdin, output: process.stdout });

// Ctrl-C at a prompt is how this ends. It is not an error.
const quit = (e: unknown) => {
  if ((e as { code?: string }).code !== "ABORT_ERR") throw e;
  console.log("\nStopped.");
  process.exit(0);
};
process.on("uncaughtException", quit);
process.on("unhandledRejection", quit);

const code = newCode();
console.log(`\nBridges: ${bridges.join(", ")}`);
console.log(`\nRead this code to the person with the Receiver:\n\n    ${code.slice(0, 4)} ${code.slice(4)}\n\nWaiting for them to type it (ten minutes)...`);

const state = { battery: 82, charging: true, net: "wifi" as const, pending: 0 };
const host = await simHost({
  bridges, code, label: name, state, every: 30, fetch: steadyFetch,
  onCommand: (cmd) => console.log(cmd === "buzz" ? "\n\u0007*** The Receiver asked this phone to RING ***" : "\n(the Receiver asked for a fresh report)"),
});
const colour = COLOURS[host.picture.colour]!;
const thing = THINGS[host.picture.thing]!;
console.log(`\n"${host.peerLabel}" answered. Both screens must show:\n\n    ${thing.emoji}  ${thing.en} · ${colour.en}    (${thing.fa} · ${colour.fa})\n`);

if ((await rl.question("Is it the same on the Receiver? [y/N] ")).trim().toLowerCase() !== "y") {
  console.log("Not the same: nothing was saved and nothing will be sent.");
  process.exit(1);
}

host.start();
console.log("\nPaired. Reporting every 30 s. Type a line and press Enter to send it as an SMS. Ctrl-C to stop.");
console.log('Try: "رمز پویا: 48217365 مبلغ 250000 ریال", or /battery 12, /unplug, /plug\n');

for (;;) {
  const line = (await rl.question("> ")).trim();
  if (!line) continue;
  const battery = /^\/battery (\d{1,3})$/.exec(line);
  if (battery || line === "/unplug" || line === "/plug") {
    if (battery) state.battery = Math.min(100, Number(battery[1]));
    if (line === "/unplug") state.charging = false;
    if (line === "/plug") state.charging = true;
    await host.sendStatus();
    console.log(`  reported: battery ${state.battery}%, ${state.charging ? "charging" : "not charging"}`);
    continue;
  }
  // The real Host finds the code with MessageClassifier; this is only a stand-in.
  const found = /(?<![0-9])[0-9]{4,8}(?![0-9])/.exec(line)?.[0] ?? null;
  console.log(`  sent: ${(await host.sendSms(line, found)).join(", ")}`);
}
