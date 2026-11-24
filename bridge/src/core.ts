/**
 * The bridge, as a function from a request to a response.
 *
 * A bridge is a relay with no key. It holds sealed messages until the Receiver
 * they are for collects them, and cannot read one (DECISIONS D16). This file is
 * the whole protocol and knows nothing about where it runs: `worker.ts` gives
 * it a Durable Object to store in, `node.ts` a directory.
 *
 *   POST /v2/box/<boxId>        deposit one sealed message      (the Host)
 *   GET  /v2/box/<boxId>        collect, waiting if empty       (the Receiver)
 *   POST /v2/box/<boxId>/ack    acknowledge collected messages  (the Receiver)
 *   POST /v2/box/<boxId>/push   leave an address to be woken at (the Receiver)
 *   DELETE /v2/box/<boxId>/push take it back                    (the Receiver)
 *   POST /v2/pair/<slotId>      add a pairing message           (either side)
 *   GET  /v2/pair/<slotId>      read pairing messages, waiting  (either side)
 *   GET  /health
 */
import { LIMITS, type Sealed } from "./box";
import { boxIdFrom, KEY_SHAPE, timingSafeEqual } from "./ids";
import { boxTag, log } from "./log";
import { endpointOk } from "./push";
import { SLOT_LIMITS, type SlotView } from "./slot";

export interface BoxStore {
  /** @param notify whether a closed Receiver should be told; false for a report or an advertisement. */
  deposit(boxId: string, m: Sealed, notify: boolean): Promise<"stored" | "duplicate" | "full" | "limited">;
  collect(boxId: string, holdMs: number): Promise<Sealed[]>;
  ack(boxId: string, ids: string[]): Promise<number>;
}

export interface PairStore {
  post(slotId: string, from: "host" | "receiver", data: string): Promise<number | "full">;
  read(slotId: string, after: number, holdMs: number): Promise<SlotView>;
}

/** Where a Receiver's push address is kept. A bridge that cannot push has none of this. */
export interface PushStore {
  set(boxId: string, endpoint: string | null): Promise<void>;
}

export interface Store extends BoxStore {
  pair: PairStore;
  /** Absent on a bridge that never calls out (bridge 1; see BRIDGES). */
  push?: PushStore;
}

export interface Config {
  /** How long a collect waits on an empty box before answering. */
  pollHoldMs: number;
}

const MESSAGE_ID = /^[A-Za-z0-9_-]{16,64}$/;
const TAG = /^[a-z]{1,16}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
/** JSON framing on top of the largest message. */
const MAX_BODY_BYTES = LIMITS.maxMessageBytes + 1024;
const MAX_ACK_IDS = 200;

/**
 * The Receiver is a web app on another origin, so every answer says any origin
 * may read it. That is safe because nothing here is authorised by a cookie: a
 * page can only use a box key it already holds.
 */
const HEADERS = {
  "content-type": "application/json",
  "cache-control": "no-store",
  "access-control-allow-origin": "*",
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

const reject = (route: "deposit" | "collect" | "ack" | "pair" | "push", reason: string, status: number, boxId?: string) => {
  log({ route, outcome: "rejected", reason, status, box: boxId && boxTag(boxId) });
  return json({ error: reason }, status);
};

/** Reads a JSON body, refusing one that is too large before parsing it. */
async function readJson(req: Request): Promise<unknown | "too_large" | "malformed"> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return "too_large";
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) return "too_large";
  try {
    return JSON.parse(text);
  } catch {
    return "malformed";
  }
}

/** Only the holder of the box key may read or acknowledge. */
async function authorised(req: Request, boxId: string): Promise<boolean> {
  const presented = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!KEY_SHAPE.test(presented)) return false;
  return timingSafeEqual(await boxIdFrom(presented), boxId);
}

async function deposit(req: Request, store: BoxStore, boxId: string): Promise<Response> {
  const body = await readJson(req);
  if (body === "too_large") return reject("deposit", "too_large", 413, boxId);
  if (body === "malformed" || typeof body !== "object" || body === null) {
    return reject("deposit", "malformed", 400, boxId);
  }
  const { v, id, enc, ct, tag, quiet } = body as Record<string, unknown>;
  if (v !== 2) return reject("deposit", "unsupported_version", 400, boxId);
  if (
    typeof id !== "string" || !MESSAGE_ID.test(id) ||
    typeof enc !== "string" || !KEY_SHAPE.test(enc) ||
    typeof ct !== "string" || !B64URL.test(ct) ||
    (tag !== undefined && (typeof tag !== "string" || !TAG.test(tag))) ||
    (quiet !== undefined && typeof quiet !== "boolean")
  ) {
    return reject("deposit", "malformed", 400, boxId);
  }
  if (id.length + enc.length + ct.length > LIMITS.maxMessageBytes) {
    return reject("deposit", "too_large", 413, boxId);
  }

  // A tagged message is a report that replaces the last one, and a Host marks
  // what reads as advertising as quiet. Neither is worth waking anyone for.
  const notify = tag === undefined && quiet !== true;
  const outcome = await store.deposit(boxId, { id, enc, ct, at: Date.now(), ...(tag ? { tag } : {}) }, notify);
  if (outcome === "limited") {
    // Too many deposits to this box this minute. A 429 is the bridge's
    // answer, not the message's: a Host counts it against this bridge and
    // tries again later, as it would after a 5xx.
    log({ route: "deposit", outcome: "rejected", reason: "rate_limited", status: 429, box: boxTag(boxId) });
    return json({ error: "rate_limited" }, 429);
  }
  if (outcome === "full") {
    // The bridge is out of room, which is the bridge's fault and not the
    // message's. 507 tells the Host to count it against this bridge.
    log({ route: "deposit", outcome: "full", status: 507, box: boxTag(boxId) });
    return json({ error: "bridge_full" }, 507);
  }
  log({ route: "deposit", outcome: "ok", box: boxTag(boxId), reason: outcome });
  return json({ ok: true, duplicate: outcome === "duplicate" });
}

