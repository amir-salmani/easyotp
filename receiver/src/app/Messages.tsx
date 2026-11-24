import { Check, Copy, ShieldBan, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import type { PairedHost, StoredMessage } from "./db";
import { when, type Lang, type Strings } from "./i18n";
import { Monitor } from "./Monitor";
import { sort, withRule, type Sorted, type SpamSettings } from "../spam";
import { Card, Screen } from "./ui";

function MessageCard(props: {
  m: StoredMessage;
  hostName: string | null;
  t: Strings;
  lang: Lang;
  now: number;
  sorted: Sorted;
  /** Moves this message's sender to the other list. */
  onMove: () => void;
}) {
  const { m, t, lang } = props;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(m.code!);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <Card className="flex flex-col gap-3">
      {props.hostName && (
        <p dir="auto" className="font-semibold">
          {props.hostName}
        </p>
      )}
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-muted-foreground">
        <span>
          {t.from}{" "}
          {/* A sender is a number or a Latin name. The isolate marks keep "+98…" from being flipped. */}
          <span className="font-semibold text-foreground">{`\u2066${m.from}\u2069`}</span> · {m.sim}
        </span>
        <time>{when(m.at, props.now, lang)}</time>
      </div>
      {m.code && (
        <div className="flex items-center justify-between gap-3 rounded-lg bg-muted p-3">
          {/* The code is what gets typed into a form, so it is shown as it will be typed. */}
          <span dir="ltr" className="min-w-0 font-mono text-3xl font-bold tracking-wider">
            {m.code}
          </span>
          <button
            onClick={() => void copy()}
            className="inline-flex min-h-12 shrink-0 items-center gap-2 whitespace-nowrap rounded-lg bg-primary px-4 font-semibold text-primary-foreground"
          >
            {copied ? <Check aria-hidden size={20} strokeWidth={2} /> : <Copy aria-hidden size={20} strokeWidth={2} />}
            <span aria-live="polite">{copied ? t.copied : t.copy}</span>
          </button>
        </div>
      )}
      {/* An SMS can be in either direction; the browser decides from its first strong letter. */}
      <p dir="auto" className="whitespace-pre-wrap break-words">
        {m.body}
      </p>
      {props.sorted !== "inbox" && <p className="text-muted-foreground">{props.sorted === "spam-guess" ? t.spamGuess : t.spamSender}</p>}
      <button
        onClick={props.onMove}
        className="inline-flex min-h-12 items-center gap-2 self-start rounded-lg px-2 font-medium text-muted-foreground"
      >
        {props.sorted === "inbox" ? <ShieldBan aria-hidden size={20} strokeWidth={2} /> : <ShieldCheck aria-hidden size={20} strokeWidth={2} />}
        {props.sorted === "inbox" ? t.markSpam : t.notSpam}
      </button>
    </Card>
  );
}

