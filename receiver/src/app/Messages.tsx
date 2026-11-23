import { Bell, Check, Copy, Plus, Wifi, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import type { Message } from "../open";
import { when, type Lang, type Strings } from "./i18n";
import { Button, Card, Screen } from "./ui";

function MessageCard({ m, t, lang, now }: { m: Message; t: Strings; lang: Lang; now: number }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(m.code!);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-muted-foreground">
        <span>
          {t.from}{" "}
          {/* A sender is a number or a Latin name. The isolate marks keep "+98…" from being flipped. */}
          <span className="font-semibold text-foreground">{`\u2066${m.from}\u2069`}</span>{" "}
          · {m.sim}
        </span>
        <time dateTime={new Date(m.at).toISOString()}>{when(m.at, now, lang)}</time>
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
  messages: Message[];
  bridges: { up: number; all: number };
  hosts: number;
  onPairAnother: () => void;
}) {
  const { t, lang } = props;
  const [now, setNow] = useState(Date.now());
  const [canAskNotify, setCanAskNotify] = useState(typeof Notification !== "undefined" && Notification.permission === "default");

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const down = props.bridges.up === 0;
  return (
    <Screen>
      {props.header}
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-bold">{t.messagesTitle}</h1>
        <span className="text-muted-foreground">{t.hosts(props.hosts)}</span>
      </div>

      <p role="status" className={`flex items-center gap-2 font-medium ${down ? "text-destructive" : "text-success"}`}>
        {down ? <WifiOff aria-hidden size={20} strokeWidth={2} /> : <Wifi aria-hidden size={20} strokeWidth={2} />}
        {down ? t.bridgesDown : t.bridgesUp(props.bridges.up, props.bridges.all)}
      </p>

      {canAskNotify && (
        <Card className="flex flex-col gap-2">
          <Button variant="secondary" onClick={async () => setCanAskNotify((await Notification.requestPermission()) === "default")}>
            <Bell aria-hidden size={20} strokeWidth={2} />
            {t.notifyOn}
          </Button>
          <p className="text-muted-foreground">{t.notifyHint}</p>
        </Card>
      )}

      {props.messages.length === 0 ? (
        <Card>
          <h2 className="text-lg font-semibold">{t.empty}</h2>
          <p className="text-muted-foreground">{t.emptyBody}</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-4">
          {props.messages.map((m) => (
            <li key={m.id}>
              <MessageCard m={m} t={t} lang={lang} now={now} />
            </li>
          ))}
        </ul>
      )}

      <Button variant="secondary" onClick={props.onPairAnother} className="mt-auto">
        <Plus aria-hidden size={20} strokeWidth={2} />
        {t.pairAnother}
      </Button>
      <p dir="ltr" className="text-center font-mono text-sm text-muted-foreground">
        {__APP_VERSION__}
      </p>
    </Screen>
  );
}
