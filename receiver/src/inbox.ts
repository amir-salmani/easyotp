/**
 * Collecting from the bridges.
 *
 * The Host leaves every message at every bridge, so the same message arrives
 * here more than once. It is shown once, by its id, and acknowledged at each
 * bridge only after it is safely stored on this device: a Receiver that dies
 * between collecting and storing is given the message again.
 */
import { openAny, OpenError, type Message, type Status } from "./open";
import type { Fetch } from "./pairing";

export interface Identity {
  privateKey: string;
  boxKey: string;
  boxId: string;
}

export interface InboxStore {
  /** Whether a message with this id was already stored. */
  has(id: string): Promise<boolean>;
  /** Stores a message. Must be durable before it resolves. */
  put(message: Message): Promise<void>;
  /** Takes a Host's report on itself. Only the newest matters; an older one is ignored. */
  status?(status: Status): Promise<void>;
}

export interface PassResult {
  /** Messages stored for the first time in this pass. */
  fresh: Message[];
  /** Sealed items that would not open. Counted, never shown. */
  unreadable: number;
  /** How many the bridge handed over, fresh or not. */
  received: number;
  /** Whether the bridge took the acknowledgement. False means it will hand the same ones over again. */
  acknowledged: boolean;
}

/**
 * One collect from one bridge: waits if the box is empty, stores what is new,
 * acknowledges everything it was handed. Throws if the bridge cannot be
 * reached, so the caller can back off.
 */
export async function collectFrom(
  bridge: string,
  identity: Identity,
  store: InboxStore,
  fetchImpl: Fetch = fetch,
  signal?: AbortSignal,
  timeoutMs = COLLECT_TIMEOUT_MS,
): Promise<PassResult> {
  const url = `${bridge}/v2/box/${identity.boxId}`;
  const headers = { authorization: `Bearer ${identity.boxKey}` };
  // A bridge that takes the request and never answers must not hold this
  // Receiver for ever: seen live, where one bridge stopped answering for a box
  // and the app went on waiting while looking connected.
  const limit = () => (signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs));
  const res = await fetchImpl(url, { headers, signal: limit() });
  if (!res.ok) throw new Error(`collect ${res.status}`);
  const { messages } = (await res.json()) as { messages: Array<{ id: string; enc: string; ct: string }> };

  const result: PassResult = { fresh: [], unreadable: 0, received: messages.length, acknowledged: true };
  for (const sealed of messages) {
    let message: Message;
    try {
      const payload = await openAny(identity.privateKey, sealed.id, sealed.enc, sealed.ct);
      if ("k" in payload) {
        // A report is taken, never listed. A command has no business in a
        // Receiver's box and is dropped.
        if (payload.k === "status") await store.status?.(payload);
        continue;
      }
      message = payload;
    } catch (e) {
      // Not sealed to this Receiver, changed on the way, or relabelled. It is
      // acknowledged below so it does not come back for ever.
      if (!(e instanceof OpenError)) throw e;
      result.unreadable++;
      continue;
    }
    if (!(await store.has(message.id))) {
      await store.put(message);
      result.fresh.push(message);
    }
  }

  if (messages.length) {
    // After the stores above, never before. A failed acknowledgement loses
    // nothing: the bridge hands the same messages over again and they are
    // recognised by id. The caller is told, so it can slow down.
    result.acknowledged = await fetchImpl(`${url}/ack`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ids: messages.map((m) => m.id) }),
      signal: limit(),
    }).then((r) => r.ok, () => false);
  }
  return result;
}

const MIN_PASS_MS = 1000;
/** Longer than any bridge's hold (55 s), so only a bridge that has stopped answering reaches it. */
const COLLECT_TIMEOUT_MS = 75_000;

/**
 * Keeps collecting from every bridge until stopped. Each bridge has its own
 * loop, so a bridge that is down only slows itself.
 */
export function watch(opts: {
  bridges: readonly string[];
  identity: Identity;
  store: InboxStore;
  onFresh: (messages: Message[]) => void;
  /** Called when a bridge starts or stops answering, for the status line. */
  onBridge?: (bridge: string, up: boolean) => void;
  fetch?: Fetch;
}): () => void {
  const abort = new AbortController();
  const fetchImpl = opts.fetch ?? fetch;
  const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  // 2 s, 4 s, 8 s … capped at a minute.
  const backoff = (failures: number) => pause(Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)));
  const loop = async (bridge: string) => {
    let failures = 0;
    while (!abort.signal.aborted) {
      const asked = Date.now();
      try {
        const pass = await collectFrom(bridge, opts.identity, opts.store, fetchImpl, abort.signal);
        opts.onBridge?.(bridge, true);
        if (pass.fresh.length) opts.onFresh(pass.fresh);
        if (!pass.acknowledged) {
          // The bridge will hand the same messages straight back. Without a
          // pause this would spin, against a bridge that is already failing.
          await backoff(++failures);
          continue;
        }
        failures = 0;
        // An empty answer normally takes the bridge's whole hold. One that
        // comes back at once must not be asked for again at once.
        const took = Date.now() - asked;
        if (!pass.received && took < MIN_PASS_MS) await pause(MIN_PASS_MS - took);
      } catch {
        if (abort.signal.aborted) return;
        opts.onBridge?.(bridge, false);
        await backoff(++failures);
      }
    }
  };
  for (const bridge of opts.bridges) void loop(bridge);
  return () => abort.abort();
}
