/**
 * Bridge on Cloudflare Workers. One Durable Object per box holds its sealed
 * messages; everything else is `core.ts`.
 */
import { DurableObject } from "cloudflare:workers";
import { Box, LIMITS, type Sealed } from "./box";
import { handle, type Store } from "./core";
import { Slot, type SlotMessage } from "./slot";

export interface Env {
  BOX: DurableObjectNamespace<BoxObject>;
  PAIR: DurableObjectNamespace<PairObject>;
  POLL_HOLD_SECONDS: string;
}

const STORAGE_KEY = "messages";

export class BoxObject extends DurableObject<Env> {
  private box: Box | undefined;

  private async load(): Promise<Box> {
    if (!this.box) this.box = new Box((await this.ctx.storage.get<Sealed[]>(STORAGE_KEY)) ?? []);
    return this.box;
  }

  private async save(box: Box): Promise<void> {
    if (box.count === 0) {
      // An empty box leaves nothing behind, so an abandoned one costs nothing.
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.ctx.storage.put(STORAGE_KEY, box.snapshot());
    // Nobody may ever collect from this box again. The alarm is what removes
    // its messages when they expire with no request to trigger it.
    await this.ctx.storage.setAlarm(Date.now() + LIMITS.retentionMs);
  }

  async deposit(m: Sealed): Promise<"stored" | "duplicate"> {
    const box = await this.load();
    const outcome = box.add(m);
    if (outcome === "stored") await this.save(box);
    return outcome;
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
    box.expire(Date.now());
    await this.save(box);
  }
}

/**
 * One pairing slot. Memory only, on purpose: a slot lives ten minutes, and if
 * this object is evicted mid-pairing the two people simply start again.
 */
export class PairObject extends DurableObject<Env> {
  private slot: Slot | undefined;

  private open(): Slot {
    const now = Date.now();
    if (!this.slot || this.slot.expired(now)) this.slot = new Slot(now);
    return this.slot;
  }

  async post(from: "host" | "receiver", data: string): Promise<number | "full"> {
    return this.open().post(from, data);
  }

  async read(after: number, holdMs: number): Promise<SlotMessage[]> {
    return this.open().read(after, holdMs);
  }
}

function storeFor(env: Env): Store {
  const stub = (boxId: string) => env.BOX.get(env.BOX.idFromName(boxId));
  const pairStub = (slotId: string) => env.PAIR.get(env.PAIR.idFromName(slotId));
  return {
    deposit: (boxId, m) => stub(boxId).deposit(m),
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
