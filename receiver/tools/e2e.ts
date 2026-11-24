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
import { boxIdFrom, randomKey } from "../src/ids";
import { newKeyPair, seal, type Message } from "../src/open";
import { newCode } from "../src/pairing";
import { simHost, type SimHost } from "./sim-host";
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

  const sims: SimHost[] = [];
  /** Pairs with a new Host from whatever screen offers the code field. */
  const pairWith = async (hostName: string) => {
    const code = newCode();
    const rings: string[] = [];
    const host = simHost({ bridges: BRIDGES, code, label: hostName, timeoutMs: 30_000, every: 5, onCommand: (cmd) => rings.push(cmd) });
    await page.locator("#code").fill(code);
    await page.locator("#label").fill("آیفون امیر");
    await page.getByRole("button", { name: "ادامه" }).click();
    const paired = await host;
    const expected = `${THINGS[paired.picture.thing]!.fa} ${COLOURS[paired.picture.colour]!.fa}`;
    await page.getByRole("heading", { name: "هر دو همین را می‌بینید؟" }).waitFor();
    assert.equal(await page.getByRole("img").getAttribute("aria-label"), expected, "the Receiver shows the Host's picture");
    assert.equal(paired.peerLabel, "آیفون امیر");
    await page.getByText(`گوشی فرستنده: ${hostName}`).waitFor();
    sims.push(paired);
    return Object.assign(paired, { rings });
  };
  const confirm = async () => {
    await page.getByRole("button", { name: "بله، همین است" }).click();
    await page.getByRole("heading", { name: "متصل شد" }).waitFor();
    await page.getByRole("button", { name: "دیدن پیام‌ها" }).click();
  };
  /** What a Host does with one SMS: seal it once, leave it at every bridge. */
  const send = async (to: { publicKey: string; boxId: string }, body: string, code: string | null) => {
    const message: Message = { v: 2, id: randomKey(24), sim: "همراه اول", from: "+98200", body, code, at: Date.now() };
    const { enc, ct } = await seal(to.publicKey, message);
    for (const bridge of BRIDGES) {
      const res = await fetch(`${bridge}/v2/box/${to.boxId}`, { method: "POST", body: JSON.stringify({ v: 2, id: message.id, enc, ct }) });
      assert.equal(res.status, 200);
    }
  };

  // 3. Both sides arrive at the same picture.
  const mum = await pairWith("گوشی مامان");
  await shot("3-picture");
  await confirm();
  await page.getByRole("heading", { name: "هنوز پیامی نرسیده است" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "اتصال به فرستنده‌ی دیگر" }).count(), 0, "no pairing button under the messages");
  await page.getByText("هنوز خبری از این گوشی نرسیده است").waitFor();
  await shot("4-empty");

  // The Host starts reporting on itself: alive, battery, network.
  mum.start();
  await page.getByText(/زنده است · آخرین خبر/).waitFor();
  await page.getByText("باتری ۸۲٪ · در شارژ").waitFor();
  await page.getByText("وای‌فای").waitFor();
  await shot("4b-monitor");

  // Ask it to ring. The phone rings once and says so.
  await page.getByRole("button", { name: "زنگ بزن" }).click();
  await page.getByText("گوشی زنگ زد").waitFor();
  assert.deepEqual(mum.rings, ["buzz"]);
  // Whoever made it ring can stop it from here.
  await page.getByRole("button", { name: "خاموش کردن زنگ" }).click();
  await page.getByText("زنگ خاموش شد").waitFor();
  assert.deepEqual(mum.rings, ["buzz", "hush"]);

  // A dying battery, off the charger, is said in words.
  await mum.sendStatus({ battery: 12, charging: false });
  await page.getByText("باتری کم است و گوشی به شارژ وصل نیست.").waitFor();
  await shot("4c-low-battery");

  // A phone that stops reporting is called silent, not left looking alive.
  mum.stop();
  await page.getByText(/بی‌خبر است · آخرین خبر/).waitFor({ timeout: 40_000 });
  await page.getByRole("button", { name: "خبر تازه" }).click();
  await page.getByText("در حال رساندن به گوشی").waitFor();

  // 4. The Host leaves one message at both bridges. It is shown once.
  await mum.sendSms("رمز پویا: 48217365 مبلغ 250000 ریال", "48217365", "همراه اول");
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

  // Advertising is set aside by itself, and a code never is.
  await mum.sendSms("جشنواره‌ی زمستانه! ۵۰٪ تخفیف\nshop.example.ir/y\nلغو11", null, "همراه اول", "SHOP-X");
  await page.getByRole("tab", { name: "هرزنامه (۱)" }).waitFor();
  assert.equal(await page.getByText("جشنواره‌ی زمستانه").count(), 0, "the advertisement is not among the messages");
  await page.getByText("48217365", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "هرزنامه (۱)" }).click();
  await page.getByText("خودکار جدا شد: به نظر تبلیغاتی می‌رسد.").waitFor();
  assert.equal(await page.getByText("48217365", { exact: true }).count(), 0, "the code is not under spam");
  await shot("5b-spam");
  // "Not spam" brings it back, and says so.
  await page.getByRole("button", { name: "هرزنامه نیست" }).click();
  await page.getByText("پیام‌های «SHOP-X» دوباره در پیام‌ها می‌آید.").waitFor();
  await page.getByRole("tab", { name: "پیام‌ها" }).click();
  const ad = page.getByRole("listitem").filter({ hasText: "جشنواره‌ی زمستانه" });
  await ad.waitFor();
  // Marking it by hand moves everything from that sender; undo puts it back.
  await ad.getByRole("button", { name: "هرزنامه است" }).click();
  await page.getByText("از این پس پیام‌های «SHOP-X» در هرزنامه می‌آید.").waitFor();
  assert.equal(await ad.count(), 0);
  await shot("5c-marked-spam");
  await page.getByRole("button", { name: "برگرداندن" }).click();
  await ad.waitFor();
  await ad.getByRole("button", { name: "هرزنامه است" }).click();
  await page.getByRole("tab", { name: "هرزنامه (۱)" }).waitFor();
  // The next one from that sender goes straight there, advertisement or not.
  await mum.sendSms("سلام، سفارش شما آماده است", null, "همراه اول", "shop-x");
  await page.getByRole("tab", { name: "هرزنامه (۲)" }).waitFor();

  // 6. A second Host, with its own keys and its own box.
  await page.getByRole("button", { name: "فرستنده‌ها و تنظیمات" }).click();
  await page.getByRole("button", { name: "اتصال به فرستنده‌ی دیگر" }).click();
  const dad = await pairWith("گوشی بابا");
  await confirm();
  assert.notEqual(dad.receiver.boxId, mum.receiver.boxId, "each Host is given a different box");
  assert.notEqual(dad.receiver.publicKey, mum.receiver.publicKey, "and a different key");
  await dad.sendSms("کد تایید: 7731", "7731", "همراه اول");
  await page.getByText("7731", { exact: true }).waitFor();
  await page.getByText("۲ فرستنده").waitFor();
  // With two Hosts each card says whose it is, and the list can be narrowed to one.
  await page.getByRole("listitem").filter({ hasText: "7731" }).getByText("گوشی بابا").waitFor();
  await shot("6-two-hosts");
  await page.getByRole("button", { name: "گوشی مامان", exact: true }).click();
  assert.equal(await page.getByText("7731", { exact: true }).count(), 0, "the other Host's message is hidden");
  await page.getByText("48217365", { exact: true }).waitFor();
  await page.getByRole("button", { name: "همه", exact: true }).click();
  await page.getByText("7731", { exact: true }).waitFor();

  // 7. The gear opens the panel: Hosts, settings, help.
  await page.getByRole("button", { name: "فرستنده‌ها و تنظیمات" }).click();
  await page.getByRole("heading", { name: "فرستنده‌ها", exact: true }).waitFor();
  await page.getByRole("heading", { name: "راهنما" }).waitFor();
  await shot("7-panel");
  await page.getByText("آن تصویر برای چیست؟").click();
  await page.getByText("اگر دو تصویر فرق داشت، تأیید نکنید").waitFor();

  // Rename a Host.
  await page.getByRole("button", { name: "تغییر نام: گوشی بابا" }).click();
  await page.getByLabel("نام این فرستنده").fill("بابا");
  await page.getByRole("button", { name: "ذخیره" }).click();
  await page.getByRole("button", { name: "تغییر نام: بابا" }).waitFor();

  // Remove the other one. Its messages go with it, and it is asked first.
  await page.getByRole("button", { name: "حذف: گوشی مامان" }).click();
  await page.getByRole("heading", { name: "«گوشی مامان» حذف شود؟" }).waitFor();
  await shot("8-remove");
  await page.getByRole("button", { name: "بله، حذف شود" }).click();
  await page.getByText("۱ فرستنده").waitFor();
  assert.equal(await page.getByText("48217365", { exact: true }).count(), 0, "a removed Host's messages are gone");
  await page.getByText("7731", { exact: true }).waitFor();
  // What is sent to a removed Host's box is no longer collected.
  await mum.sendSms("کد: 9090", "9090", "همراه اول");
  await page.waitForTimeout(3000);
  assert.equal(await page.getByText("9090", { exact: true }).count(), 0, "nothing is collected for a removed Host");

  // 8. English, from the panel, left to right.
  await page.getByRole("button", { name: "فرستنده‌ها و تنظیمات" }).click();
  await page.getByRole("button", { name: "English", exact: true }).click();
  await page.getByRole("heading", { name: "Hosts and settings" }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dir), "ltr");
  await shot("9-panel-english");
  await page.getByRole("button", { name: "Close" }).click();
  await page.getByRole("heading", { name: "Messages" }).waitFor();

  // 9. A reload keeps the pairing, the name and the message: all on the device.
  await page.reload();
  await page.getByText("7731", { exact: true }).waitFor();
  await page.getByRole("heading", { name: "Messages" }).waitFor();
  await page.getByText("1 Host").waitFor();

  // 10. A device paired before Hosts had their own keys keeps working. This
  // is the state of every phone that installed the first version.
  const old = await newKeyPair();
  const oldBoxKey = randomKey();
  const oldIdentity = { ...old, boxKey: oldBoxKey, boxId: await boxIdFrom(oldBoxKey) };
  const legacy = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const legacyPage = await legacy.newPage();
  legacyPage.on("pageerror", (e) => errors.push(e.message));
  await legacyPage.goto(`${APP}/manifest.webmanifest`);
  await legacyPage.evaluate(
    ({ identity, message }) =>
      new Promise<void>((resolve, reject) => {
        const req = indexedDB.open("easyotp-receiver", 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore("kv");
          req.result.createObjectStore("messages", { keyPath: "id" }).createIndex("at", "at");
        };
        req.onsuccess = () => {
          const tx = req.result.transaction(["kv", "messages"], "readwrite");
          tx.objectStore("kv").put(identity, "identity");
          tx.objectStore("kv").put([{ label: "Fake Host", pairedAt: 1 }], "hosts");
          tx.objectStore("messages").put(message);
          tx.oncomplete = () => {
            req.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
    { identity: oldIdentity, message: { v: 2, id: "old-message-000000000001", sim: "Test SIM", from: "+98200", body: "رمز", code: null, at: Date.now() - 60_000 } },
  );
  await legacyPage.goto(`${APP}/?preview`);
  await legacyPage.getByText("۱ فرستنده").waitFor();
  await legacyPage.getByText("رمز", { exact: true }).waitFor();
  await send({ publicKey: old.publicKey, boxId: oldIdentity.boxId }, "کد ورود: 5544", "5544");
  await legacyPage.getByText("5544", { exact: true }).waitFor();
  await legacyPage.getByRole("button", { name: "فرستنده‌ها و تنظیمات" }).click();
  await legacyPage.getByRole("button", { name: "تغییر نام: Fake Host" }).waitFor();
  await legacyPage.screenshot({ path: `${SHOTS}/10-upgraded.png`, fullPage: true });

  sims.forEach((sim) => sim.stop());
  assert.deepEqual(errors, [], "no script errors on any screen");
  await browser.close();
  console.log(`e2e passed. Screenshots in ${SHOTS}/`);
}

// Nothing here should take a minute. A hang is a failure, not a wait.
setTimeout(() => {
  console.error("e2e timed out");
  children.forEach((c) => c.kill());
  process.exit(1);
}, 240_000).unref();

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => {
    children.forEach((c) => c.kill());
    process.exit(process.exitCode ?? 0);
  });
