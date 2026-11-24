---
type: Readme
title: EasyOTP
description: Read the SMS of a SIM card you left in another country, sealed end to end, over bridges that cannot read it.
status: active
created: 2026-09-17
timestamp: 2026-11-24
tags: []
---

# EasyOTP

[English](#english) · [فارسی](#فارسی)

[![build](https://github.com/amir-salmani/easyotp/actions/workflows/build.yml/badge.svg?branch=dev)](https://github.com/amir-salmani/easyotp/actions/workflows/build.yml)

## English

Read the SMS of a SIM card you left in another country.

Your bank, the government portal and your old employer all send codes to an
Iranian number, and you no longer live where that number works. EasyOTP keeps
the SIM in a phone at home and shows its messages wherever you are. Only your
own devices can read them.

### Status

**It works on a real phone.** On 2026-11-24 the Host ran on a phone with two
Iranian SIMs and the Receiver web app on an iPhone: pairing, forwarding SMS,
the phone's status, ringing it, answering an SMS, declining a call, and
contact names all worked. Both bridges are live. What is left before anyone
should rely on it is a phone left alone for days, and the first release.
[`docs/STATUS.md`](docs/STATUS.md) has the detail.

<p>
  <img src="docs/img/host-setup.png" alt="The Host app's first setup screen, in Persian" width="240">
  <img src="docs/img/receiver-app.png" alt="The Receiver showing a Host that is alive and one SMS with its code" width="240">
</p>

### What you install

| | Where | What it does |
|---|---|---|
| **Host** (Android) | the phone that holds the SIMs | Catches each SMS, seals it for your Receivers and sends it out |
| **Receiver** (web app) | any phone or computer | Shows the messages. You add it to your home screen once |
| **Receiver** (Android) | an Android phone | The same screens, with native notifications. It asks for no SMS permission |

The Host is installed once. Its screens and its list of bridges arrive later
through the bridges themselves, signed, and the phone checks the signature
before using them. A new APK is needed only if its small native core changes.

### How it works

```
  Host ──sealed──▶ bridge 1 ─┐
       ──sealed──▶ bridge 2 ─┼──▶ Receiver   (opens it, shows it once)
       ──sealed──▶ bridge n ─┘
```

1. The Host stores each SMS in an encrypted queue on the phone before doing
   anything else.
2. It seals the message to the public key of each paired Receiver, using HPKE
   (RFC 9180).
3. It sends the sealed message through every bridge that answers.
4. The Receiver collects from all bridges and shows each message once.

A bridge is a relay that holds sealed bytes until a Receiver collects them. It
has no key, so it cannot read a message, and neither can any network in between.
There are two bridges today, in two countries under two operators, and the apps
learn about new ones from a signed list.

### What else it does

| | |
|---|---|
| **The phone's health** | The Receiver shows whether the phone at home is alive, its battery and network, and can make it ring so someone nearby plugs it in |
| **Spam** | Advertising is set aside in its own list, and can be unsubscribed from in one tap. A message with a code is never set aside automatically |
| **Answers and calls** | If the phone's owner allows it, a Receiver can answer an SMS from that SIM, see who is calling, and decline a call with a message. Only to numbers that contacted the SIM, at most twenty a day, and every one is shown to everyone |
| **Woken when closed** | With notifications on, the Receiver web app is told a message arrived even while closed. The notification carries nothing of the message |

### Pairing

The Host and the Receiver are usually in different countries, so pairing works
over a phone call. The Host shows eight digits. Whoever is beside it reads them
out, and you type them into the Receiver. Both screens then show the same
picture, and you each confirm it. If someone were in the middle, the pictures
would differ.

### What it does not protect

- **Whoever holds the phone holds the SIM.** No software changes that.
- **A national internet shutdown.** Messages wait on the phone and arrive when
  the network returns.
- **Timing.** A bridge sees that a message passed and when, never what it said.

[`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) covers this in full, and
[`docs/DECISIONS.md`](docs/DECISIONS.md) records each choice and what was rejected.

### The repository

| Directory | What it is |
|---|---|
| [`host/`](host) | The Host app's native core, in Kotlin |
| [`receiver/`](receiver) | The screens, in TypeScript: the Receiver web app, the inside of the Receiver APK, and the Host's screens |
| [`receiver-apk/`](receiver-apk) | The Receiver as an Android app: a window around the same screens |
| [`shell/`](shell) | What the two Android apps share: showing screens bundled in an APK |
| [`bridge/`](bridge) | The bridge, in TypeScript: a Cloudflare Worker and a Node container from one protocol |
| [`docs/`](docs) | Architecture, decisions, threat model, bridges, status |

### Build

GitHub Actions builds and signs everything; see
[`build.yml`](.github/workflows/build.yml). To run the tests yourself:

```sh
cd bridge && npm ci && npm test          # Workers runtime and Node
cd receiver && npm ci && npm test
```

The Android apps need JDK 21 and the Android SDK. Their screens are built from
`receiver/` first:

```sh
cd receiver && npm run build:host && npm run build:apk && cd ..
./gradlew :host:testDebugUnitTest :shell:testDebugUnitTest
./gradlew :host:assembleDebug :receiver-apk:assembleDebug
```

With an emulator running and the Host installed on it, `npm run emulator-check`
in `receiver/` sets the app up, pairs with it, sends it an SMS and rings it.

A release APK is signed with a certificate whose SHA-256 is
`FA:73:5C:EC:02:67:E0:66:61:1C:E1:AF:A3:1C:50:E6:61:D0:FB:8B:51:D6:ED:2E:39:A5:E8:FB:06:6B:BC:5A`.

### License

AGPL-3.0-only, for the apps and the bridge. A tool that handles your bank codes
should be one you can read, and the AGPL makes anyone who hosts a changed copy
publish their changes too.

---

<div dir="rtl">

## فارسی

پیامک‌های سیم‌کارتی را که در کشور دیگری جا گذاشته‌اید، هر جا که هستید بخوانید.

بانک، سامانه‌های دولتی و محل کار قبلی همه به شمارهۀ ایرانی شما کد می‌فرستند و
آن شماره جایی که الان زندگی می‌کنید آنتن ندارد. ایزی‌اوتی‌پی سیم‌کارت را در
یک گوشی در خانه نگه می‌دارد و پیامک‌هایش را به دست شما می‌رساند. فقط دستگاه‌های
خود شما می‌توانند این پیام‌ها را بخوانند.

### وضعیت

**روی گوشی واقعی کار می‌کند.** روز ۳ آذر ۱۴۰۵ برنامه‌ی فرستنده روی گوشی‌ای با
دو سیم‌کارت ایرانی و وب‌اپ گیرنده روی آیفون آزمایش شد: جفت شدن، رسیدن پیامک،
وضعیت گوشی، زنگ زدن، پاسخ دادن به پیامک، رد کردن تماس و نام مخاطب‌ها همه کار
کرد. هر دو پل راه افتاده‌اند. پیش از آن‌که کسی به آن تکیه کند، باید گوشی چند
روز به حال خودش رها شود و اولین نسخه منتشر شود. جزئیات در
[`docs/STATUS.md`](docs/STATUS.md) آمده است.

### چه چیزی نصب می‌کنید

| | کجا | چه می‌کند |
|---|---|---|
| **فرستنده** (اندروید) | گوشی‌ای که سیم‌کارت‌ها در آن است | هر پیامک را می‌گیرد، برای گیرنده‌های شما رمز می‌کند و می‌فرستد |
| **گیرنده** (وب‌اپ) | هر گوشی یا رایانه | پیام‌ها را نشان می‌دهد. یک بار آن را به صفحهۀ اصلی اضافه می‌کنید |
| **گیرنده** (اندروید) | گوشی اندرویدی | همان صفحه‌ها، با اعلان خود اندروید. هیچ دسترسی‌ای به پیامک نمی‌خواهد |

فرستنده یک بار نصب می‌شود. صفحه‌ها و فهرست پل‌هایش بعداً از طریق خود پل‌ها و
با امضا می‌رسند و گوشی پیش از استفاده امضا را بررسی می‌کند. فقط وقتی هسته‌ی
کوچک برنامه تغییر کند، نصب دوباره لازم است.

### چطور کار می‌کند

۱. فرستنده پیش از هر کار دیگری پیامک را در صفی رمزشده روی خود گوشی ذخیره می‌کند.

۲. پیام را با کلید عمومی هر گیرندهۀ جفت‌شده رمز می‌کند (HPKE، استاندارد `RFC 9180`).

۳. پیام رمزشده را از همهۀ پل‌هایی که جواب می‌دهند می‌فرستد.

۴. گیرنده از همهۀ پل‌ها می‌گیرد و هر پیام را یک بار نشان می‌دهد.

پل فقط یک واسطه است و بستهۀ رمزشده را تا وقتی گیرنده آن را بگیرد نگه می‌دارد.
کلیدی ندارد، پس نمی‌تواند پیام را بخواند. شبکه‌های بین راه هم نمی‌توانند. امروز
دو پل وجود دارد، در دو کشور و زیر دست دو گردانندهۀ جدا. برنامه‌ها پل‌های تازه را
از فهرستی امضاشده می‌شناسند.

### کارهای دیگر

| | |
|---|---|
| **سلامت گوشی** | گیرنده نشان می‌دهد گوشی خانه روشن است یا نه، باتری و اینترنتش چطور است، و می‌تواند آن را به زنگ بیندازد تا کسی که نزدیک آن است به شارژش بزند |
| **هرزنامه** | پیامک‌های تبلیغاتی در فهرست جدایی می‌روند و با یک ضربه می‌شود اشتراکشان را لغو کرد. پیامی که کد دارد هیچ‌وقت خودکار جدا نمی‌شود |
| **پاسخ و تماس** | اگر صاحب گوشی اجازه بدهد، گیرنده می‌تواند از همان سیم‌کارت به پیامک پاسخ بدهد، ببیند چه کسی زنگ می‌زند و تماس را با یک پیامک رد کند. فقط به شماره‌ای که خودش با آن سیم‌کارت تماس گرفته، روزی حداکثر بیست پیامک، و هر پیامک به همه نشان داده می‌شود |
| **بیدار شدن با برنامه‌ی بسته** | با اعلان روشن، وب‌اپ گیرنده حتی وقتی بسته است هم خبر می‌گیرد که پیامی آمده. خود اعلان چیزی از پیام ندارد |

### جفت‌کردن

فرستنده و گیرنده معمولاً در دو کشورند، برای همین جفت‌کردن با یک تماس تلفنی
انجام می‌شود. فرستنده هشت رقم نشان می‌دهد. کسی که کنار آن گوشی است رقم‌ها را
می‌خواند و شما آن‌ها را در گیرنده وارد می‌کنید. بعد هر دو صفحه یک تصویر یکسان
نشان می‌دهند و هر دو نفر تاییدش می‌کنید. اگر کسی این وسط نشسته باشد، دو تصویر
با هم فرق خواهند داشت.

### از چه چیزی محافظت نمی‌کند

- **گوشی دست هر کس باشد، سیم‌کارت هم دست اوست.** هیچ نرم‌افزاری این را عوض نمی‌کند.
- **قطع سراسری اینترنت.** پیام‌ها روی گوشی می‌مانند و با برگشتن شبکه می‌رسند.
- **زمان پیام.** پل می‌بیند که پیامی رد شد و چه وقت، ولی متنش را نمی‌بیند.

شرح کامل در [`docs/THREAT-MODEL.md`](docs/THREAT-MODEL.md) است و هر تصمیم، همراه
با گزینه‌هایی که کنار گذاشته شد، در [`docs/DECISIONS.md`](docs/DECISIONS.md) ثبت
شده است. این دو سند فعلاً فقط به انگلیسی‌اند.

### ساختار مخزن

| پوشه | چیست |
|---|---|
| [`host/`](host) | هستهۀ برنامهۀ فرستنده، به زبان Kotlin |
| [`receiver/`](receiver) | صفحه‌ها، به زبان TypeScript: وب‌اپ گیرنده، درون برنامهۀ اندرویدی گیرنده، و صفحه‌های فرستنده |
| [`receiver-apk/`](receiver-apk) | گیرنده به شکل برنامهۀ اندروید: پنجره‌ای دور همان صفحه‌ها |
| [`shell/`](shell) | بخش مشترک دو برنامهۀ اندروید: نمایش صفحه‌هایی که درون فایل نصب‌اند |
| [`bridge/`](bridge) | پل، به زبان TypeScript. یک پروتکل که هم روی Cloudflare Workers اجرا می‌شود و هم در یک کانتینر Node |
| [`docs/`](docs) | معماری، تصمیم‌ها، مدل تهدید، پل‌ها و وضعیت |

### ساخت

همه‌چیز را GitHub Actions می‌سازد و امضا می‌کند
([`build.yml`](.github/workflows/build.yml)). دستورهای اجرای آزمون‌ها و اثر انگشت
گواهی امضا در بخش انگلیسی همین صفحه آمده است.

### پروانه

`AGPL-3.0-only`، هم برای برنامه‌ها و هم برای پل. ابزاری که کدهای بانکی شما از آن
می‌گذرد باید کدش را بتوانید بخوانید. این پروانه هر کسی را که نسخهۀ تغییریافته‌ای
را میزبانی کند موظف می‌کند تغییرهایش را منتشر کند.

</div>
