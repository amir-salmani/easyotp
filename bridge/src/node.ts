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
import { Box, LIMITS, sizeOf, type Sealed } from "./box";
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

export class FileStore implements BoxStore {
  private boxes = new Map<string, Box>();
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
    let box = this.boxes.get(boxId);
    if (!box) {
      let snapshot: Sealed[] = [];
      try {
        snapshot = JSON.parse(readFileSync(this.file(boxId), "utf8")) as Sealed[];
      } catch {
        // No file, or one cut short by a crash mid-write. Either way the box
        // starts empty: the same messages are on the other bridges.
      }
      box = new Box(snapshot);
      this.boxes.set(boxId, box);
    }
    return box;
  }

  private save(boxId: string, box: Box): void {
    const path = this.file(boxId);
    if (box.count === 0) {
      rmSync(path, { force: true });
      if (box.waiting === 0) this.boxes.delete(boxId);
      return;
    }
    // Write beside the target and rename, so a crash leaves either the old
    // file or the new one and never half of one.
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(box.snapshot()));
    renameSync(tmp, path);
  }

  async deposit(boxId: string, m: Sealed): Promise<"stored" | "duplicate" | "full"> {
    if (this.total + sizeOf(m) > this.maxTotalBytes) return "full";
    const box = this.open(boxId);
    const before = box.bytes;
    const outcome = box.add(m);
    if (outcome === "stored") {
      this.total += box.bytes - before;
      this.save(boxId, box);
    }
    return outcome;
  }

  async collect(boxId: string, holdMs: number): Promise<Sealed[]> {
    const box = this.open(boxId);
    const now = Date.now();
    const before = box.bytes;
    if (box.expire(now)) {
      this.total += box.bytes - before;
      this.save(boxId, box);
    }
    const messages = await box.collect(now, holdMs);
    if (box.count === 0 && box.waiting === 0) this.boxes.delete(boxId);
    return messages;
  }

  async ack(boxId: string, ids: string[]): Promise<number> {
    const box = this.open(boxId);
    const before = box.bytes;
    const removed = box.ack(ids);
    if (removed) this.total += box.bytes - before;
    this.save(boxId, box);
    return removed;
  }

  /**
   * Expires every box on disk and recounts the total from what is left. This
   * is what removes the messages of a Receiver that never comes back, and what
   * keeps the running total honest.
   */
  sweep(now: number): void {
    let total = 0;
    for (const name of readdirSync(this.dir)) {
      const boxId = name.replace(/\.json$/, "");
      if (!name.endsWith(".json") || !KEY_SHAPE.test(boxId)) {
        // A leftover .tmp from a crash, or something that is not ours.
        rmSync(join(this.dir, name), { force: true });
        continue;
      }
      const box = this.open(boxId);
      if (box.expire(now)) this.save(boxId, box);
      total += box.bytes;
      if (box.waiting === 0) this.boxes.delete(boxId);
    }
    this.total = total;
    log({ route: "store", outcome: "ok", reason: "sweep", n: total });
  }

  /** Bytes of sealed messages held. For tests and the sweep log. */
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