async function collect(req: Request, store: BoxStore, cfg: Config, boxId: string): Promise<Response> {
  if (!(await authorised(req, boxId))) return reject("collect", "bad_credential", 403, boxId);
  const messages = await store.collect(boxId, cfg.pollHoldMs);
  log({ route: "collect", outcome: messages.length ? "ok" : "timeout", box: boxTag(boxId), n: messages.length });
  return json({ messages });
}

async function ack(req: Request, store: BoxStore, boxId: string): Promise<Response> {
  if (!(await authorised(req, boxId))) return reject("ack", "bad_credential", 403, boxId);
  const body = await readJson(req);
  if (body === "too_large") return reject("ack", "too_large", 413, boxId);
  const ids = body !== "malformed" && typeof body === "object" && body !== null ? (body as { ids?: unknown }).ids : null;
  if (!Array.isArray(ids) || ids.length > MAX_ACK_IDS || !ids.every((x) => typeof x === "string" && MESSAGE_ID.test(x))) {
    return reject("ack", "malformed", 400, boxId);
  }
  const removed = await store.ack(boxId, ids as string[]);
  log({ route: "ack", outcome: "ok", box: boxTag(boxId), n: removed });
  return json({ ok: true, removed });
}

/** A Receiver leaves, or takes back, the address its browser can be woken at. */
async function push(req: Request, store: Store, boxId: string): Promise<Response> {
  if (!(await authorised(req, boxId))) return reject("push", "bad_credential", 403, boxId);
  if (!store.push) return reject("push", "push_unsupported", 404, boxId);
  if (req.method === "DELETE") {
    await store.push.set(boxId, null);
    log({ route: "push", outcome: "ok", box: boxTag(boxId), reason: "removed" });
    return json({ ok: true });
  }
  const body = await readJson(req);
  if (body === "too_large") return reject("push", "too_large", 413, boxId);
  const endpoint = body !== "malformed" && typeof body === "object" && body !== null ? (body as { endpoint?: unknown }).endpoint : null;
  if (!endpointOk(endpoint)) return reject("push", "malformed", 400, boxId);
  await store.push.set(boxId, endpoint);
  log({ route: "push", outcome: "ok", box: boxTag(boxId), reason: "set" });
  return json({ ok: true });
}

/**
 * Pairing messages. No key: the slot id comes from a code read aloud, and
 * nothing here is trusted until two people have compared a picture.
 */
async function pairPost(req: Request, store: PairStore, slotId: string): Promise<Response> {
  const body = await readJson(req);
  if (body === "too_large") return reject("pair", "too_large", 413);
  if (body === "malformed" || typeof body !== "object" || body === null) return reject("pair", "malformed", 400);
  const { v, from, data } = body as Record<string, unknown>;
  if (v !== 2) return reject("pair", "unsupported_version", 400);
  if ((from !== "host" && from !== "receiver") || typeof data !== "string" || !B64URL.test(data)) {
    return reject("pair", "malformed", 400);
  }
  if (data.length > SLOT_LIMITS.maxDataBytes) return reject("pair", "too_large", 413);
  const seq = await store.post(slotId, from, data);
  if (seq === "full") {
    log({ route: "pair", outcome: "full", status: 409 });
    return json({ error: "slot_full" }, 409);
  }
  log({ route: "pair", outcome: "ok", n: seq });
  return json({ ok: true, seq });
}

async function pairRead(req: Request, store: PairStore, cfg: Config, slotId: string): Promise<Response> {
  const after = Number(new URL(req.url).searchParams.get("after") ?? 0);
  if (!Number.isInteger(after) || after < 0 || after > SLOT_LIMITS.maxMessages) return reject("pair", "malformed", 400);
  // The epoch tells a reader when the slot it was following has been replaced,
  // so it starts again from the first message instead of waiting for one that
  // will never be numbered high enough.
  return json(await store.read(slotId, after, cfg.pollHoldMs));
}

export async function handle(req: Request, store: Store, cfg: Config): Promise<Response> {
  const path = new URL(req.url).pathname;

  // Asked by every Host about every bridge. Must depend on nothing.
  if (path === "/health") return json({ ok: true });

  const pair = path.match(/^\/v2\/pair\/([A-Za-z0-9_-]{43})$/);
  const box = path.match(/^\/v2\/box\/([A-Za-z0-9_-]{43})(\/ack|\/push)?$/);
  if (!box && !pair) return json({ error: "not_found" }, 404);

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        ...HEADERS,
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        "access-control-allow-headers": "authorization, content-type",
        "access-control-max-age": "86400",
      },
    });
  }
  if (pair) {
    if (req.method === "POST") return pairPost(req, store.pair, pair[1]!);
    if (req.method === "GET") return pairRead(req, store.pair, cfg, pair[1]!);
    return json({ error: "method_not_allowed" }, 405);
  }
  const boxId = box![1]!;
  const isAck = box![2] === "/ack";
  if (box![2] === "/push") {
    if (req.method === "POST" || req.method === "DELETE") return push(req, store, boxId);
    return json({ error: "method_not_allowed" }, 405);
  }

  if (req.method === "POST" && isAck) return ack(req, store, boxId);
  if (req.method === "POST") return deposit(req, store, boxId);
  if (req.method === "GET" && !isAck) return collect(req, store, cfg, boxId);
  return json({ error: "method_not_allowed" }, 405);
}
