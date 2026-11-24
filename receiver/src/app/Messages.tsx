import { BellOff, Check, CircleAlert, Copy, PhoneIncoming, PhoneMissed, PhoneOff, Reply as Reply2, Send, ShieldBan, ShieldCheck, Wifi, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import type { PairedHost, StoredMessage } from "./db";
import { when, type Lang, type Strings } from "./i18n";
import { Monitor } from "./Monitor";
import { SEED_BRIDGES } from "../bridges";
import { sendCommand } from "../commands";
import { optOutCode, sort, withRule, type Sorted, type SpamSettings } from "../spam";
import { Card, Screen } from "./ui";

/** How long a ringing call can still be declined: a little under how long a phone rings. */
const RINGING_MS = 40_000;

type Ask = (cmd: "sms" | "decline", extra: { to?: string; text?: string; sim?: string }) => Promise<boolean>;

/**
 * Writing back from the Host's SIM (DECISIONS D31). Shown only where the Host
 * said this device may send. The phone decides again when it is asked, so a
 * refusal comes back as a card in the list with its reason.
 */
function Reply(props: { m: StoredMessage; t: Strings; ask: Ask; presets?: readonly string[]; decline?: boolean }) {
  const { m, t } = props;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [state, setState] = useState<"idle" | "asking" | "asked" | "failed">("idle");

  const send = async (body: string) => {
    if (!body.trim() || state === "asking") return;
    setState("asking");
    const ok = await (props.decline ? props.ask("decline", { to: m.from, text: body.trim() }) : props.ask("sms", { to: m.from, text: body.trim(), sim: m.simKey }));
    setState(ok ? "asked" : "failed");
    if (ok) {
      setText("");
      setOpen(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {!open && (
        <button
          onClick={() => {
            setState("idle");
            setOpen(true);
          }} className="inline-flex min-h-12 items-center gap-2 self-start rounded-lg px-2 font-medium">
          <Reply2 aria-hidden size={20} strokeWidth={2} />
          {props.decline ? t.declineWith : t.reply}
        </button>
      )}
      {open && (
        <>
          {props.presets?.map((preset) => (
            <button
              key={preset}
              onClick={() => void send(preset)}
              disabled={state === "asking"}
              className="min-h-12 rounded-lg border border-border bg-card px-4 py-2 text-start disabled:opacity-40"
            >
              {preset}
            </button>
          ))}
          <label className="flex flex-col gap-1">
            <span className="font-medium">{t.replyLabel(`\u2066${m.from}\u2069`)}</span>
            <textarea
              dir="auto"
              rows={2}
              maxLength={200}
              value={text}
              onChange={(e) => setText(e.target.value)}
              className="rounded-lg border border-input bg-background px-4 py-3 text-base"
            />
          </label>
          <p className="text-muted-foreground">{t.replyHint}</p>
          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={() => void send(text)}
              disabled={!text.trim() || state === "asking"}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg bg-primary px-4 font-semibold text-primary-foreground disabled:opacity-40"
            >
              <Send aria-hidden size={20} strokeWidth={2} />
              {t.send}
            </button>
            <button onClick={() => setOpen(false)} className="min-h-12 rounded-lg bg-secondary px-4 font-semibold text-secondary-foreground">
              {t.cancel}
            </button>
          </div>
        </>
      )}
      <p aria-live="polite" className={state === "failed" ? "font-medium text-destructive" : "text-muted-foreground"}>
        {state === "asked" ? t.asked : state === "failed" ? t.askFailed : ""}
      </p>
    </div>
  );
}

function MessageCard(props: {
  m: StoredMessage;
  hostName: string | null;
  t: Strings;
  lang: Lang;
  now: number;
  sorted: Sorted;
  /** Moves this message's sender to the other list. */
  onMove: () => void;
  /** What the Host lets this device ask for; see `Status.can`. */
  can: readonly string[];
  ask: Ask;
}) {
  const { m, t, lang, can } = props;
  const [copied, setCopied] = useState(false);
  const [unsubscribed, setUnsubscribed] = useState<boolean | null>(null);
  const [declined, setDeclined] = useState<boolean | null>(null);
  const [declining, setDeclining] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(m.code!);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  // A sender is a number or a Latin name. The isolate marks keep "+98…" from being flipped.
  // With a name from the Host phone's contacts, the name leads and the number follows it.
  const who = (
    <>
      {m.name && (
        <span dir="auto" className="font-semibold text-foreground">
          {m.name}{" "}
        </span>
      )}
      <span className={m.name ? "" : "font-semibold text-foreground"}>{`\u2066${m.from}\u2069`}</span>
    </>
  );
  const time = <time>{when(m.at, props.now, lang)}</time>;
  const host = props.hostName && (
    <p dir="auto" className="font-semibold">
      {props.hostName}
    </p>
  );
  const canReply = can.includes("sms") && Boolean(m.simKey);

  if (m.kind === "sent") {
    return (
      <Card className={`flex flex-col gap-2 ${m.ok ? "" : "border-destructive"}`}>
        {host}
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-muted-foreground">
          <span className={`flex items-center gap-2 ${m.ok ? "" : "font-semibold text-destructive"}`}>
            {m.ok ? <Send aria-hidden size={18} strokeWidth={2} /> : <CircleAlert aria-hidden size={18} strokeWidth={2} />}
            <span>
              {m.ok ? t.sentTo : t.notSentTo} {who} · {m.sim}
            </span>
          </span>
          {time}
        </div>
        <p dir="auto" className="whitespace-pre-wrap break-words">
          {m.body}
        </p>
        {!m.ok && <p className="font-medium text-destructive">{t.sendWhy[m.why ?? "failed"] ?? t.sendWhy.failed}</p>}
        {m.by && <p className="text-muted-foreground">{t.sentBy(m.by)}</p>}
      </Card>
    );
  }

  if (m.kind === "call" || m.kind === "missed") {
    const ringing = m.kind === "call" && props.now - m.at < RINGING_MS && Date.now() - m.at < RINGING_MS;
    const Icon = m.kind === "missed" ? PhoneMissed : PhoneIncoming;
    return (
      <Card className="flex flex-col gap-3">
        {host}
        <div className="flex flex-wrap items-baseline justify-between gap-2 text-muted-foreground">
          <span className={`flex items-center gap-2 ${m.kind === "missed" ? "text-destructive" : ""}`}>
            <Icon aria-hidden size={20} strokeWidth={2} />
            <span>
              {m.kind === "missed" ? t.callMissed : t.callFrom} {who} · {m.sim}
            </span>
          </span>
          {time}
        </div>
        {ringing && <p className="text-lg font-semibold">{t.callRinging}</p>}
        {ringing && can.includes("calls") && declined !== true && (
          <>
            <button
              disabled={declined === null && declining}
              onClick={async () => {
                setDeclining(true);
                // The phone ends only this call, and only if it is still ringing.
                setDeclined(await props.ask("decline", { to: m.from }));
                setDeclining(false);
              }}
              className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-destructive bg-card px-4 font-semibold text-destructive disabled:opacity-40"
            >
              <PhoneOff aria-hidden size={20} strokeWidth={2} />
              {t.decline}
            </button>
            {can.includes("sms") && <Reply m={m} t={t} ask={props.ask} presets={t.declinePresets} decline />}
          </>
        )}
        {declined !== null && <p className={declined ? "text-muted-foreground" : "font-medium text-destructive"}>{declined ? t.declineAsked : t.askFailed}</p>}
        {!ringing && canReply && <Reply m={m} t={t} ask={props.ask} />}
      </Card>
    );
  }

  const stop = props.sorted !== "inbox" && canReply ? optOutCode(m.body) : null;
  return (
    <Card className="flex flex-col gap-3">
      {host}
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-muted-foreground">
        <span>
          {t.from} {who} · {m.sim}
        </span>
        {time}
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
      {/* An advertiser says how to be rid of it. One tap sends exactly that, from the SIM it wrote to. */}
      {stop && unsubscribed !== true && (
        <button
          onClick={async () => setUnsubscribed(await props.ask("sms", { to: m.from, text: stop, sim: m.simKey }))}
          className="inline-flex min-h-12 items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 font-semibold"
        >
          <BellOff aria-hidden size={20} strokeWidth={2} />
          {t.optOut(stop)}
        </button>
      )}
      {unsubscribed !== null && <p className={unsubscribed ? "text-muted-foreground" : "font-medium text-destructive"}>{unsubscribed ? t.asked : t.askFailed}</p>}
      {props.sorted === "inbox" && canReply && <Reply m={m} t={t} ask={props.ask} />}
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
  // A call that went unanswered is told twice, ringing and then missed. Once
  // the second has arrived, the first has nothing left to say.
  const missed = new Set(props.messages.filter((m) => m.kind === "missed").map((m) => `${m.host} ${m.from} ${m.at}`));
  // Only messages of Hosts still here: a Host and its messages are removed
  // together, and the screen must not show one without the other even briefly.
  const present = new Set(hosts.map((h) => h.id));
  const all = props.messages.filter((m) => present.has(m.host) && !(m.kind === "call" && missed.has(`${m.host} ${m.from} ${m.at}`)));
  const ofHost = selected ? all.filter((m) => m.host === selected) : all;
  const byId = new Map(hosts.map((h) => [h.id, h]));
  /** Asks a message's Host to send or to decline. Resolves to whether a bridge took the request. */
  const askHost = (hostId: string): Ask => async (cmd, extra) => {
    const remote = byId.get(hostId)?.remote;
    if (!remote) return false;
    return sendCommand(SEED_BRIDGES, remote, cmd, undefined, extra).then(() => true, () => false);
  };
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
                can={byId.get(m.host)?.status?.can ?? []}
                ask={askHost(m.host)}
              />
            </li>
          ))}
        </ul>
      )}
    </Screen>
  );
}
