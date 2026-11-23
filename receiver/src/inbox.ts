/**
 * Collecting from the bridges.
 *
 * The Host leaves every message at every bridge, so the same message arrives
 * here more than once. It is shown once, by its id, and acknowledged at each
 * bridge only after it is safely stored on this device: a Receiver that dies
 * between collecting and storing is given the message again.
 */
import { open, OpenError, type Message } from "./open";
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
}

export interface PassResult {
  /** Messages stored for the first time in this pass. */
  fresh: Message[];
  /** Sealed items that would not open. Counted, never shown. */
  unreadable: number;
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
): Promise<PassResult> {
  const url = `${bridge}/v2/box/${identity.boxId}`;
  const headers = { authorization: `Bearer ${identity.boxKey}` };
  const res = await fetchImpl(url, { headers, signal });
  if (!res.ok) throw new Error(`collect ${res.status}`);
  const { messages } = (await res.json()) as { messages: Array<{ id: string; enc: string; ct: string }> };

  const result: PassResult = { fresh: [], unreadable: 0 };
  for (const sealed of messages) {
    let message: Message;
    try {
      message = await open(identity.privateKey, sealed.id, sealed.enc, sealed.ct);
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
    // After the stores above, never before. A failed acknowledgement is not an
    // error: the bridge hands the same messages over again and they are
    // recognised by id.
    await fetchImpl(`${url}/ack`, {
      method: "POST",
      headers,
      body: JSON.stringify({ ids: messages.map((m) => m.id) }),
      signal,
    }).catch(() => undefined);
  }
  return result;
}

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
  const loop = async (bridge: string) => {
    let failures = 0;
    while (!abort.signal.aborted) {
      try {
        const { fresh } = await collectFrom(bridge, opts.identity, opts.store, opts.fetch ?? fetch, abort.signal);
        failures = 0;
        opts.onBridge?.(bridge, true);
        if (fresh.length) opts.onFresh(fresh);
      } catch {
        if (abort.signal.aborted) return;
        failures++;
        opts.onBridge?.(bridge, false);
        // 2 s, 4 s, 8 s … capped at a minute.
        await new Promise((r) => setTimeout(r, Math.min(60_000, 1000 * 2 ** Math.min(failures, 6))));
      }
    }
  };
  for (const bridge of opts.bridges) void loop(bridge);
  return () => abort.abort();
}
