// The bridge as it runs on Arsalan: the built bundle, a real port, a real
// directory. Run with `npm run test:node`, which builds dist/node.mjs first.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const b64url = (b) => b.toString("base64url");
const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = mkdtempSync(join(tmpdir(), "easyotp-bridge-"));

function newBox() {
  const key = randomBytes(32);
  const boxId = b64url(createHash("sha256").update(Buffer.concat([key, Buffer.from("easyotp/box-id/v2")])).digest());
  return { boxKey: b64url(key), url: `${BASE}/v2/box/${boxId}` };
}
const sealed = () => ({ v: 2, id: b64url(randomBytes(16)), enc: b64url(randomBytes(32)), ct: b64url(randomBytes(200)) });
const post = (url, body, headers = {}) => fetch(url, { method: "POST", headers, body: JSON.stringify(body) });

async function start(env = {}) {
  const child = spawn(process.execPath, ["dist/node.mjs"], {
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(PORT), DATA_DIR: dataDir, POLL_HOLD_SECONDS: "1", ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return child;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error("bridge did not start");
}
const stop = (child) => new Promise((resolve) => { child.once("exit", resolve); child.kill("SIGTERM"); });

test("holds a sealed message across a restart, then gives it up on ack", async () => {
  const { boxKey, url } = newBox();
  const m = sealed();
  let child = await start();
  assert.equal((await post(url, m)).status, 200);
  assert.equal(await stop(child), 0, "exits cleanly on SIGTERM");

  child = await start();
  try {
    const auth = { authorization: `Bearer ${boxKey}` };
    const got = await (await fetch(url, { headers: auth })).json();
    assert.equal(got.messages.length, 1);
    assert.equal(got.messages[0].ct, m.ct);

    assert.equal((await (await post(`${url}/ack`, { ids: [m.id] }, auth)).json()).removed, 1);
    assert.deepEqual(readdirSync(join(dataDir, "boxes")), [], "an empty box leaves no file");
    assert.equal((await fetch(url)).status, 403);
  } finally {
    await stop(child);
  }
});

test("refuses deposits once it holds as much as it is allowed", async () => {
  // Room for one box (a file costs a whole block) and one message in it.
  const child = await start({ MAX_TOTAL_BYTES: String(4096 + 700) });
  try {
    const { url } = newBox();
    assert.equal((await post(url, sealed())).status, 200);
    assert.equal((await post(url, sealed())).status, 507, "the same box is full");
    assert.equal((await post(newBox().url, sealed())).status, 507, "and there is no room for another box");
  } finally {
    await stop(child);
  }
});

test("a flood of tiny deposits to made-up boxes is stopped by what it costs on disk", async () => {
  // Each box is a file, and a file takes a block however small it is. Counting
  // only the message bytes would let thousands of these through.
  const child = await start({ MAX_TOTAL_BYTES: String(10 * 4096) });
  try {
    const tiny = () => ({ v: 2, id: b64url(randomBytes(12)), enc: b64url(randomBytes(32)), ct: "AA" });
    const statuses = [];
    for (let i = 0; i < 20; i++) statuses.push((await post(newBox().url, tiny())).status);
    assert.ok(statuses.filter((s) => s === 200).length <= 10, "at most ten boxes fit");
    assert.equal(statuses.at(-1), 507);
    assert.ok(readdirSync(join(dataDir, "boxes")).length <= 11);
  } finally {
    await stop(child);
  }
});

test("refuses an oversized request before reading it all", async () => {
  const child = await start();
  try {
    const { url } = newBox();
    const res = await fetch(url, { method: "POST", body: "x".repeat(200 * 1024) }).catch(() => ({ status: 413 }));
    assert.equal(res.status, 413);
  } finally {
    await stop(child);
  }
});

test("carries pairing messages between two sides", async () => {
  const child = await start();
  try {
    const url = `${BASE}/v2/pair/${b64url(randomBytes(32))}`;
    assert.deepEqual(await (await fetch(`${url}?after=0`)).json(), { epoch: 0, messages: [] }, "a read makes no slot");
    assert.equal((await (await post(url, { v: 2, from: "host", data: "Y29tbWl0" })).json()).seq, 1);
    const waiting = fetch(`${url}?after=1`).then((r) => r.json());
    assert.equal((await (await post(url, { v: 2, from: "receiver", data: "b2ZmZXI" })).json()).seq, 2);
    const got = await waiting;
    assert.deepEqual(got.messages, [{ seq: 2, from: "receiver", data: "b2ZmZXI" }]);
    assert.ok(got.epoch > 0);
  } finally {
    await stop(child);
  }
});

test("takes no push address, and so never calls out", async () => {
  // This bridge runs where it is told to reach nothing (docs/BRIDGES.md). A
  // Receiver that offers an address is told plainly, and uses the other bridge.
  const { boxKey, url } = newBox();
  const child = await start();
  try {
    const res = await post(`${url}/push`, { endpoint: "https://web.push.apple.com/abc" }, { authorization: `Bearer ${boxKey}` });
    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), { error: "push_unsupported" });
    // A deposit marked quiet is still an ordinary deposit here.
    assert.equal((await post(url, { ...sealed(), quiet: true })).status, 200);
  } finally {
    await stop(child);
  }
});

test("refuses a flood of deposits to one box, and not to another", async () => {
  const child = await start();
  try {
    const { url } = newBox();
    const answers = [];
    for (let i = 0; i < 32; i++) answers.push((await post(url, sealed())).status);
    assert.ok(answers.slice(0, 30).every((s) => s === 200));
    assert.deepEqual(answers.slice(30), [429, 429]);
    assert.equal((await post(newBox().url, sealed())).status, 200);
  } finally {
    await stop(child);
  }
});