export function Messages(props: {
  t: Strings;
  lang: Lang;
  header: React.ReactNode;
  messages: StoredMessage[];
  hosts: PairedHost[];
  bridges: { up: number; all: number };
  spam: SpamSettings;
  onSpam: (next: SpamSettings) => void;
}) {
  const { t, lang, hosts } = props;
  const [view, setView] = useState<"inbox" | "spam">("inbox");
  /** What was just moved, with the settings from before it, so it can be undone. */
  const [moved, setMoved] = useState<{ text: string; before: SpamSettings } | null>(null);
  const [now, setNow] = useState(Date.now());
  /** Which Host to show. Null is all of them. */
  const [only, setOnly] = useState<string | null>(null);

  useEffect(() => {
    // Often enough that "alive" turns to "silent" within seconds of being true.
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  // A Host that was just removed cannot stay selected.
  const selected = only && hosts.some((h) => h.id === only) ? only : null;
  const ofHost = selected ? props.messages.filter((m) => m.host === selected) : props.messages;
  const sorted = new Map(ofHost.map((m) => [m.id, sort(m, props.spam)]));
  const spamCount = ofHost.filter((m) => sorted.get(m.id) !== "inbox").length;
  const shown = ofHost.filter((m) => (sorted.get(m.id) !== "inbox") === (view === "spam"));

  const move = (m: StoredMessage) => {
    const toSpam = sorted.get(m.id) === "inbox";
    setMoved({ text: toSpam ? t.spamMoved(m.from) : t.spamRestored(m.from), before: props.spam });
    props.onSpam(withRule(props.spam, m.from, toSpam ? "spam" : "ok"));
  };

  const tab = (id: "inbox" | "spam", label: string) => (
    <button
      role="tab"
      aria-selected={view === id}
      onClick={() => {
        setView(id);
        setMoved(null);
      }}
      className={`min-h-12 flex-1 rounded-lg font-semibold ${view === id ? "bg-card shadow-sm" : "text-muted-foreground"}`}
    >
      {label}
    </button>
  );
  const names = new Map(hosts.map((h) => [h.id, h.name]));
  const down = props.bridges.up === 0;

  const chip = (id: string | null, label: string) => (
    <button
      key={id ?? "all"}
      aria-pressed={selected === id}
      onClick={() => setOnly(id)}
      dir="auto"
      className={`min-h-12 max-w-48 shrink-0 truncate rounded-full border px-4 font-semibold ${selected === id ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card"}`}
    >
      {label}
    </button>
  );

  return (
    <Screen>
      {props.header}
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">{t.messagesTitle}</h1>
        <span className="text-muted-foreground">{t.hosts(hosts.length)}</span>
      </div>

      <p role="status" className={`flex items-center gap-2 font-medium ${down ? "text-destructive" : "text-success"}`}>
        {down ? <WifiOff aria-hidden size={20} strokeWidth={2} /> : <Wifi aria-hidden size={20} strokeWidth={2} />}
        {down ? t.bridgesDown : t.bridgesUp(props.bridges.up, props.bridges.all)}
      </p>

      <Monitor hosts={selected ? hosts.filter((h) => h.id === selected) : hosts} t={t} lang={lang} now={now} />

      {hosts.length > 1 && (
        <div role="group" aria-label={t.hostsTitle} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {chip(null, t.allHosts)}
          {hosts.map((h) => chip(h.id, h.name))}
        </div>
      )}

      {/* The second list appears once there is something in it, and stays while it is open. */}
      {(spamCount > 0 || view === "spam") && (
        <div role="tablist" className="flex gap-1 rounded-xl bg-muted p-1">
          {tab("inbox", t.tabInbox)}
          {tab("spam", t.tabSpam(spamCount))}
        </div>
      )}

      {moved && (
        <p role="status" className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card p-3 font-medium">
          <span dir="auto">{moved.text}</span>
          <button
            onClick={() => {
              props.onSpam(moved.before);
              setMoved(null);
            }}
            className="min-h-12 shrink-0 rounded-lg px-3 font-semibold underline"
          >
            {t.undo}
          </button>
        </p>
      )}

      {view === "spam" && shown.length > 0 && <p className="text-muted-foreground">{t.spamHint}</p>}

      {shown.length === 0 ? (
        <Card>
          <h2 className="text-lg font-semibold">{view === "spam" ? t.spamEmpty : t.empty}</h2>
          {view === "inbox" && <p className="text-muted-foreground">{t.emptyBody}</p>}
        </Card>
      ) : (
        <ul className="flex flex-col gap-4">
          {shown.map((m) => (
            <li key={m.id}>
              <MessageCard
                m={m}
                hostName={hosts.length > 1 && !selected ? (names.get(m.host) ?? null) : null}
                t={t}
                lang={lang}
                now={now}
                sorted={sorted.get(m.id) ?? "inbox"}
                onMove={() => move(m)}
              />
            </li>
          ))}
        </ul>
      )}
    </Screen>
  );
}
