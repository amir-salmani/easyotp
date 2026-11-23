import { ArrowLeft, ArrowRight, Check, X } from "lucide-react";
import { useRef, useState } from "react";
import { SEED_BRIDGES } from "../bridges";
import { CODE_SHAPE, pairAsReceiver, PairingError, type PairingResult } from "../pairing";
import { COLOURS, THINGS } from "../pictures";
import type { StoredIdentity } from "./db";
import { faDigits, latinDigits, type Lang, type Strings } from "./i18n";
import { Alert, Button, Card, Screen } from "./ui";

type Step =
  | { at: "enter"; error?: string }
  | { at: "waiting" }
  | { at: "picture"; result: PairingResult }
  | { at: "done"; host: string };

/** The colour and the thing, large, with both words: this is read aloud on a call. */
export function PictureCard({ result, lang }: { result: PairingResult; lang: Lang }) {
  const colour = COLOURS[result.picture.colour]!;
  const thing = THINGS[result.picture.thing]!;
  const other: Lang = lang === "fa" ? "en" : "fa";
  return (
    <Card className="flex flex-col items-center gap-4">
      <div
        // The one place a colour is not a token: it is the content being compared.
        style={{ backgroundColor: colour.css }}
        className="flex size-44 items-center justify-center rounded-xl border-4 border-border text-8xl"
        role="img"
        aria-label={`${thing[lang]} ${colour[lang]}`}
      >
        <span aria-hidden>{thing.emoji}</span>
      </div>
      <p className="text-center text-3xl font-bold">
        {thing[lang]} · {colour[lang]}
      </p>
      <p className="text-center text-lg text-muted-foreground" lang={other} dir={other === "fa" ? "rtl" : "ltr"}>
        {thing[other]} · {colour[other]}
      </p>
    </Card>
  );
}

export function Pair(props: {
  t: Strings;
  lang: Lang;
  identity: StoredIdentity;
  header: React.ReactNode;
  canCancel: boolean;
  onPaired: (hostLabel: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t, lang } = props;
  const [step, setStep] = useState<Step>({ at: "enter" });
  const [code, setCode] = useState("");
  const [label, setLabel] = useState(t.pairLabelDefault);
  const [saving, setSaving] = useState(false);

  /**
   * Back to the start with an empty code. A code is used once: the slot it
   * names still holds this attempt's messages, and a second attempt with the
   * same digits would be answered by the first one's leftovers.
   */
  const startOver = (error?: string) => {
    setCode("");
    setStep({ at: "enter", error });
  };
  const abort = useRef<AbortController | null>(null);
  const Forward = lang === "fa" ? ArrowLeft : ArrowRight;

  const start = async () => {
    if (!CODE_SHAPE.test(code)) return setStep({ at: "enter", error: t.errBadCode });
    abort.current = new AbortController();
    const signal = abort.current.signal;
    setStep({ at: "waiting" });
    try {
      const result = await pairAsReceiver({
        bridges: SEED_BRIDGES,
        code,
        offer: { publicKey: props.identity.publicKey, boxId: props.identity.boxId, label: label.trim() || t.pairLabelDefault },
        signal,
      });
      if (!signal.aborted) setStep({ at: "picture", result });
    } catch (e) {
      if (signal.aborted) return;
      const reason = e instanceof PairingError ? e.reason : "unreachable";
      const error = { bad_code: t.errBadCode, timeout: t.errTimeout, unreachable: t.errUnreachable, tampered: t.errTampered, cancelled: undefined }[reason];
      startOver(error);
    }
  };

  const cancel = () => {
    abort.current?.abort();
    startOver();
  };

  if (step.at === "waiting") {
    return (
      <Screen>
        {props.header}
        <h1 className="text-2xl font-bold">{t.pairWaiting}</h1>
        <p dir="ltr" className="text-center font-mono text-4xl font-bold tracking-widest">
          {lang === "fa" ? faDigits(code.slice(0, 4)) : code.slice(0, 4)} {lang === "fa" ? faDigits(code.slice(4)) : code.slice(4)}
        </p>
        <div role="status" className="h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full w-1/3 animate-pulse rounded-full bg-brand" />
        </div>
        <p>{t.pairWaitingBody}</p>
        <Button variant="secondary" onClick={cancel}>
          {t.cancel}
        </Button>
      </Screen>
    );
  }

  if (step.at === "picture") {
    return (
      <Screen>
        {props.header}
        <h1 className="text-2xl font-bold">{t.pictureTitle}</h1>
        <p>{t.pictureBody}</p>
        <PictureCard result={step.result} lang={lang} />
        {step.result.peerLabel && <p className="text-muted-foreground">{t.pictureHost(step.result.peerLabel)}</p>}
        <Button
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await props.onPaired(step.result.peerLabel);
              setStep({ at: "done", host: step.result.peerLabel });
            } catch {
              startOver(t.errStorage);
            } finally {
              setSaving(false);
            }
          }}
        >
          <Check aria-hidden size={22} strokeWidth={2} />
          {t.pictureSame}
        </Button>
        <Button variant="danger" disabled={saving} onClick={() => startOver(t.errDifferent)}>
          <X aria-hidden size={22} strokeWidth={2} />
          {t.pictureDifferent}
        </Button>
      </Screen>
    );
  }

  if (step.at === "done") {
    return (
      <Screen>
        {props.header}
        <h1 className="text-2xl font-bold">{t.pairedTitle}</h1>
        <p>{t.pairedBody}</p>
        <Button onClick={props.onClose}>
          {t.pairedDone}
          <Forward aria-hidden size={22} strokeWidth={2} />
        </Button>
      </Screen>
    );
  }

  return (
    <Screen>
      {props.header}
      <h1 className="text-2xl font-bold">{t.pairTitle}</h1>
      <p>{t.pairBody}</p>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <div className="flex flex-col gap-2">
          <label htmlFor="code" className="font-semibold">
            {t.pairCode}
          </label>
          <input
            id="code"
            // A code is read left to right in either language.
            dir="ltr"
            inputMode="numeric"
            autoComplete="off"
            maxLength={8}
            value={lang === "fa" ? faDigits(code) : code}
            onChange={(e) => setCode(latinDigits(e.target.value).replace(/\D/g, "").slice(0, 8))}
            aria-invalid={step.error === t.errBadCode}
            aria-describedby="code-hint"
            className="min-h-16 rounded-lg border border-input bg-card px-4 text-center font-mono text-3xl font-bold tracking-widest"
          />
          <p id="code-hint" className="text-muted-foreground">
            {t.pairCodeHint}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="label" className="font-semibold">
            {t.pairLabel}
          </label>
          <input
            id="label"
            maxLength={40}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            aria-describedby="label-hint"
            className="min-h-14 rounded-lg border border-input bg-card px-4 text-lg"
          />
          <p id="label-hint" className="text-muted-foreground">
            {t.pairLabelHint}
          </p>
        </div>
        {step.error && <Alert>{step.error}</Alert>}
        <Button type="submit" disabled={code.length !== 8}>
          {t.pairStart}
          <Forward aria-hidden size={22} strokeWidth={2} />
        </Button>
        {props.canCancel && (
          <Button type="button" variant="secondary" onClick={props.onClose}>
            {t.cancel}
          </Button>
        )}
      </form>
    </Screen>
  );
}
