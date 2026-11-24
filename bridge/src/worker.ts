/**
 * Bridge on Cloudflare Workers. One Durable Object per box holds its sealed
 * messages; everything else is `core.ts`.
 */
import { DurableObject } from "cloudflare:workers";
import { Box, LIMITS, Pace, type Sealed } from "./box";
import { handle, type Store } from "./core";
import { log } from "./log";
import { PUSH_ADDRESS_TTL_MS, tickle, type PushAddress, type Vapid } from "./push";
import { readNothing, Slot, type SlotView } from "./slot";

export interface Env {
  BOX: DurableObjectNamespace<BoxObject>;
  PAIR: DurableObjectNamespace<PairObject>;
  POLL_HOLD_SECONDS: string;
  /** The bridge's push signing key (DECISIONS D30). Without all three, nothing is pushed. */
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_JWK?: string;
  VAPID_SUBJECT?: string;
}

const STORAGE_KEY = "messages";
const PUSH_KEY = "push";
/** Several SMS in a burst, or the parts of a long one, are one thing to be told about. */
const PUSH_GAP_MS = 3000;

function vapidOf(env: Env): Vapid | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_JWK || !env.VAPID_SUBJECT) return null;
  try {
    return { publicKey: env.VAPID_PUBLIC_KEY, privateJwk: JSON.parse(env.VAPID_PRIVATE_JWK) as JsonWebKey, subject: env.VAPID_SUBJECT };
  } catch {
    return null;
  }
}

export class BoxObject extends DurableObject<Env> {
  private box: Box | undefined;

  private async load(): Promise<Box> {
    if (!this.box) this.box = new Box((await this.ctx.storage.get<Sealed[]>(STORAGE_KEY)) ?? []);
    return this.box;
  }

  private lastPushAt = 0;

  private async save(box: Box): Promise<void> {
    if (box.count === 0) {
      // An empty box leaves nothing behind, so an abandoned one costs nothing.
      // Its key is removed by name. If a push address is kept, the alarm is
      // what forgets it once its Receiver has stopped renewing it.
      await this.ctx.storage.delete(STORAGE_KEY);
      const address = await this.ctx.storage.get<PushAddress>(PUSH_KEY);
      if (address) await this.ctx.storage.setAlarm(address.at + PUSH_ADDRESS_TTL_MS);
      else await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.put(STORAGE_KEY, box.snapshot());
    // Nobody may ever collect from this box again. The alarm is what removes
    // its messages when they expire with no request to trigger it.
    await this.ctx.storage.setAlarm(Date.now() + LIMITS.retentionMs);
  }

  /** One box per object, so the pace is this box's alone. */
  private pace = new Pace();

  async deposit(m: Sealed, notify: boolean): Promise<"stored" | "duplicate" | "limited"> {
    if (!this.pace.allow("box", m.at)) return "limited";
    const box = await this.load();
    const outcome = box.add(m);
    if (outcome === "stored") {
      await this.save(box);
      if (notify) this.ctx.waitUntil(this.wake(m.at));
    }
    return outcome;
  }

  /** Tells a closed Receiver something is waiting. Never fails the deposit it follows. */
  private async wake(now: number): Promise<void> {
    const vapid = vapidOf(this.env);
    if (!vapid || now - this.lastPushAt < PUSH_GAP_MS) return;
    const address = await this.ctx.storage.get<PushAddress>(PUSH_KEY);
    if (!address) return;
    if (now - address.at > PUSH_ADDRESS_TTL_MS) {
      await this.ctx.storage.delete(PUSH_KEY);
      return;
    }
    this.lastPushAt = now;
    const outcome = await tickle(vapid, address.endpoint, now);
    if (outcome === "gone") {
      // Only the address that was pushed to. The Receiver may have left a new
      // one while this push was on its way, and that one is good.
      const still = await this.ctx.storage.get<PushAddress>(PUSH_KEY);
      if (still?.endpoint === address.endpoint) await this.ctx.storage.delete(PUSH_KEY);
    }
    log({ route: "push", outcome: outcome === "sent" ? "ok" : "rejected", reason: outcome });
  }

  async setPush(endpoint: string | null): Promise<void> {
    if (endpoint === null) await this.ctx.storage.delete(PUSH_KEY);
    else await this.ctx.storage.put(PUSH_KEY, { endpoint, at: Date.now() } satisfies PushAddress);
    // The alarm follows whichever is kept: messages, the address, or nothing.
    await this.save(await this.load());
  }

  async collect(holdMs: number): Promise<Sealed[]> {
    const box = await this.load();
    const now = Date.now();
    if (box.expire(now)) await this.save(box);
    return box.collect(now, holdMs);
  }

  async ack(ids: string[]): Promise<number> {
    const box = await this.load();
    const removed = box.ack(ids);
    if (removed) await this.save(box);
    return removed;
  }

  override async alarm(): Promise<void> {
    const box = await this.load();
    const now = Date.now();
    box.expire(now);
    const address = await this.ctx.storage.get<PushAddress>(PUSH_KEY);
    if (address && now - address.at >= PUSH_ADDRESS_TTL_MS) await this.ctx.storage.delete(PUSH_KEY);
    await this.save(box);
  }
}

/**
 * One pairing slot. Memory only, on purpose: a slot lives ten minutes, and if
 * this object is evicted mid-pairing the two people simply start again.
 */
export class PairObject extends DurableObject<Env> {
  private slot: Slot | undefined;

  private live(): Slot | undefined {
    if (this.slot?.expired(Date.now())) this.slot = undefined;
    return this.slot;
  }

  async post(from: "host" | "receiver", data: string): Promise<number | "full"> {
    this.slot = this.live() ?? new Slot(Date.now());
    return this.slot.post(from, data);
  }

  /**
   * A read needs no key, so anyone can ask about any id, and a held request is
   * billed time here. A slot nobody has posted to is answered after a short
   * wait and leaves nothing behind.
   */
  async read(after: number, holdMs: number): Promise<SlotView> {
    const slot = this.live();
    if (!slot) return readNothing(holdMs);
    return { epoch: slot.createdAt, messages: await slot.read(after, holdMs) };
  }
}

function storeFor(env: Env): Store {
  const stub = (boxId: string) => env.BOX.get(env.BOX.idFromName(boxId));
  const pairStub = (slotId: string) => env.PAIR.get(env.PAIR.idFromName(slotId));
  return {
    deposit: (boxId, m, notify) => stub(boxId).deposit(m, notify),
    push: { set: (boxId, endpoint) => stub(boxId).setPush(endpoint) },
    collect: (boxId, holdMs) => stub(boxId).collect(holdMs),
    ack: (boxId, ids) => stub(boxId).ack(ids),
    pair: {
      post: (slotId, from, data) => pairStub(slotId).post(from, data),
      read: (slotId, after, holdMs) => pairStub(slotId).read(after, holdMs),
    },
  };
}

export default {
  fetch: (req: Request, env: Env) => handle(req, storeFor(env), { pollHoldMs: Number(env.POLL_HOLD_SECONDS) * 1000 }),
} satisfies ExportedHandler<Env>;
