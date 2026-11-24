import { ArrowLeft, ArrowRight, BatteryWarning, BellOff, BellRing, Check, ChevronDown, ChevronLeft, ChevronRight, Languages, Send, Settings, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { faDigits, type Lang } from "../app/i18n";
import { Alert, Button, Card, PictureCard, Screen } from "../app/ui";
import { pictureFrom } from "../pictures";
import { BACK, CHANGE, type HostState, type Native, type Permission } from "./native";
import { HOST_STRINGS, type HostStrings } from "./strings";

const LANG_KEY = "easyotp.host.lang";
const SKIP_KEY = "easyotp.host.skipped";

/** base64url to bytes. Written out here so the screens do not pull in the crypto library for it. */
const bytesOf = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

const read = (native: Native) => JSON.parse(native.state()) as HostState;

function stored<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "null") as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}

/** The Host's screens. Everything shown comes from the phone; see native.ts. */
export function HostApp({ native }: { native: Native }) {
  const [lang, setLang] = useState<Lang>(() => stored<Lang>(LANG_KEY, "fa"));
  const [state, setState] = useState<HostState>(() => read(native));
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * Which sheet is open. The gear is the phone's own settings and the help;
   * tapping a Receiver opens that Receiver and nothing else. Two doors, two rooms.
   */
  const [panel, setPanel] = useState<"settings" | "receiver" | null>(null);
  const t = HOST_STRINGS[lang];

  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "fa" ? "rtl" : "ltr";
    localStorage.setItem(LANG_KEY, JSON.stringify(lang));
  }, [lang]);

  useEffect(() => {
    const refresh = () => setState(read(native));
    window.addEventListener(CHANGE, refresh);
    return () => window.removeEventListener(CHANGE, refresh);
  }, [native]);

  // The phone's Back button closes whatever is open, and leaves when nothing is.
  useEffect(() => {
    const back = () => {
      if (state.ring) native.stopRing();
      else if (state.pair) native.pairCancel();
      else if (panel) setPanel(null);
      else native.exit();
    };
    window.addEventListener(BACK, back);
    return () => window.removeEventListener(BACK, back);
  }, [native, state.ring, state.pair, panel]);

  // Once the phone is set up, the corner holds the gear. Before that there is
  // nothing to manage, and the one thing a person may need is the other language.
  const ready = state.consent && state.perms.sms && state.perms.phone && !state.pair;
  const header = (
    <header className="flex items-center justify-between">
      <span className="flex items-baseline gap-2 text-lg font-bold">
        <span dir="ltr">EasyOTP</span>
        <span className="text-base font-medium text-muted-foreground">{t.role}</span>
      </span>
      {ready ? (
        <button onClick={() => setPanel("settings")} aria-label={t.menu} className="inline-flex size-12 items-center justify-center rounded-lg">
          <Settings aria-hidden size={26} strokeWidth={2} />
        </button>
      ) : (
      <button
        onClick={() => setLang(lang === "fa" ? "en" : "fa")}
        className="inline-flex min-h-12 items-center gap-2 rounded-lg px-3 font-semibold"
        lang={lang === "fa" ? "en" : "fa"}
      >
        <Languages aria-hidden size={20} strokeWidth={2} />
        {t.language}
      </button>
      )}
    </header>
  );

  // On top of whatever is showing: someone hearing the phone ring and opening
  // the app should see why, and the one button that ends it.
  const ringing = state.ring && (
    <div role="alertdialog" aria-modal="true" aria-labelledby="ring-title" className="fixed inset-0 z-50 flex items-end bg-foreground/40 p-4">
      <Card className="mx-auto flex w-full max-w-md flex-col gap-4">
        <h2 id="ring-title" className="flex items-center gap-3 text-xl font-bold">
          <BellRing aria-hidden size={28} className="shrink-0 text-brand" />
          {t.ringTitle}
        </h2>
        <p>{t.ringBody(state.ring.from)}</p>
        <Button autoFocus onClick={() => native.stopRing()}>
          {t.ringStop}
        </Button>
      </Card>
    </div>
  );

  if (state.pair) {
    return (
      <>
      {ringing}
      <PairScreen
        t={t}
        lang={lang}
        header={header}
        pair={state.pair}
        native={native}
        onAnswered={(same, id, peer) => {
          setNotice(same ? (id ? t.connected(peer) : t.errStore) : t.errDifferent);
          // What this person may read and do is set in the panel, so it opens there.
          if (id) {
            setOpen(id);
            setPanel("receiver");
          }
        }}
      />
      </>
    );
  }

  return (
    <>
    {ringing}
    <Setup t={t} lang={lang} header={header} state={state} native={native}>
      <Home t={t} lang={lang} header={header} state={state} native={native} notice={notice} clearNotice={() => setNotice(null)} onManage={(id) => {
        setOpen(id);
        setPanel("receiver");
      }} />
      {/* A ring is said over everything, and a dialog would sit on top of it. */}
      {panel && !state.ring && (
        <HostPanel t={t} lang={lang} state={state} native={native} only={panel === "receiver" ? open : null} onLang={setLang} onClose={() => setPanel(null)} />
      )}
    </Setup>
    </>
  );
}

