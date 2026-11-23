/**
 * Bridge on Node: one process, one port, one directory. Everything else is
 * `core.ts`.
 *
 * Written for a host that gives it very little: an unprivileged user, a
 * read-only root, no outbound network, and a data directory it must keep small
 * itself. Sealed messages live in memory and are mirrored to one file per box,
 * so a restart or a deploy loses nothing that was waiting.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Box, type Sealed } from "./box";
import { handle, type BoxStore } from "./core";
import { KEY_SHAPE } from "./ids";
import { log } from "./log";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const POLL_HOLD_MS = Number(process.env.POLL_HOLD_SECONDS ?? 55) * 1000;
/** Everything on disk stays under this. Past it, deposits are refused. */
const MAX_TOTAL_BYTES = Number(process.env.MAX_TOTAL_BYTES ?? 128 * 1024 * 1024);
const SWEEP_MS = 10 * 60 * 1000;
/** Larger than any request the protocol allows; refused before it is read. */
const MAX_REQUEST_BYTES = 64 * 1024;

/**
 * What one box costs on disk beyond its contents: a file takes a whole block
 * however little is in it. Counting it is what stops a flood of tiny deposits
 * to made-up box ids from filling the disk while the byte total looks small.
 */
const BOX_OVERHEAD_BYTES = 4096;
/** Boxes with a collector waiting are the only ones kept in memory. */
const MAX_WAITING_BOXES = 2000;

export class FileStore implements BoxStore {
  /** Only boxes with a collector waiting. Everything else is read from its file when needed. */
  private waitingBoxes = new Map<string, Box>();
  /** Bytes on disk per box, so the total never has to be recounted from the directory. */
  private sizes = new Map<string, number>();
  private dir: string;
  private total = 0;

  constructor(dataDir: string, private maxTotalBytes: number) {
    this.dir = join(dataDir, "boxes");
    mkdirSync(this.dir, { recursive: true });
    this.sweep(Date.now());
  }

  private file(boxId: string): string {
    return join(this.dir, `${boxId}.json`);
  }

  private open(boxId: string): Box {
    const waiting = this.waitingBoxes.get(boxId);
    if (waiting) return waiting;
    let snapshot: Sealed[] = [];
    try {
      snapshot = JSON.parse(readFileSync(this.file(boxId), "utf8")) as Sealed[];
    } catch {
      // No file, or one cut short by a crash mid-write. Either way the box
      // starts empty: the same messages are on the other bridges.
    }
    return new Box(snapshot);
  }

  private account(boxId: string, bytes: number | null): void {
    const before = this.sizes.get(boxId);
    if (before !== undefined) this.total -= before + BOX_OVERHEAD_BYTES;
    if (bytes === null) {
      this.sizes.delete(boxId);
    } else {
      this.sizes.set(boxId, bytes);
      this.total += bytes + BOX_OVERHEAD_BYTES;
    }
  }

  private save(boxId: string, box: Box): void {
    const path = this.file(boxId);
    if (box.count === 0) {
      rmSync(path, { force: true });
      this.account(boxId, null);
      return;
    }
    // Write beside the target and rename, so a crash leaves either the old
    // file or the new one and never half of one.
    const json = JSON.stringify(box.snapshot());
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, json);
    renameSync(tmp, path);
    this.account(boxId, Buffer.byteLength(json));
  }

  async deposit(boxId: string, m: Sealed): Promise<"stored" | "duplicate" | "full"> {
    // The size as it will be written, which is a little more than its fields.
    const cost = Buffer.byteLength(JSON.stringify(m)) + 1 + (this.sizes.has(boxId) ? 0 : BOX_OVERHEAD_BYTES);
    if (this.total + cost > this.maxTotalBytes) return "full";
    const box = this.open(boxId);
    const outcome = box.add(m);
    if (outcome === "stored") this.save(boxId, box);
    return outcome;
  }

  async collect(boxId: string, holdMs: number): Promise<Sealed[]> {
    const box = this.open(boxId);
    const now = Date.now();
    if (box.expire(now)) this.save(boxId, box);
    if (box.count > 0 || holdMs <= 0) return box.collect(now, 0);

    // Anyone can make a box key, so anyone can ask to wait. Past the limit a
    // collect is answered at once and the Receiver simply asks again.
    if (!this.waitingBoxes.has(boxId) && this.waitingBoxes.size >= MAX_WAITING_BOXES) return [];
    this.waitingBoxes.set(boxId, box);
    try {
      return await box.collect(now, holdMs);
    } finally {
      if (box.waiting === 0) this.waitingBoxes.delete(boxId);
    }
  }

  async ack(boxId: string, ids: string[]): Promise<number> {
    const box = this.open(boxId);
    const removed = box.ack(ids);
    if (removed) this.save(boxId, box);
    return removed;
  }

  /**
   * Expires every box on disk and recounts the total from what is left. This
   * is what removes the messages of a Receiver that never comes back.
   */
  sweep(now: number): void {
    this.sizes.clear();
    this.total = 0;
    for (const name of readdirSync(this.dir)) {
      const boxId = name.replace(/\.json$/, "");
      const path = join(this.dir, name);
      if (!name.endsWith(".json") || !KEY_SHAPE.test(boxId)) {
        // A leftover .tmp from a crash, or something that is not ours.
        rmSync(path, { force: true });
        continue;
      }
      const box = this.open(boxId);
      if (box.expire(now)) {
        this.save(boxId, box);
      } else {
        this.account(boxId, statSync(path).size);
      }
    }
    log({ route: "store", outcome: "ok", reason: "sweep", n: this.sizes.size });
  }

  /** Bytes this store counts against its limit. */
  get bytes(): number {
    return this.total;
  }
}

/** Reads a request body, giving up as soon as it is larger than allowed. */
function readBody(req: IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function serve(store: BoxStore, pollHoldMs: number) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS";
      const body = hasBody ? await readBody(req) : undefined;
      if (body === null) {
        res.writeHead(413, { "content-type": "application/json", "cache-control": "no-store" });
        res.end('{"error":"too_large"}');
        return;
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const request = new Request(`http://bridge${req.url ?? "/"}`, { method: req.method, headers, body });
      const response = await handle(request, store, { pollHoldMs });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      // Never the error itself: a stack trace can carry a request.
      log({ route: "store", outcome: "rejected", reason: "internal", status: 500 });
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":"internal"}');
    }
  });
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  const store = new FileStore(DATA_DIR, MAX_TOTAL_BYTES);
  const server = serve(store, POLL_HOLD_MS);
  const sweeper = setInterval(() => store.sweep(Date.now()), SWEEP_MS);
  server.listen(PORT, HOST, () => console.log(JSON.stringify({ t: Date.now(), listening: `${HOST}:${PORT}` })));
  process.on("SIGTERM", () => {
    // Long polls are cut here. Receivers reconnect, and nothing collected is
    // lost because a message stays until it is acknowledged.
    clearInterval(sweeper);
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}
