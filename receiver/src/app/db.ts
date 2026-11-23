/**
 * What the Receiver keeps, all of it on this device, in IndexedDB.
 *
 * The private key and the box key are stored here and nowhere else. Losing
 * this storage means pairing again; there is deliberately no way to export it.
 */
import { boxIdFrom, randomKey } from "../ids";
import type { Identity, InboxStore } from "../inbox";
import { newKeyPair, type Message } from "../open";
import type { Lang } from "./i18n";

export interface StoredIdentity extends Identity {
  publicKey: string;
}

export interface PairedHost {
  /** What the Host called itself at pairing. */
  label: string;
  pairedAt: number;
}

const DB_NAME = "easyotp-receiver";
const KV = "kv";
const MESSAGES = "messages";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(KV);
      req.result.createObjectStore(MESSAGES, { keyPath: "id" }).createIndex("at", "at");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = work(tx.objectStore(store));
    // Resolved when the transaction commits, not when the request succeeds:
    // only then is the write durable, and the inbox acknowledges on that.
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export class Db implements InboxStore {
  private constructor(private db: IDBDatabase) {}

  static async open(): Promise<Db> {
    return new Db(await openDb());
  }

  private get<T>(key: string) {
    return run<T | undefined>(this.db, KV, "readonly", (s) => s.get(key));
  }

  private set(key: string, value: unknown) {
    return run(this.db, KV, "readwrite", (s) => s.put(value, key));
  }

  /** This Receiver's keys, made on first use. */
  async identity(): Promise<StoredIdentity> {
    const stored = await this.get<StoredIdentity>("identity");
    if (stored) return stored;
    const keys = await newKeyPair();
    const boxKey = randomKey();
    const identity = { ...keys, boxKey, boxId: await boxIdFrom(boxKey) };
    await this.set("identity", identity);
    return identity;
  }

  lang = () => this.get<Lang>("lang");
  setLang = (lang: Lang) => this.set("lang", lang);

  hosts = async () => (await this.get<PairedHost[]>("hosts")) ?? [];

  /** Adds a Host and returns the whole list. Read and write in one transaction, so two taps cannot both win. */
  addHost(host: PairedHost): Promise<PairedHost[]> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(KV, "readwrite");
      const store = tx.objectStore(KV);
      let next: PairedHost[] = [];
      const read = store.get("hosts");
      read.onsuccess = () => {
        next = [...((read.result as PairedHost[] | undefined) ?? []), host];
        store.put(next, "hosts");
      };
      tx.oncomplete = () => resolve(next);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  has = async (id: string) => (await run<number>(this.db, MESSAGES, "readonly", (s) => s.count(id))) > 0;
  put = async (message: Message) => void (await run(this.db, MESSAGES, "readwrite", (s) => s.put(message)));

  /** Newest first. */
  async messages(limit = 200): Promise<Message[]> {
    return new Promise((resolve, reject) => {
      const out: Message[] = [];
      const req = this.db.transaction(MESSAGES, "readonly").objectStore(MESSAGES).index("at").openCursor(null, "prev");
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || out.length >= limit) return resolve(out);
        out.push(cursor.value as Message);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }
}
