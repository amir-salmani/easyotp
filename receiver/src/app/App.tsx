import { Languages } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SEED_BRIDGES } from "../bridges";
import { watch } from "../inbox";
import type { Message } from "../open";
import { Db, type StoredIdentity } from "./db";
import { STRINGS, type Lang } from "./i18n";
import { Install, isInstalled } from "./Install";
import { Messages } from "./Messages";
import { Pair } from "./Pair";
import { Alert, Screen } from "./ui";

interface Ready {
  db: Db;
  identity: StoredIdentity;
}

/** A development build may be opened in a tab with ?preview. A released one never. */
const gateOpen = () => isInstalled() || (import.meta.env.DEV && new URLSearchParams(location.search).has("preview"));

export function App() {
  const [lang, setLang] = useState<Lang>("fa");
  const [ready, setReady] = useState<Ready | null>(null);
  const [failed, setFailed] = useState(false);
  const [hosts, setHosts] = useState(0);
  const [messages, setMessages] = useState<Message[]>([]);
  const [pairing, setPairing] = useState(false);
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
      const db = await Db.open();
      setLang((await db.lang()) ?? "fa");
      setHosts((await db.hosts()).length);
      setMessages(await db.messages());
      setReady({ db, identity: await db.identity() });
    })().catch(() => setFailed(true));
  }, []);

  // Collecting starts with the first pairing and never stops while the app is open.
  useEffect(() => {
    if (!ready || hosts === 0) return;
    return watch({
      bridges: SEED_BRIDGES,
      identity: ready.identity,
      store: ready.db,
      onBridge: (bridge, isUp) => setUp((prev) => (prev[bridge] === isUp ? prev : { ...prev, [bridge]: isUp })),
      onFresh: (fresh) => {
        void ready.db.messages().then(setMessages);
        if (document.hidden && typeof Notification !== "undefined" && Notification.permission === "granted") {
          const strings = STRINGS[langRef.current];
          // Never the text of the SMS: a notification shows on a locked screen.
          void navigator.serviceWorker?.ready.then((reg) =>
            reg.showNotification(strings.notifyTitle(fresh[0]!.sim), { tag: "easyotp", icon: "/icons/icon-192.png" }),
          );
        }
      },
    });
  }, [ready, hosts]);

  const header = useMemo(
    () => (
      <header className="flex items-center justify-between">
        <span className="text-lg font-bold" dir="ltr">
          EasyOTP
        </span>
        <button
          onClick={() => {
            const next: Lang = lang === "fa" ? "en" : "fa";
            setLang(next);
            void ready?.db.setLang(next);
          }}
          className="inline-flex min-h-12 items-center gap-2 rounded-lg px-3 font-semibold"
          lang={lang === "fa" ? "en" : "fa"}
        >
          <Languages aria-hidden size={20} strokeWidth={2} />
          {t.language}
        </button>
      </header>
    ),
    [lang, ready, t],
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
  if (!ready) {
    return (
      <Screen>
        {header}
        <p role="status" className="text-muted-foreground">
          {t.loading}
        </p>
      </Screen>
    );
  }

  if (hosts === 0 || pairing) {
    return (
      <Pair
        t={t}
        lang={lang}
        identity={ready.identity}
        header={header}
        canCancel={hosts > 0}
        onPaired={async (label) => {
          await ready.db.addHost({ label, pairedAt: Date.now() });
          setHosts((n) => n + 1);
          setPairing(true);
        }}
        onClose={() => setPairing(false)}
      />
    );
  }

  return (
    <Messages
      t={t}
      lang={lang}
      header={header}
      messages={messages}
      hosts={hosts}
      bridges={{ up: SEED_BRIDGES.filter((b) => up[b] !== false).length, all: SEED_BRIDGES.length }}
      onPairAnother={() => setPairing(true)}
    />
  );
}
