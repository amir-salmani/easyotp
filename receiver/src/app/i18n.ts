/**
 * Every string a person reads, in both languages (DECISIONS D22). Persian is
 * the default. Register: formal but human, the same throughout.
 */
export type Lang = "fa" | "en";

const FA_DIGITS = ["۰", "۱", "۲", "۳", "۴", "۵", "۶", "۷", "۸", "۹"];

/** Latin digits to Persian, for display only. Values stay Latin. */
export const faDigits = (value: string | number) => String(value).replace(/\d/g, (d) => FA_DIGITS[Number(d)]!);

/** Persian or Arabic digits back to Latin, for what a person typed. */
export const latinDigits = (value: string) =>
  value
    .replace(/[۰-۹]/g, (d) => String(FA_DIGITS.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));

const fa = {
  appName: "EasyOTP",
  language: "English",
  loading: "در حال باز شدن",
  errStorage: "این مرورگر اجازه‌ی ذخیره‌سازی یا رمزنگاری لازم را نمی‌دهد. برنامه را در Safari یا Chrome به‌روز و بیرون از حالت خصوصی باز کنید.",
  // Install gate
  installTitle: "اول آن را به صفحه‌ی اصلی اضافه کنید",
  installBody: "EasyOTP فقط وقتی کار می‌کند که روی صفحه‌ی اصلی دستگاه نصب شده باشد. این‌طور پیام‌ها روی همین دستگاه می‌مانند و برنامه بدون مرورگر باز می‌شود.",
  installButton: "افزودن به صفحه‌ی اصلی",
  installIosTitle: "در آیفون و آیپد",
  installIos1: "در Safari دکمه‌ی «هم‌رسانی» را بزنید.",
  installIos2: "«Add to Home Screen» را انتخاب کنید.",
  installIos3: "برنامه را از صفحه‌ی اصلی باز کنید.",
  installOtherTitle: "در اندروید و رایانه",
  installOther1: "منوی مرورگر را باز کنید.",
  installOther2: "«نصب برنامه» یا «افزودن به صفحه‌ی اصلی» را انتخاب کنید.",
  installOther3: "برنامه را از صفحه‌ی اصلی باز کنید.",
  // Pairing
  pairTitle: "اتصال به گوشی فرستنده",
  pairBody: "با کسی که کنار گوشی فرستنده است تماس بگیرید. روی آن گوشی هشت رقم دیده می‌شود. آن را بپرسید و این‌جا وارد کنید.",
  pairCode: "کد آشنایی",
  pairCodeHint: "هشت رقم",
  pairLabel: "نام این دستگاه",
  pairLabelHint: "روی گوشی فرستنده با همین نام دیده می‌شود.",
  pairLabelDefault: "گیرنده",
  pairStart: "ادامه",
  pairWaiting: "در انتظار گوشی فرستنده",
  pairWaitingBody: "کد باید همین حالا روی گوشی فرستنده باز باشد. اگر صفحه‌ی آن بسته شده، کد تازه‌ای بگیرید.",
  cancel: "انصراف",
  pictureTitle: "هر دو همین را می‌بینید؟",
  pictureBody: "از کسی که کنار گوشی فرستنده است بپرسید چه می‌بیند. باید دقیقاً همین رنگ و همین چیز باشد.",
  pictureSame: "بله، همین است",
  pictureDifferent: "نه، فرق دارد",
  pictureHost: (name: string) => `گوشی فرستنده: ${name}`,
  pairedTitle: "متصل شد",
  pairedBody: "وقتی طرف مقابل هم تأیید کند، پیامک‌های آن سیم‌کارت این‌جا دیده می‌شود.",
  pairedDone: "دیدن پیام‌ها",
  errBadCode: "کد باید هشت رقم باشد.",
  errTimeout: "گوشی فرستنده پاسخی نداد. کد تازه‌ای بگیرید و دوباره تلاش کنید.",
  errUnreachable: "به هیچ‌کدام از پل‌ها وصل نشد. اینترنت این دستگاه را بررسی کنید.",
  errTampered: "این اتصال در میان راه دست‌کاری شده است. آن را رها کنید و با کد تازه دوباره شروع کنید.",
  errDifferent: "تصویرها یکی نبودند، پس این اتصال ذخیره نشد. ممکن است کسی در میان راه بوده باشد. با کد تازه دوباره شروع کنید.",
  retry: "تلاش دوباره",
  // Messages
  messagesTitle: "پیام‌ها",
  empty: "هنوز پیامی نرسیده است",
  emptyBody: "هر پیامکی که به سیم‌کارت برسد، چند ثانیه بعد این‌جا دیده می‌شود.",
  copy: "کپی کد",
  copied: "کپی شد",
  from: "از",
  pairAnother: "اتصال به فرستنده‌ی دیگر",
  bridgesUp: (up: number, all: number) => `${faDigits(up)} از ${faDigits(all)} پل در دسترس است`,
  bridgesDown: "هیچ پلی در دسترس نیست. پیام‌ها با برگشتن اینترنت می‌رسند.",
  notifyOn: "روشن کردن اعلان‌ها",
  notifyHint: "اعلان فقط وقتی می‌آید که برنامه باز یا در پس‌زمینه باشد.",
  notifyTitle: (sim: string) => `پیامک تازه روی ${sim}`,
  justNow: "همین حالا",
  minutesAgo: (n: number) => `${faDigits(n)} دقیقه پیش`,
  hoursAgo: (n: number) => `${faDigits(n)} ساعت پیش`,
  hosts: (n: number) => `${faDigits(n)} فرستنده`,
};

