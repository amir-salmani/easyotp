/**
 * The Host app itself, on an Android emulator, against the live bridges, with
 * this script playing the Receiver. It is the nearest thing to a real phone
 * that can be run from a desk:
 *
 *   sets the app up through its own screens, pairs by the code the app shows,
 *   compares the pictures, sends the emulator an SMS and reads it here,
 *   then asks the phone to ring and waits to be told that it did.
 *
 * It needs an emulator running with a debug build of the Host installed
 * (`./gradlew :host:installDebug`), and `adb` on the PATH or in ANDROID_HOME.
 *
 *   npm run emulator-check
 *
 * What it cannot show is what only hardware shows: a real SIM, a real carrier,
 * and what a phone's maker does to an app left alone for a week.
 */
import { execFileSync } from "node:child_process";
import { _android as android, type Page } from "playwright";
import { SEED_BRIDGES } from "../src/bridges";
import { sendCommand } from "../src/commands";
import { boxIdFrom, randomKey } from "../src/ids";
import { collectFrom, type Identity } from "../src/inbox";
import { newKeyPair, type Message, type Status } from "../src/open";
import { pairAsReceiver } from "../src/pairing";
import { pictureFrom } from "../src/pictures";
import { steadyFetch } from "./steady-fetch";

const APP = "ir.rhinocloud.easyotp.host";
const ADB = process.env.ANDROID_HOME ? `${process.env.ANDROID_HOME}/platform-tools/adb` : "adb";
/**
 * This check erases the app's data, so it only ever runs against an emulator.
 * A real phone plugged into the same machine, with a real pairing on it, is
 * never touched: every adb command names the emulator.
 */
