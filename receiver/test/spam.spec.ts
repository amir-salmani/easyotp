/** Sorting advertising out of the inbox. What must never happen is a code going missing. */
import { describe, expect, it } from "vitest";
import { DEFAULT_SPAM, isSpam, looksLikeAd, sort, withRule } from "../src/spam";

const sms = (body: string, code: string | null = null, from = "+98200") => ({ from, body, code });

describe("the guess", () => {
  it("knows the carriers' opt-out line, however it is written", () => {
    for (const tail of ["لغو11", "لغو ۱۱", "لغو=11", "لغو: ۱۱", "لغو ٢٢"]) {
      expect(looksLikeAd(sms(`فروش ویژه‌ی زمستانه شروع شد\n${tail}`)), tail).toBe(true);
    }
  });

  it("takes a sale with a link, and neither alone", () => {
    expect(looksLikeAd(sms("۵۰٪ تخفیف فقط امروز shop.example.ir/y"))).toBe(true);
    expect(looksLikeAd(sms("قبض شما آماده است: https://pay.example.ir/123"))).toBe(false);
    expect(looksLikeAd(sms("تخفیف عوارض برای خودروهای برقی تصویب شد"))).toBe(false);
  });

  it("never takes a message that carries a code", () => {
    // A shop's login code arrives with the shop's advertising around it.
    const body = "کد ورود شما: 48213\nجشنواره‌ی تخفیف: shop.example.ir\nلغو11";
    expect(looksLikeAd(sms(body, "48213"))).toBe(false);
    expect(isSpam(sms(body, "48213"), DEFAULT_SPAM)).toBe(false);
  });

  it("leaves a bank's notice alone", () => {
    expect(looksLikeAd(sms("برداشت 2,500,000 ریال از حساب 1234\nمانده 10,000,000\n03/09 14:20"))).toBe(false);
    expect(looksLikeAd(sms("لغو تراکنش شما انجام شد"))).toBe(false);
  });

  it("can be switched off", () => {
    expect(isSpam(sms("حراج\nلغو11"), { rules: {}, auto: false })).toBe(false);
  });
});

describe("what the person said about a sender", () => {
  it("hides everything from a sender marked spam, whatever case the name arrives in", () => {
    const settings = withRule(DEFAULT_SPAM, "SHOP-X", "spam");
    expect(sort(sms("سلام", null, "Shop-X "), settings)).toBe("spam-sender");
    expect(sort(sms("سلام", null, "other"), settings)).toBe("inbox");
  });

  it("protects a sender marked not spam from the guess", () => {
    const ad = sms("حراج بزرگ\nلغو11", null, "MyShop");
    expect(sort(ad, DEFAULT_SPAM)).toBe("spam-guess");
    expect(sort(ad, withRule(DEFAULT_SPAM, "MyShop", "ok"))).toBe("inbox");
  });

  it("goes back to the guess when the rule is cleared", () => {
    const blocked = withRule(DEFAULT_SPAM, "MyShop", "spam");
    expect(sort(sms("سلام", null, "MyShop"), withRule(blocked, "MyShop", null))).toBe("inbox");
  });
});