const en: typeof fa = {
  appName: "EasyOTP",
  language: "فارسی",
  loading: "Opening",
  errStorage: "This browser does not allow the storage or encryption the app needs. Open it in an up-to-date Safari or Chrome, outside private browsing.",
  installTitle: "Add it to your home screen first",
  installBody: "EasyOTP only works once it is installed on this device's home screen. That keeps your messages on this device and lets the app open without a browser.",
  installButton: "Add to home screen",
  installIosTitle: "On iPhone and iPad",
  installIos1: "In Safari, tap the Share button.",
  installIos2: "Choose “Add to Home Screen”.",
  installIos3: "Open the app from your home screen.",
  installOtherTitle: "On Android and computers",
  installOther1: "Open the browser's menu.",
  installOther2: "Choose “Install app” or “Add to home screen”.",
  installOther3: "Open the app from your home screen.",
  pairTitle: "Connect to the Host phone",
  pairBody: "Call the person beside the Host phone. It is showing eight digits. Ask for them and enter them here.",
  pairCode: "Pairing code",
  pairCodeHint: "Eight digits",
  pairLabel: "This device's name",
  pairLabelHint: "The Host phone will show this name.",
  pairLabelDefault: "Receiver",
  pairStart: "Continue",
  pairWaiting: "Waiting for the Host phone",
  pairWaitingBody: "The code must be open on the Host phone right now. If its screen has closed, ask for a new code.",
  cancel: "Cancel",
  pictureTitle: "Do you both see this?",
  pictureBody: "Ask the person beside the Host phone what they see. It must be exactly this colour and this thing.",
  pictureSame: "Yes, the same",
  pictureDifferent: "No, it differs",
  pictureHost: (name: string) => `Host phone: ${name}`,
  pairedTitle: "Connected",
  pairedBody: "Once the other person confirms too, that SIM's messages will appear here.",
  pairedDone: "See messages",
  errBadCode: "The code must be eight digits.",
  errTimeout: "The Host phone did not answer. Ask for a new code and try again.",
  errUnreachable: "No bridge could be reached. Check this device's internet connection.",
  errTampered: "This connection was altered on the way. Abandon it and start again with a new code.",
  errDifferent: "The pictures did not match, so this connection was not saved. Someone may have been in the middle. Start again with a new code.",
  retry: "Try again",
  messagesTitle: "Messages",
  empty: "No messages yet",
  emptyBody: "Any SMS that reaches the SIM appears here a few seconds later.",
  copy: "Copy code",
  copied: "Copied",
  from: "From",
  pairAnother: "Connect another Host",
  bridgesUp: (up: number, all: number) => `${up} of ${all} bridges reachable`,
  bridgesDown: "No bridge is reachable. Messages arrive when the connection returns.",
  notifyOn: "Turn on notifications",
  notifyHint: "A notification only arrives while the app is open or in the background.",
  notifyTitle: (sim: string) => `New SMS on ${sim}`,
  justNow: "Just now",
  minutesAgo: (n: number) => `${n} min ago`,
  hoursAgo: (n: number) => `${n} h ago`,
  hosts: (n: number) => (n === 1 ? "1 Host" : `${n} Hosts`),
};

export const STRINGS = { fa, en };
export type Strings = typeof fa;

/** When a message arrived, the way a person would say it. */
export function when(at: number, now: number, lang: Lang): string {
  const t = STRINGS[lang];
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return t.justNow;
  if (minutes < 60) return t.minutesAgo(minutes);
  if (minutes < 24 * 60) return t.hoursAgo(Math.floor(minutes / 60));
  // Fine for a label. A date picker would need a real Jalali calendar.
  return new Date(at).toLocaleString(lang === "fa" ? "fa-IR" : "en-GB", { dateStyle: "medium", timeStyle: "short" });
}