const Forward = ({ lang }: { lang: Lang }) => (lang === "fa" ? <ArrowLeft aria-hidden size={22} /> : <ArrowRight aria-hidden size={22} />);

interface Step {
  key: "consent" | Permission;
  title: string;
  body: string;
  done: boolean;
  /** The phone works without it, less well. */
  optional: boolean;
}

/**
 * One thing at a time. Each step is a question Android asks in its own words,
 * so this says first, in ours, what it is for. Shows `children` once nothing
 * is left to ask.
 */
function Setup(props: { t: HostStrings; lang: Lang; header: React.ReactNode; state: HostState; native: Native; children: React.ReactNode }) {
  const { t, lang, state, native } = props;
  const [skipped, setSkipped] = useState<string[]>(() => stored<string[]>(SKIP_KEY, []));
  const [asked, setAsked] = useState<string[]>([]);
  const [agreed, setAgreed] = useState(false);

  const steps: Step[] = [
    { key: "consent", title: t.consentTitle, body: t.consentBody, done: state.consent, optional: false },
    { key: "sms", title: t.smsTitle, body: t.smsBody, done: state.perms.sms, optional: false },
    { key: "phone", title: t.phoneTitle, body: t.phoneBody, done: state.perms.phone, optional: false },
    { key: "notify", title: t.notifyTitle, body: t.notifyBody, done: state.perms.notify, optional: true },
    { key: "battery", title: t.batteryTitle, body: t.batteryBody, done: state.perms.battery, optional: true },
  ];
  const at = steps.findIndex((s) => !s.done && !(s.optional && skipped.includes(s.key)));
  if (at < 0) return <>{props.children}</>;
  const step = steps[at]!;

  const skip = () => {
    const next = [...skipped, step.key];
    setSkipped(next);
    localStorage.setItem(SKIP_KEY, JSON.stringify(next));
  };

  return (
    <Screen>
      {props.header}
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">{t.setupTitle}</h1>
        {at === 0 && <p className="text-muted-foreground">{t.setupBody}</p>}
      </div>
      <Card className="flex flex-col gap-4">
        <p className="text-muted-foreground">{t.stepOf(at + 1, steps.length)}</p>
        <h2 className="text-xl font-semibold">{step.title}</h2>
        <p>{step.body}</p>
        {step.key === "consent" && (
          <label className="flex min-h-14 items-center gap-3 rounded-lg border border-border px-4 py-3 font-medium">
            <input type="checkbox" className="size-6 shrink-0" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            {t.consentCheck}
          </label>
        )}
      </Card>
      {/* Asked once already and still not granted: Android will not ask again by itself. */}
      {step.key !== "consent" && asked.includes(step.key) && (
        <>
          <Alert>{t.denied}</Alert>
          <Button variant="secondary" onClick={() => native.ask("settings")}>
            {t.openSettings}
          </Button>
        </>
      )}
      <div className="mt-auto flex flex-col gap-3">
        {step.key === "consent" ? (
          <Button disabled={!agreed} onClick={() => native.setConsent(true)}>
            {t.next}
            <Forward lang={lang} />
          </Button>
        ) : (
          <Button
            onClick={() => {
              setAsked((a) => [...a, step.key]);
              native.ask(step.key as Permission);
            }}
          >
            {t.allow}
          </Button>
        )}
        {step.optional && (
          <Button variant="secondary" onClick={skip}>
            {t.skip}
          </Button>
        )}
      </div>
    </Screen>
  );
}

