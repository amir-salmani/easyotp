/**
 * The Receiver app, end to end, in a real browser: install gate, pairing with
 * a Host over two bridges, the picture, a message arriving once though both
 * bridges deliver it, copying the code, switching language.
 *
 * Everything runs on this machine: two copies of the Node bridge, the app's
 * development server pointed at them, and a headless Chromium. The Host is
 * played by the same pairing code the tests use.
 *
 *   npm run e2e        (build the bridge first: cd ../bridge && npm run build:node)
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { randomKey } from "../src/ids";
import { seal, type Message } from "../src/open";
import { newCode, pairAsHost } from "../src/pairing";
import { COLOURS, THINGS } from "../src/pictures";

const SHOTS = "e2e-shots";
const APP = "http://127.0.0.1:5198";
const BRIDGES = ["http://127.0.0.1:18101", "http://127.0.0.1:18102"];
const children: ChildProcess[] = [];

async function up(url: string) {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${url} did not start`);
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  for (const bridge of BRIDGES) {
    const env = { ...process.env, HOST: "127.0.0.1", PORT: new URL(bridge).port, DATA_DIR: mkdtempSync(join(tmpdir(), "easyotp-e2e-")), POLL_HOLD_SECONDS: "2" };
    children.push(spawn(process.execPath, ["../bridge/dist/node.mjs"], { env, stdio: "ignore" }));
    await up(`${bridge}/health`);
  }
  children.push(spawn("npx", ["vite", "--port", "5198", "--strictPort", "--host", "127.0.0.1"], { env: { ...process.env, VITE_BRIDGES: BRIDGES.join(",") }, stdio: "ignore" }));
  await up(APP);

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (process.env.E2E_DEBUG) {
    page.on("console", (m) => console.log("console:", m.text()));
    page.on("requestfailed", (r) => console.log("failed:", r.method(), r.url(), r.failure()?.errorText));
    page.on("response", (r) => r.url().includes("/v2/") && console.log("response:", r.status(), r.request().method(), r.url()));
  }
  const shot = (name: string) => page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });

  // 1. In a browser tab the app shows the install gate and nothing else.
  await page.goto(APP);
  await page.getByRole("heading", { name: "اول آن را به صفحه‌ی اصلی اضافه کنید" }).waitFor();
  assert.equal(await page.locator("#code").count(), 0, "no pairing form behind the gate");
  assert.equal(await page.evaluate(() => document.documentElement.dir), "rtl");
  await shot("1-install");

  // 2. Pairing: the Host shows a code, the person types it.
  await page.goto(`${APP}/?preview`);
  await page.getByRole("heading", { name: "اتصال به گوشی فرستنده" }).waitFor();
  await shot("2-pair");
  const code = newCode();
  const host = pairAsHost({ bridges: BRIDGES, code, label: "گوشی مامان", timeoutMs: 30_000 });
  await page.locator("#code").fill(code);
  await page.locator("#label").fill("آیفون امیر");
  await page.getByRole("button", { name: "ادامه" }).click();

  // 3. Both sides arrive at the same picture.
  const paired = await host;
  const expected = `${THINGS[paired.picture.thing]!.fa} ${COLOURS[paired.picture.colour]!.fa}`;
  await page.getByRole("heading", { name: "هر دو همین را می‌بینید؟" }).waitFor();
  assert.equal(await page.getByRole("img").getAttribute("aria-label"), expected, "the Receiver shows the Host's picture");
  assert.equal(paired.peerLabel, "آیفون امیر");
  await page.getByText("گوشی فرستنده: گوشی مامان").waitFor();
  await shot("3-picture");
  await page.getByRole("button", { name: "بله، همین است" }).click();
  await page.getByRole("heading", { name: "متصل شد" }).waitFor();
  await page.getByRole("button", { name: "دیدن پیام‌ها" }).click();
  await page.getByRole("heading", { name: "هنوز پیامی نرسیده است" }).waitFor();
  await shot("4-empty");

  // 4. The Host leaves one message at both bridges. It is shown once.
  const message: Message = { v: 2, id: randomKey(24), sim: "همراه اول", from: "+98200", body: "رمز پویا: 48217365 مبلغ 250000 ریال", code: "48217365", at: Date.now() };
  const { enc, ct } = await seal(paired.receiver.publicKey, message);
  for (const bridge of BRIDGES) {
    const res = await fetch(`${bridge}/v2/box/${paired.receiver.boxId}`, { method: "POST", body: JSON.stringify({ v: 2, id: message.id, enc, ct }) });
    assert.equal(res.status, 200);
  }
  await page.getByText("48217365", { exact: true }).waitFor();
  await page.waitForTimeout(3000); // long enough for the second bridge to deliver its copy
  assert.equal(await page.getByText("48217365", { exact: true }).count(), 1, "one card though two bridges delivered");
  await page.getByText("۲ از ۲ پل در دسترس است").waitFor();
  // In a right-to-left page a "+98…" number is easily drawn backwards. The
  // plus sign must sit to the left of the digits, as it is dialled.
  const plusIsFirst = await page.evaluate(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf("+98200");
      if (at < 0) continue;
      const x = (i: number) => {
        const range = document.createRange();
        range.setStart(node!, at + i);
        range.setEnd(node!, at + i + 1);
        return range.getBoundingClientRect().left;
      };
      return x(0) < x(5);
    }
    return null;
  });
  assert.equal(plusIsFirst, true, "the sender's number reads +98200, not 98200+");
  await shot("5-message");

  // 5. One tap copies the code.
  await page.getByRole("button", { name: "کپی کد" }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "48217365");

  // 6. The same screen in English, left to right.
  await page.getByRole("button", { name: "English" }).click();
  await page.getByRole("heading", { name: "Messages" }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dir), "ltr");
  await shot("6-english");

  // 7. A reload keeps the pairing and the message: both live on the device.
  await page.reload();
  await page.getByText("48217365", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Messages" }).waitFor();

  assert.deepEqual(errors, [], "no script errors on any screen");
  await browser.close();
  console.log(`e2e passed. Screenshots in ${SHOTS}/`);
}

// Nothing here should take a minute. A hang is a failure, not a wait.
setTimeout(() => {
  console.error("e2e timed out");
  children.forEach((c) => c.kill());
  process.exit(1);
}, 90_000).unref();

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    children.forEach((c) => c.kill());
    process.exit(process.exitCode ?? 0);
  });
