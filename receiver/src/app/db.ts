/**
 * What the Receiver keeps, all of it on this device, in IndexedDB.
 *
 * Every paired Host has its own keys and its own box. That is what lets this
 * device listen to several Hosts and say which one a message came from, and
 * what makes removing a Host final: its keys are deleted, and nothing sent to
 * its box can be opened again.
 *
 * Nothing here can be exported. Losing this storage means pairing again.
 */
import { boxIdFrom, randomKey } from "../ids";
import type { Identity } from "../inbox";
import { newKeyPair, type Message } from "../open";
import type { Lang } from "./i18n";

/** Keys for one pairing. Made when a pairing starts, kept only if it is confirmed. */
export interface HostKeys extends Identity {
  publicKey: string;
}

export interface PairedHost extends HostKeys {
  id: string;
  /** What this device's owner calls it. Starts as what the Host called itself. */
  name: string;
  pairedAt: number;
}

/** A message, and which Host it came from. */
export type StoredMessage = Message & { host: string };

const DB_NAME = "easyotp-receiver";
const KV = "kv";
const MESSAGES = "messages";
const HOSTS = "hosts";

/**
 * Version 1 had one identity shared by every Host, and a list of names. This
 * turns each name into a Host holding that identity, so a device paired under
 * version 1 keeps receiving without pairing again.
 */
function upgradeFrom1(tx: IDBTransaction): void {
  const kv = tx.objectStore(KV);
  const hosts = tx.objectStore(HOSTS);
  const identity = kv.get("identity");
  const names = kv.get("hosts");
  tx.addEventListener("complete", () => undefined);
  identity.onsuccess = () => {
    names.onsuccess = () => {
      const keys = identity.result as HostKeys | undefined;
      const old = (names.result as Array<{ label: string; pairedAt: number }> | undefined) ?? [];
      if (!keys || old.length === 0) return;
      // They all shared one box, so they become one Host: nothing could tell
      // their messages apart then, and nothing can now.
      const first = old[0]!;
      const id = randomKey(12);
      hosts.put({ ...keys, id, name: old.map((h) => h.label).filter(Boolean).join(" · ") || "Host", pairedAt: first.pairedAt } satisfies PairedHost);
      kv.delete("identity");
      kv.delete("hosts");
      const cursor = tx.objectStore(MESSAGES).openCursor();
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) return;
        at.update({ ...(at.value as Message), host: id });
        at.continue();
      };
    };
  };
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (event.oldVersion < 1) {
        db.createObjectStore(KV);
        db.createObjectStore(MESSAGES, { keyPath: "id" }).createIndex("at", "at");
      }
      if (event.oldVersion < 2) {
        db.createObjectStore(HOSTS, { keyPath: "id" });
        if (event.oldVersion === 1) upgradeFrom1(req.transaction!);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Resolves when the transaction commits: only then is a write durable. */
function run<T>(db: IDBDatabase, stores: string | string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const req = work(tx);
    tx.oncomplete = () => resolve((req ? req.result : undefined) as T);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** New keys and a new box, for one pairing. */
export async function newHostKeys(): Promise<HostKeys> {
  const keys = await newKeyPair();
  const boxKey = randomKey();
  return { ...keys, boxKey, boxId: await boxIdFrom(boxKey) };
}

export class Db {
  private constructor(private db: IDBDatabase) {}

  static async open(): Promise<Db> {
    return new Db(await openDb());
  }

  lang = () => run<Lang | undefined>(this.db, KV, "readonly", (tx) => tx.objectStore(KV).get("lang"));
  setLang = (lang: Lang) => run(this.db, KV, "readwrite", (tx) => tx.objectStore(KV).put(lang, "lang"));

  /** Oldest pairing first. */
  async hosts(): Promise<PairedHost[]> {
    const all = await run<PairedHost[]>(this.db, HOSTS, "readonly", (tx) => tx.objectStore(HOSTS).getAll());
    return all.sort((a, b) => a.pairedAt - b.pairedAt);
  }

  putHost = (host: PairedHost) => run(this.db, HOSTS, "readwrite", (tx) => tx.objectStore(HOSTS).put(host));

  /** Removes a Host, its keys and every message from it, together or not at all. */
  removeHost(id: string): Promise<void> {
    return run(this.db, [HOSTS, MESSAGES], "readwrite", (tx) => {
      tx.objectStore(HOSTS).delete(id);
      const cursor = tx.objectStore(MESSAGES).openCursor();
      cursor.onsuccess = () => {
        const at = cursor.result;
        if (!at) return;
        if ((at.value as StoredMessage).host === id) at.delete();
        at.continue();
      };
    });
  }

  deleteMessages = () => run(this.db, MESSAGES, "readwrite", (tx) => tx.objectStore(MESSAGES).clear());

  /** The store one Host's collector writes to. */
  inboxFor(host: string) {
    return {
      has: async (id: string) => (await run<number>(this.db, MESSAGES, "readonly", (tx) => tx.objectStore(MESSAGES).count(id))) > 0,
      put: async (message: Message) => void (await run(this.db, MESSAGES, "readwrite", (tx) => tx.objectStore(MESSAGES).put({ ...message, host }))),
    };
  }

  /** Newest first. */
  async messages(limit = 300): Promise<StoredMessage[]> {
    return new Promise((resolve, reject) => {
      const out: StoredMessage[] = [];
      const req = this.db.transaction(MESSAGES, "readonly").objectStore(MESSAGES).index("at").openCursor(null, "prev");
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor || out.length >= limit) return resolve(out);
        out.push(cursor.value as StoredMessage);
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });
  }
}
