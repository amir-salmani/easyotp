import { Check, Copy, Plus, Wifi, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import type { PairedHost, StoredMessage } from "./db";
import { when, type Lang, type Strings } from "./i18n";
import { Button, Card, Screen } from "./ui";

function MessageCard(props: { m: StoredMessage; hostName: string | null; t: Strings; lang: Lang; now: number }) {
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
  onPairAnother: () => void;
}) {
  const { t, lang, hosts } = props;
  const [now, setNow] = useState(Date.now());
  /** Which Host to show. Null is all of them. */
  const [only, setOnly] = useState<string | null>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  // A Host that was just removed cannot stay selected.
  const selected = only && hosts.some((h) => h.id === only) ? only : null;
  const shown = selected ? props.messages.filter((m) => m.host === selected) : props.messages;
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

      {hosts.length > 1 && (
        <div role="group" aria-label={t.hostsTitle} className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {chip(null, t.allHosts)}
          {hosts.map((h) => chip(h.id, h.name))}
        </div>
      )}

      {shown.length === 0 ? (
        <Card>
          <h2 className="text-lg font-semibold">{t.empty}</h2>
          <p className="text-muted-foreground">{t.emptyBody}</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-4">
          {shown.map((m) => (
            <li key={m.id}>
              <MessageCard m={m} hostName={hosts.length > 1 && !selected ? (names.get(m.host) ?? null) : null} t={t} lang={lang} now={now} />
            </li>
          ))}
        </ul>
      )}

      <Button variant="secondary" onClick={props.onPairAnother} className="mt-auto">
        <Plus aria-hidden size={20} strokeWidth={2} />
        {t.pairAnother}
      </Button>
    </Screen>
  );
}