/** What the phone is doing, who is connected, and the one thing done often: connecting someone. */
function Home(props: {
  t: HostStrings;
  lang: Lang;
  header: React.ReactNode;
  state: HostState;
  native: Native;
  notice: string | null;
  clearNotice: () => void;
  /** Opens the panel at one Receiver. */
  onManage: (id: string) => void;
}) {
  const { t, lang, state, native } = props;
  const count = state.receivers.length;
  const date = (at: number) => new Intl.DateTimeFormat(lang === "fa" ? "fa-IR" : "en-GB", { dateStyle: "medium" }).format(at);

  return (
    <Screen>
      {props.header}

      <Card className="flex items-start gap-3">
        <span aria-hidden className={`mt-2 size-4 shrink-0 rounded-full ${count ? "bg-success" : "bg-warning"}`} />
        <div>
          <h1 className="text-2xl font-bold">{count ? t.onTitle : t.noneTitle}</h1>
          <p className="text-muted-foreground">{count ? t.onBody(count) : t.noneBody}</p>
          {state.pending > 0 && <p className="font-medium">{t.pending(state.pending)}</p>}
        </div>
      </Card>

      {props.notice && (
        <p role="status" className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card p-4 font-medium">
          {props.notice}
          <button onClick={props.clearNotice} aria-label={t.back} className="inline-flex size-10 shrink-0 items-center justify-center rounded-lg">
            <X aria-hidden size={20} />
          </button>
        </p>
      )}

      {!state.perms.battery && (
        <Warning icon={<BatteryWarning aria-hidden size={24} />} text={t.warnBattery} action={t.fix} onAction={() => native.ask("battery")} />
      )}
      {!state.perms.notify && (
        <Warning icon={<BellOff aria-hidden size={24} />} text={t.warnNotify} action={t.fix} onAction={() => native.ask("notify")} />
      )}

      {count > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-semibold">{t.receivers}</h2>
          {state.receivers.map((r) => (
            <button key={r.id} onClick={() => props.onManage(r.id)} className="flex min-h-16 w-full items-center justify-between gap-3 rounded-xl border border-border bg-card p-4 text-start">
              <span>
                <span dir="auto" className="block text-lg font-semibold">
                  {r.label || t.receivers}
                </span>
                <span className="block text-muted-foreground">{t.since(date(r.pairedAt))}</span>
              </span>
              {lang === "fa" ? <ChevronLeft aria-hidden size={22} className="shrink-0 text-muted-foreground" /> : <ChevronRight aria-hidden size={22} className="shrink-0 text-muted-foreground" />}
            </button>
          ))}
        </section>
      )}

      <Button variant={count ? "secondary" : "primary"} onClick={() => native.pairStart()}>
        {count ? t.connectAnother : t.connect}
      </Button>
    </Screen>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-lg font-bold">{title}</h3>
      {children}
    </section>
  );
}

/** A switch with its sentence, and what to do while Android has not agreed to it. */
function Switch(props: { t: HostStrings; native: Native; label: string; hint: string; on: boolean; granted: boolean; what: Permission; onChange: (on: boolean) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <label className="flex min-h-12 items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 font-medium">
        <input
          type="checkbox"
          className="size-6 shrink-0"
          checked={props.on}
          onChange={(e) => {
            props.onChange(e.target.checked);
            if (e.target.checked && !props.granted) props.native.ask(props.what);
          }}
        />
        {props.label}
      </label>
      <p className="text-muted-foreground">{props.hint}</p>
      {props.on && !props.granted && <Granting t={props.t} native={props.native} what={props.what} />}
    </div>
  );
}