const SERIAL = execFileSync(ADB, ["devices"], { encoding: "utf8" }).split("\n").map((line) => line.split("\t")).find(([serial, state]) => serial?.startsWith("emulator-") && state === "device")?.[0];
if (!SERIAL) throw new Error("no running emulator found; this check does not run on a real phone");
const adb = (...args: string[]) => execFileSync(ADB, ["-s", SERIAL, ...args], { encoding: "utf8" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const step = (text: string) => console.log(`ok   ${text}`);

interface HostState {
  consent: boolean;
  perms: Record<string, boolean>;
  receivers: Array<{ id: string; label: string }>;
  sims: Array<{ key: string; name: string }>;
  pair: null | { stage: string; code: string; sas: string | null; peer: string | null };
  test: null | { ok: boolean; at: number };
}
const state = (page: Page) => page.evaluate(() => JSON.parse((window as any).EasyOtpNative.state())) as Promise<HostState>;

async function until<T>(what: string, read: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const got = await read();
    if (got) return got;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(500);
  }
}

// A clean start: the app as it is on the day it is installed.
adb("shell", "pm", "clear", APP);
adb("shell", "am", "start", "-n", `${APP}/ir.rhinocloud.easyotp.ui.MainActivity`);
// Playwright's Android driver finds the app's WebView through adb and
// attaches to it as it would to a browser tab.
const device = (await android.devices()).find((d) => d.serial() === SERIAL);
if (!device) throw new Error(`the emulator ${SERIAL} is not reachable`);
const view = await device.webView({ pkg: APP }, { timeout: 30_000 });
const page = await view.page();
page.on("pageerror", (e) => console.log(`PAGE ERROR ${e.message}`));

try {
  // Setup, through the screens. Android's own permission questions are
  // answered with adb, since they are not part of the page.
  await page.locator("input[type=checkbox]").check();
  await page.getByRole("button", { name: "ادامه" }).click();
  if (!(await state(page)).consent) throw new Error("consent was not stored");
  for (const permission of ["RECEIVE_SMS", "READ_PHONE_STATE", "POST_NOTIFICATIONS"]) {
    adb("shell", "pm", "grant", APP, `android.permission.${permission}`);
  }
  adb("shell", "dumpsys", "deviceidle", "whitelist", `+${APP}`);
  await page.evaluate(() => window.dispatchEvent(new Event("easyotp:change")));
  await page.getByRole("button", { name: "اتصال یک گیرنده" }).waitFor();
  const before = await state(page);
  // The two optional powers are still off here, as on a fresh install.
  if (["sms", "phone", "notify", "battery"].some((p) => !before.perms[p])) throw new Error(`permissions: ${JSON.stringify(before.perms)}`);
  step(`set up; the phone sees ${before.sims.length} SIM: ${before.sims.map((s) => s.name).join(", ")}`);

  // Pair. The code comes off the phone's screen, as it would be read out.
  await page.getByRole("button", { name: "اتصال یک گیرنده" }).click();
  const abandoned = await until("a code", async () => (await state(page)).pair?.code);
  // The phone's Back button gives up a pairing, and the next one has a new code.
  // Wait for the page to show the code first: Back on the home screen leaves the app.
  await page.getByText("در انتظار گیرنده").waitFor();
  // An emulator fresh from boot sometimes puts a "not responding" dialog on top, which would take the key.
  const focus = /mCurrentFocus=.*/.exec(adb("shell", "dumpsys", "window"))?.[0] ?? "";
  if (!focus.includes(APP)) throw new Error(`something else is in front of the app: ${focus}`);
  adb("shell", "input", "keyevent", "BACK");
  await until("Back to close the pairing", async () => (await state(page)).pair === null);
  await page.getByRole("button", { name: "اتصال یک گیرنده" }).click();
  const shown = await until("a code", async () => (await state(page)).pair?.code);
  if (shown === abandoned) throw new Error("the same code was shown twice");
  const keys = await newKeyPair();
  const boxKey = randomKey();
  const identity: Identity = { privateKey: keys.privateKey, boxKey, boxId: await boxIdFrom(boxKey) };
  const mine = await pairAsReceiver({
    bridges: SEED_BRIDGES, code: shown, privateKey: keys.privateKey, timeoutMs: 60_000, fetch: steadyFetch,
    offer: { publicKey: keys.publicKey, boxId: identity.boxId, label: "emulator-check 📲" },
  });
  const theirs = await until("the phone's picture", async () => {
    const pair = (await state(page)).pair;
    return pair?.stage === "picture" && pair.sas ? pair : null;
  });
  const picture = pictureFrom(Uint8Array.from(atob(theirs.sas!.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
  if (picture.colour !== mine.picture.colour || picture.thing !== mine.picture.thing) throw new Error("the pictures differ");
  if (theirs.peer !== "emulator-check 📲") throw new Error(`the phone calls this Receiver ${theirs.peer}`);
  if (!mine.host) throw new Error("the phone gave no command channel");
  await page.getByRole("button", { name: "بله، همین است" }).click();
  await until("the Receiver to be stored", async () => (await state(page)).receivers.length === 1);
  step(`paired with "${mine.peerLabel}"; both sides drew picture ${picture.colour}/${picture.thing}`);

  // What arrives in this Receiver's box.
  const seen = new Map<string, Message>();
  let status: Status | null = null;
  const store = {
    has: async (id: string) => seen.has(id),
    put: async (m: Message) => void seen.set(m.id, m),
    status: async (s: Status) => void (status = !status || s.at >= status.at ? s : status),
  };
  const collect = async () => {
    for (const bridge of SEED_BRIDGES) await collectFrom(bridge, identity, store, steadyFetch, undefined, 20_000).catch(() => null);
  };

  // Pairing alone should make the phone report on itself.
  const first = await until("the first status report", async () => (await collect(), status as Status | null), 90_000);
  step(`status: battery ${first.battery}%, charging ${first.charging}, network ${first.net}, every ${first.every}s`);

  // An SMS, as the modem would deliver it.
  const text = `رمز یکبار مصرف: ${String(Date.now()).slice(-5)}`;
  adb("emu", "sms", "send", "+98200", text);
  const sms = await until("the SMS", async () => (await collect(), [...seen.values()].find((m) => m.body === text)), 90_000);
  if (sms.code !== text.slice(-5)) throw new Error(`code read as ${sms.code}`);
  step(`an SMS from ${sms.from} on "${sms.sim}" arrived, code ${sms.code}`);

  // The test button.
  await page.getByRole("button", { name: "فرستادن پیام آزمایشی" }).click();
  await until("the test message", async () => (await collect(), [...seen.values()].find((m) => m.from === "EasyOTP")), 90_000);
  if (!(await until("the phone to report the test", async () => (await state(page)).test))?.ok) throw new Error("the phone says the test failed");
  step("the test message arrived");

  // The two optional powers, switched on at the phone as its owner would.
  await page.getByLabel("بتواند از این گوشی پیامک بفرستد").check();
  await page.getByLabel("گیرنده‌ها از تماس‌ها باخبر شوند و بتوانند آن را رد کنند").check();
  for (const permission of ["SEND_SMS", "READ_CALL_LOG", "ANSWER_PHONE_CALLS"]) adb("shell", "pm", "grant", APP, `android.permission.${permission}`);
  await page.evaluate(() => window.dispatchEvent(new Event("easyotp:change")));
  await sendCommand(SEED_BRIDGES, mine.host, "ping", steadyFetch);
  await until("the phone to say what this Receiver may ask", async () => (await collect(), ["sms", "calls"].every((c) => (status as Status | null)?.can?.includes(c))), 90_000);
  const record = (text: string) => [...seen.values()].find((m) => m.kind === "sent" && m.body === text);

  // An answer to whoever wrote is sent, and listed.
  await sendCommand(SEED_BRIDGES, mine.host, "sms", steadyFetch, { to: sms.from, text: "باشه، ممنون", sim: sms.simKey });
  const answered = await until("the reply to be sent", async () => (await collect(), record("باشه، ممنون")), 120_000);
  if (!answered.ok || answered.from !== sms.from) throw new Error(`reply: ok=${answered.ok} why=${answered.why}`);
  // A number that never wrote to this SIM is refused, and the reason comes back.
  await sendCommand(SEED_BRIDGES, mine.host, "sms", steadyFetch, { to: "+989990001122", text: "سلام غریبه", sim: sms.simKey });
  const refused = await until("the refusal", async () => (await collect(), record("سلام غریبه")), 120_000);
  if (refused.ok || refused.why !== "stranger") throw new Error(`a stranger was written to: ok=${refused.ok} why=${refused.why}`);
  step(`replied to ${sms.from}; a message to a stranger was refused (${refused.why})`);

  // The phone rings. This Receiver is told, declines, and has the caller told why.
  adb("emu", "gsm", "call", "09121234567");
  const ringing = await until("the call", async () => (await collect(), [...seen.values()].find((m) => m.kind === "call")), 120_000);
  await sendCommand(SEED_BRIDGES, mine.host, "decline", steadyFetch, { text: "بعداً تماس می‌گیرم." });
  const told = await until("the caller to be told", async () => (await collect(), record("بعداً تماس می‌گیرم.")), 120_000);
  if (!told.ok || told.from !== ringing.from) throw new Error(`decline: ok=${told.ok} why=${told.why} to=${told.from}`);
  await until("the call to be ended by the phone", async () => !/inbound/.test(adb("emu", "gsm", "list")), 30_000);
  // A call nobody deals with is reported as missed.
  await sleep(3000);
  adb("emu", "gsm", "call", "09127654321");
  await until("the second call", async () => (await collect(), [...seen.values()].find((m) => m.kind === "call" && m.from !== ringing.from)), 120_000);
  adb("emu", "gsm", "cancel", "09127654321");
  const missed = await until("the missed call", async () => (await collect(), [...seen.values()].find((m) => m.kind === "missed")), 120_000);
  step(`a call from ${ringing.from} was declined with a message; one from ${missed.from} was reported missed`);

  // Ring.
  adb("logcat", "-c");
  const command = await sendCommand(SEED_BRIDGES, mine.host, "buzz", steadyFetch);
  await until("the ring to be answered", async () => (await collect(), (status as Status | null)?.ack === command), 120_000);
  if (!/command BUZZ/.test(adb("logcat", "-d", "-s", "EasyOTP"))) throw new Error("no ring in the phone's log");
  step("asked to ring; the phone rang and said so");

  // Disconnect, and nothing more is sent.
  // The row of someone just connected is already open.
  if (!(await page.getByRole("button", { name: "قطع اتصال" }).isVisible())) await page.getByRole("button", { name: /emulator-check/ }).click();
  await page.getByRole("button", { name: "قطع اتصال" }).click();
  await page.getByRole("button", { name: "بله، قطع کن" }).click();
  await until("the Receiver to be removed", async () => (await state(page)).receivers.length === 0);
  const count = seen.size;
  adb("emu", "sms", "send", "+98200", "after disconnect 99999");
  await sleep(8000);
  await collect();
  if (seen.size !== count) throw new Error("a message arrived after disconnecting");
  step("disconnected; an SMS sent afterwards went nowhere");
} finally {
  await page.screenshot({ path: "e2e-shots/emulator-host.png" }).catch(() => {});
  await device.close();
}
process.exit(0);
