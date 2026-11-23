/**
 * A bridge in memory, built from the bridge's own code, so these tests run the
 * Receiver against the real protocol and not against a description of it.
 */
import { Box, type Sealed } from "../../bridge/src/box";
import { handle, type Store } from "../../bridge/src/core";
import { Slots } from "../../bridge/src/slot";

export interface LocalBridge {
  url: string;
  /** Requests seen, as "METHOD path". */
  log: string[];
  down: boolean;
}

export function localBridges(names: string[], holdMs = 50) {
  const bridges = new Map<string, LocalBridge & { store: Store }>();
  for (const name of names) {
    const boxes = new Map<string, Box>();
    const slots = new Slots(100);
    const box = (id: string) => boxes.get(id) ?? boxes.set(id, new Box()).get(id)!;
    const store: Store = {
      deposit: async (id, m: Sealed) => box(id).add(m),
      collect: (id, hold) => box(id).collect(Date.now(), hold),
      ack: async (id, ids) => box(id).ack(ids),
      pair: {
        post: async (slotId, from, data) => slots.post(slotId, from, data, Date.now()),
        read: (slotId, after, hold) => slots.read(slotId, after, hold, Date.now()),
      },
    };
    bridges.set(`https://${name}.test`, { url: `https://${name}.test`, log: [], down: false, store });
  }

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const bridge = bridges.get(url.origin);
    if (!bridge || bridge.down) throw new TypeError("network error");
    bridge.log.push(`${req.method} ${url.pathname}`);
    return handle(req, bridge.store, { pollHoldMs: holdMs });
  }) as typeof fetch;

  return { urls: [...bridges.keys()], bridges: [...bridges.values()] as LocalBridge[], fetch: fetchImpl };
}