/**
 * The side sheet, in one of two forms.
 *
 * With `only` set it is one Receiver: which SIMs it reads, whether it may
 * send, and disconnecting it. Without, it is the gear: what the phone shares,
 * its name and language, Android's permissions, a test, and the help. The
 * home screen stays as it is on a phone nobody touches: a status and a list.
 */
function HostPanel(props: {
  t: HostStrings;
  lang: Lang;
  state: HostState;
  native: Native;
  /** The id of the one Receiver to show, or null for the phone's settings. */
  only: string | null;
  onLang: (lang: Lang) => void;
  onClose: () => void;
}) {
  const { t, lang, state, native } = props;
  const receiver = props.only ? state.receivers.find((r) => r.id === props.only) : undefined;
  const ref = useRef<HTMLDialogElement>(null);
  const [removing, setRemoving] = useState(false);
  const [name, setName] = useState(state.label);
  const [testing, setTesting] = useState<number | null>(null);
  const date = (at: number) => new Intl.DateTimeFormat(lang === "fa" ? "fa-IR" : "en-GB", { dateStyle: "medium" }).format(at);

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  // The Receiver this sheet was about is gone: disconnected here, a moment ago.
  const gone = props.only !== null && !receiver;
  useEffect(() => {
    if (gone) ref.current?.close();
  }, [gone]);

  // A test is finished when the phone reports one newer than the press.
  const tested = testing !== null && state.test !== null && state.test.at >= testing;
  useEffect(() => {
    if (tested) setTesting(null);
  }, [tested]);

  const toggleSim = (id: string, current: string[] | null, key: string) => {
    const all = state.sims.map((s) => s.key);
    const now = current ?? all;
    const next = now.includes(key) ? now.filter((k) => k !== key) : [...now, key];
    // Someone connected reads at least one SIM; to stop everything, disconnect them.
    if (next.length === 0) return;
    native.setReceiverSims(id, all.every((k) => next.includes(k)) ? "null" : JSON.stringify(next));
  };

  return (
    <dialog
      ref={ref}
      onClose={props.onClose}
      // Fills the height and sits against the starting edge: the right in Persian, the left in English.
      className="m-0 me-auto h-dvh max-h-none w-[min(92vw,26rem)] max-w-none overflow-y-auto border-e border-border bg-background p-0 text-foreground backdrop:bg-foreground/40"
    >
      <div className="flex min-h-full flex-col gap-8 px-4 py-6">
        <div className="flex items-center justify-between">
          <h2 dir="auto" className="text-2xl font-bold">
            {props.only ? (receiver?.label ?? "") : t.menu}
          </h2>
          <button onClick={() => ref.current?.close()} aria-label={t.close} className="inline-flex size-12 items-center justify-center rounded-lg">
            <X aria-hidden size={24} strokeWidth={2} />
          </button>
        </div>

        {receiver && (
          <>
            <p className="text-muted-foreground">{t.since(date(receiver.pairedAt))}</p>
            {state.sims.length > 1 && (
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-2 font-semibold">{t.simsTitle}</legend>
                {state.sims.map((sim) => (
                  <label key={sim.key} className="flex min-h-12 items-center gap-3 rounded-lg border border-border bg-card px-4">
                    <input
                      type="checkbox"
                      className="size-6 shrink-0"
                      checked={receiver.sims === null || receiver.sims.includes(sim.key)}
                      onChange={() => toggleSim(receiver.id, receiver.sims, sim.key)}
                    />
                    <span dir="auto">{sim.name}</span>
                  </label>
                ))}
              </fieldset>
            )}
            <Switch t={t} native={native} label={t.canSend} hint={t.canSendHint} on={receiver.canSend} granted={state.perms.send} what="send" onChange={(on) => native.setReceiverCanSend(receiver.id, on)} />
            <div className="mt-auto flex flex-col gap-3">
              {removing ? (
                <>
                  <p className="font-medium">{t.removeAsk(receiver.label)}</p>
                  <Button variant="danger" onClick={() => native.removeReceiver(receiver.id)}>
                    {t.removeYes}
                  </Button>
                  <Button variant="secondary" onClick={() => setRemoving(false)}>
                    {t.no}
                  </Button>
                </>
              ) : (
                <Button variant="danger" onClick={() => setRemoving(true)}>
                  {t.remove}
                </Button>
              )}
            </div>
          </>
        )}

        {!props.only && (
          <>
        <Section title={t.shareTitle}>
          <Switch t={t} native={native} label={t.callsOn} hint={t.callsHint} on={state.calls} granted={state.perms.calls} what="calls" onChange={(on) => native.setCalls(on)} />
          <Switch t={t} native={native} label={t.contactsOn} hint={t.contactsHint} on={state.contacts} granted={state.perms.contacts} what="contacts" onChange={(on) => native.setContacts(on)} />
        </Section>

        <Section title={t.thisPhone}>
          <label htmlFor="phone-name" className="font-semibold">
            {t.phoneName}
          </label>
          <input id="phone-name" dir="auto" maxLength={40} value={name} onChange={(e) => setName(e.target.value)} className="min-h-14 rounded-lg border border-input bg-background px-4" />
          <p className="text-muted-foreground">{t.phoneNameHint}</p>
          {name.trim() !== state.label && name.trim() !== "" && (
            <Button variant="secondary" onClick={() => native.setLabel(name.trim())}>
              <Check aria-hidden size={20} />
              {t.save}
            </Button>
          )}
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-2 font-semibold">{t.languageLabel}</legend>
            <div className="grid grid-cols-2 gap-3">
              {(["fa", "en"] as const).map((code) => (
                <button
                  key={code}
                  lang={code}
                  aria-pressed={lang === code}
                  onClick={() => props.onLang(code)}
                  className={`min-h-12 rounded-lg border font-semibold ${lang === code ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card"}`}
                >
                  {code === "fa" ? "فارسی" : "English"}
                </button>
              ))}
            </div>
          </fieldset>
        </Section>

        <Section title={t.permsTitle}>
          <ul className="flex flex-col gap-2">
            {(
              [
                ["sms", t.smsTitle],
                ["phone", t.phoneTitle],
                ["notify", t.notifyTitle],
                ["battery", t.batteryTitle],
              ] as const
            ).map(([key, label]) => (
              <li key={key} className="flex min-h-12 items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-2">
                <span>{label}</span>
                {state.perms[key] ? (
                  <span className="flex items-center gap-1 font-medium text-success">
                    <Check aria-hidden size={18} />
                    {t.granted}
                  </span>
                ) : (
                  <button onClick={() => native.ask(key)} className="min-h-10 rounded-lg bg-secondary px-3 font-semibold text-secondary-foreground">
                    {t.fix}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <Button variant="secondary" onClick={() => native.ask("settings")}>
            {t.openSettings}
          </Button>
        </Section>

        {state.receivers.length > 0 && (
          <Section title={t.testTitle}>
            <Button
              variant="secondary"
              disabled={testing !== null}
              onClick={() => {
                setTesting(Date.now());
                native.sendTest();
              }}
            >
              <Send aria-hidden size={20} />
              {testing !== null ? t.testing : t.test}
            </Button>
            {state.test !== null && testing === null && (state.test.ok ? <p role="status">{t.testOk}</p> : <Alert>{t.testFail}</Alert>)}
          </Section>
        )}

        <Section title={t.helpTitle}>
          <div className="flex flex-col gap-2">
            {t.help.map(([question, answer]) => (
              <details key={question} className="group rounded-lg border border-border bg-card">
                <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 p-4 font-semibold">
                  {question}
                  <ChevronDown aria-hidden size={20} strokeWidth={2} className="shrink-0 transition-transform duration-200 group-open:rotate-180" />
                </summary>
                <p className="px-4 pb-4">{answer}</p>
              </details>
            ))}
          </div>
        </Section>

        <p className="text-center text-muted-foreground" dir="auto">
          {t.version(state.version)}
        </p>
          </>
        )}
      </div>
    </dialog>
  );
}

/**
 * A switch that is on while Android has not agreed. Said in words, with both
 * ways forward: ask again, or the settings screen for a permission Android
 * holds back from an app installed outside the store.
 */
function Granting({ t, native, what }: { t: HostStrings; native: Native; what: Permission }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="font-medium text-destructive">{t.needsAndroid}</p>
      <div className="grid grid-cols-2 gap-3">
        <Button variant="secondary" onClick={() => native.ask(what)}>
          {t.allow}
        </Button>
        <Button variant="secondary" onClick={() => native.ask("settings")}>
          {t.openSettings}
        </Button>
      </div>
    </div>
  );
}

/** A warning in words, with the one button that fixes it. */
function Warning(props: { icon: React.ReactNode; text: string; action: string; onAction: () => void }) {
  return (
    <Card className="flex flex-col gap-3 border-destructive">
      <p className="flex items-start gap-3 font-medium">
        <span className="mt-1 shrink-0 text-destructive">{props.icon}</span>
        {props.text}
      </p>
      <Button variant="secondary" onClick={props.onAction}>
        {props.action}
      </Button>
    </Card>
  );
}

function PairScreen(props: {
  t: HostStrings;
  lang: Lang;
  header: React.ReactNode;
  pair: NonNullable<HostState["pair"]>;
  native: Native;
  onAnswered: (same: boolean, id: string, peer: string) => void;
}) {
  const { t, lang, pair, native } = props;
  // Two groups of four are easier to read out and to hear.
  const grouped = `${pair.code.slice(0, 4)} ${pair.code.slice(4)}`;
  const answer = (same: boolean) => props.onAnswered(same, native.pairAnswer(same), pair.peer ?? "");

  return (
    <Screen>
      {props.header}
      {pair.stage === "waiting" && (
        <>
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-bold">{t.pairTitle}</h1>
            <p className="text-muted-foreground">{t.pairBody}</p>
          </div>
          <Card className="flex flex-col items-center gap-2">
            <p className="font-medium text-muted-foreground">{t.pairCode}</p>
            {/* Digits read left to right in both languages. */}
            <p dir="ltr" className="text-5xl font-bold tabular-nums" aria-label={pair.code.split("").join(" ")}>
              {lang === "fa" ? faDigits(grouped) : grouped}
            </p>
          </Card>
          <div role="status" className="flex flex-col gap-2">
            <p className="font-medium">{t.pairWaiting}</p>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-brand" />
            </div>
            <p className="text-muted-foreground">{t.pairWaitingHint}</p>
          </div>
          <div className="mt-auto">
            <Button variant="secondary" onClick={() => native.pairCancel()}>
              {t.cancel}
            </Button>
          </div>
        </>
      )}

      {pair.stage === "picture" && pair.sas && (
        <>
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-bold">{t.pictureTitle}</h1>
            <p className="text-muted-foreground">{t.pictureBody(pair.peer ?? "")}</p>
          </div>
          <PictureCard picture={pictureFrom(bytesOf(pair.sas))} lang={lang} />
          <div className="mt-auto flex flex-col gap-3">
            <Button onClick={() => answer(true)}>
              <Check aria-hidden size={22} />
              {t.pictureSame}
            </Button>
            <Button variant="danger" onClick={() => answer(false)}>
              <X aria-hidden size={22} />
              {t.pictureDifferent}
            </Button>
          </div>
        </>
      )}

      {pair.stage === "failed" && (
        <>
          <h1 className="text-2xl font-bold">{t.pairTitle}</h1>
          <Alert>{pair.reason === "timeout" ? t.errTimeout : t.errUnreachable}</Alert>
          <div className="mt-auto flex flex-col gap-3">
            <Button onClick={() => native.pairStart()}>{t.newCode}</Button>
            <Button variant="secondary" onClick={() => native.pairCancel()}>
              {t.back}
            </Button>
          </div>
        </>
      )}
    </Screen>
  );
}
