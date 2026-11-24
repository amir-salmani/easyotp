import { Languages, Settings } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SEED_BRIDGES } from "../bridges";
import { randomKey } from "../ids";
import { watch } from "../inbox";
import { Db, type PairedHost, type StoredMessage } from "./db";
import { STRINGS, type Lang } from "./i18n";
import { Install, isInstalled } from "./Install";
import { Messages } from "./Messages";
import { Pair } from "./Pair";
import { Panel } from "./Panel";
import { shell } from "./shell";
import { Alert, Screen } from "./ui";

/** A development build may be opened in a tab with ?preview. A released one never. */
const gateOpen = () => isInstalled() || (import.meta.env.DEV && new URLSearchParams(location.search).has("preview"));

export function App() {
  const [lang, setLang] = useState<Lang>("fa");
  const [db, setDb] = useState<Db | null>(null);
  const [failed, setFailed] = useState(false);
  const [hosts, setHosts] = useState<PairedHost[]>([]);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [pairing, setPairing] = useState(false);
  const [panel, setPanel] = useState(false);
  /** "<host id> <bridge>" to whether that bridge last answered for that Host. */
  const [up, setUp] = useState<Record<string, boolean>>({});
  const langRef = useRef(lang);
  langRef.current = lang;
  const t = STRINGS[lang];

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "fa" ? "rtl" : "ltr";
  }, [lang]);

  useEffect(() => {
    if (!gateOpen()) return;
    (async () => {
      const opened = await Db.open();
      setLang((await opened.lang()) ?? "fa");
      setHosts(await opened.hosts());
      setMessages(await opened.messages());
      setDb(opened);
    })().catch(() => setFailed(true));
  }, []);

  // One collector per Host, each on its own box. Restarted only when the set
  // of boxes changes, so renaming a Host does not interrupt anything.
  const boxes = hosts.map((h) => h.boxId).join(" ");
  useEffect(() => {
    if (!db || hosts.length === 0) return;
    const stops = hosts.map((host) =>
      watch({
        bridges: SEED_BRIDGES,
        identity: host,
        store: {
          ...db.inboxFor(host.id),
          status: async (status) => {
            if (await db.putStatus(host.id, status)) setHosts(await db.hosts());
          },
        },
        onBridge: (bridge, isUp) =>
          setUp((prev) => (prev[`${host.id} ${bridge}`] === isUp ? prev : { ...prev, [`${host.id} ${bridge}`]: isUp })),
        onFresh: (fresh) => {
          void db.messages().then(setMessages);
          if (!document.hidden) return;
          // Never the text of the SMS: a notification shows on a locked screen.
          const title = STRINGS[langRef.current].notifyTitle(fresh[0]!.sim);
          if (shell) {
            shell.notify(title);
          } else if (typeof Notification !== "undefined" && Notification.permission === "granted") {
            void navigator.serviceWorker?.ready.then((reg) => reg.showNotification(title, { tag: "easyotp", icon: "/icons/icon-192.png" }));
          }
        },
      }),
    );
    return () => stops.forEach((stop) => stop());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [db, boxes]);

  const changeLang = (next: Lang) => {
    setLang(next);
    void db?.setLang(next);
  };

  const header = useMemo(
    () => (
      <header className="flex items-center justify-between">
        <span className="text-lg font-bold" dir="ltr">
          EasyOTP
        </span>
        {db && hosts.length > 0 && !pairing ? (
          <button onClick={() => setPanel(true)} aria-label={t.menu} className="inline-flex size-12 items-center justify-center rounded-lg">
            <Settings aria-hidden size={26} strokeWidth={2} />
          </button>
        ) : (
          // Before the first pairing there is nothing to manage, so the one
          // thing a person may need here is the other language.
          <button
            onClick={() => changeLang(lang === "fa" ? "en" : "fa")}
            className="inline-flex min-h-12 items-center gap-2 rounded-lg px-3 font-semibold"
            lang={lang === "fa" ? "en" : "fa"}
          >
            <Languages aria-hidden size={20} strokeWidth={2} />
            {t.language}
          </button>
        )}
      </header>
    ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang, db, hosts.length, pairing, t],
  );

  if (!gateOpen()) return <Install t={t} header={header} />;
  if (failed) {
    return (
      <Screen>
        {header}
        <Alert>{t.errStorage}</Alert>
      </Screen>
    );
  }
  if (!db) {
    return (
      <Screen>
        {header}
        <p role="status" className="text-muted-foreground">
          {t.loading}
        </p>
      </Screen>
    );
  }

  if (hosts.length === 0 || pairing) {
    return (
      <Pair
        t={t}
        lang={lang}
        header={header}
        canCancel={hosts.length > 0}
        onPaired={async (keys, label, remote) => {
          await db.putHost({ ...keys, id: randomKey(12), name: label || t.hostsTitle, pairedAt: Date.now(), ...(remote ? { remote } : {}) });
          setHosts(await db.hosts());
          setPairing(true);
        }}
        onClose={() => setPairing(false)}
      />
    );
  }

  const counts: Record<string, number> = {};
  for (const m of messages) counts[m.host] = (counts[m.host] ?? 0) + 1;
  // A bridge counts as reachable unless it last failed for every Host.
  const reachable = SEED_BRIDGES.filter((b) => hosts.some((h) => up[`${h.id} ${b}`] !== false)).length;

  return (
    <>
      <Messages
        t={t}
        lang={lang}
        header={header}
        messages={messages}
        hosts={hosts}
        bridges={{ up: reachable, all: SEED_BRIDGES.length }}
      />
      {panel && (
        <Panel
          t={t}
          lang={lang}
          hosts={hosts}
          counts={counts}
          onClose={() => setPanel(false)}
          onLang={changeLang}
          onRename={async (host, name) => {
            await db.putHost({ ...host, name });
            setHosts(await db.hosts());
          }}
          onRemove={async (host) => {
            await db.removeHost(host.id);
            setHosts(await db.hosts());
            setMessages(await db.messages());
            setPanel(false);
          }}
          onPairAnother={() => {
            setPanel(false);
            setPairing(true);
          }}
          onDeleteMessages={async () => {
            await db.deleteMessages();
            setMessages([]);
          }}
        />
      )}
    </>
  );
}
