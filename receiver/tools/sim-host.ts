/**
 * A Host, without a phone. It does everything the Host app does on the wire:
 * pairs, hands over a command channel, seals SMS, reports on itself, and obeys
 * commands. The stand-in Host, the live check and the browser test all use it,
 * so they exercise one implementation of the Host's side.
 */
import { boxIdFrom, randomKey } from "../src/ids";
import { newKeyPair, openAny, seal, type Message, type Status } from "../src/open";
import { pairAsHost, type Fetch, type ReceiverOffer } from "../src/pairing";
import type { Picture } from "../src/pictures";

export interface SimHost {
  picture: Picture;
  peerLabel: string;
  receiver: ReceiverOffer;
  /** Seals a line as an SMS and leaves it at every bridge. Resolves with each bridge's answer. */
  sendSms(body: string, code: string | null, sim?: string, from?: string): Promise<string[]>;
  /** Reports on itself now. */
  sendStatus(over?: Partial<Status>): Promise<void>;
  /** Starts reporting every `every` seconds and obeying commands. */
  start(): void;
  stop(): void;
}

export async function simHost(opts: {
  bridges: readonly string[];
  code: string;
  label: string;
  fetch?: Fetch;
  timeoutMs?: number;
  /** Seconds between reports. */
  every?: number;
  /** What this Host says about itself. Changed by a test to play a dying battery. */
  state?: Pick<Status, "battery" | "charging" | "net" | "pending">;
  onCommand?: (cmd: "buzz" | "ping" | "hush") => void;
}): Promise<SimHost> {
  const f: Fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const every = opts.every ?? 30;
  const state = opts.state ?? { battery: 82, charging: true, net: "wifi", pending: 0 };

  // A key and a box made for this one Receiver's commands.
  const keys = await newKeyPair();
  const boxKey = randomKey();
  const boxId = await boxIdFrom(boxKey);

  const paired = await pairAsHost({
    bridges: opts.bridges, code: opts.code, label: opts.label, fetch: f, timeoutMs: opts.timeoutMs,
    commands: { publicKey: keys.publicKey, boxId },
  });

  const deposit = async (payload: Message | Status, tag?: string) => {
    const { enc, ct } = await seal(paired.receiver.publicKey, payload);
    const body = JSON.stringify({ v: 2, id: payload.id, enc, ct, ...(tag ? { tag } : {}) });
    return Promise.all(
      opts.bridges.map((b) =>
        f(`${b}/v2/box/${paired.receiver.boxId}`, { method: "POST", body }).then(
          (r) => `${new URL(b).host} ${r.status}`,
          () => `${new URL(b).host} unreachable`,
        ),
      ),
    );
  };

  const sendStatus = async (over: Partial<Status> = {}) => {
    await deposit({ v: 2, k: "status", id: randomKey(24), at: Date.now(), every, ...state, ...over }, "status");
  };

  let stopped = true;
  let timer: ReturnType<typeof setInterval> | undefined;
  const abort = new AbortController();

  /** Collects commands from one bridge, for ever. A command seen at two bridges is obeyed once. */
  const done = new Set<string>();
  const obey = async (bridge: string) => {
    const url = `${bridge}/v2/box/${boxId}`;
    const headers = { authorization: `Bearer ${boxKey}` };
    while (!stopped) {
      try {
        const res = await f(url, { headers, signal: abort.signal });
        if (!res.ok) throw new Error();
        const { messages } = (await res.json()) as { messages: Array<{ id: string; enc: string; ct: string }> };
        for (const m of messages) {
          const payload = await openAny(keys.privateKey, m.id, m.enc, m.ct).catch(() => null);
          if (!payload || !("k" in payload) || payload.k !== "cmd" || done.has(payload.id)) continue;
          done.add(payload.id);
          opts.onCommand?.(payload.cmd);
          await sendStatus({ ack: payload.id });
        }
        if (messages.length) await f(`${url}/ack`, { method: "POST", headers, body: JSON.stringify({ ids: messages.map((m) => m.id) }) });
        else await new Promise((r) => setTimeout(r, 300));
      } catch {
        if (!stopped) await new Promise((r) => setTimeout(r, 1500));
      }
    }
  };

  return {
    picture: paired.picture,
    peerLabel: paired.peerLabel,
    receiver: paired.receiver,
    sendSms: (body, code, sim = `${opts.label} SIM`, from = "+98200") =>
      deposit({ v: 2, id: randomKey(24), sim, from, body, code, at: Date.now() }),
    sendStatus,
    start() {
      if (!stopped) return;
      stopped = false;
      void sendStatus();
      timer = setInterval(() => void sendStatus(), every * 1000);
      for (const bridge of opts.bridges) void obey(bridge);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      abort.abort();
    },
  };
}
