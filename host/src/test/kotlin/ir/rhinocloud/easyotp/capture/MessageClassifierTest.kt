package ir.rhinocloud.easyotp.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Classification against the messages this product will actually see: Iranian
 * bank and service SMS, in Persian and English, with Persian digits.
 */
class MessageClassifierTest {

    @Test
    fun `persian digits normalise to ascii`() {
        // Iranian senders routinely use Persian digits. A matcher that only knows
        // 0-9 fails silently on a large share of exactly the messages that matter,
        // by classifying them routine rather than by erroring.
        assertEquals("1234", MessageClassifier.normalizeDigits("۱۲۳۴"))
        assertEquals("5678", MessageClassifier.normalizeDigits("٥٦٧٨"))
        assertEquals("code 4821", MessageClassifier.normalizeDigits("code ۴۸۲۱"))
    }

    @Test
    fun `a persian otp with persian digits is urgent`() {
        val body = "رمز یکبار مصرف: ۴۸۲۱۷۳"
        assertTrue(MessageClassifier.isOtp(body))
        assertEquals("482173", MessageClassifier.extractCode(body))
    }

    @Test
    fun `a persian confirmation code is urgent`() {
        assertTrue(MessageClassifier.isOtp("کد تایید شما: ۹۹۳۱"))
    }

    @Test
    fun `an english otp is urgent`() {
        val body = "Your verification code is 483920. Do not share it."
        assertTrue(MessageClassifier.isOtp(body))
        assertEquals("483920", MessageClassifier.extractCode(body))
    }

    @Test
    fun `marketing with a number is not urgent`() {
        // Iranian SIMs drown in these. Racing every one wastes bandwidth on a
        // metered connection for no benefit.
        assertFalse(MessageClassifier.isOtp("Sale! 50000 toman off your next order"))
        assertFalse(MessageClassifier.isOtp("تخفیف ویژه ۵۰۰۰۰ تومان"))
    }

    @Test
    fun `a keyword without any code is not urgent`() {
        assertFalse(MessageClassifier.isOtp("Your password was changed successfully"))
    }

    @Test
    fun `a bare number without a keyword is not urgent`() {
        assertFalse(MessageClassifier.isOtp("12345678"))
    }

    @Test
    fun `long digit runs are not mistaken for codes`() {
        // Card and account numbers must not be picked up as codes, or the app
        // would surface a card fragment as if it were something to type in.
        assertFalse(MessageClassifier.isOtp("Card 6037991234567890 was charged"))
    }

    @Test
    fun `the short candidate wins when a reference number is present`() {
        // Balance and reference numbers are longer than the code the reader is
        // being asked to type.
        val body = "Transaction 9912345678 - your code is 4821"
        assertEquals("4821", MessageClassifier.extractCode(body))
    }

    @Test
    fun `the number next to the keyword wins over a shorter amount`() {
        // The copy button must paste the code, not the price.
        assertEquals("48217365", MessageClassifier.extractCode("رمز پویا: 48217365 مبلغ 250000 ریال"))
        assertEquals("48217365", MessageClassifier.extractCode("رمز پویا: ۴۸۲۱۷۳۶۵ مبلغ ۲۵۰۰۰۰ ریال"))
    }

    @Test
    fun `the number next to the keyword wins over a year`() {
        assertEquals("482173", MessageClassifier.extractCode("کد تایید: 482173 تاریخ 1405/09/02"))
        assertEquals("482173", MessageClassifier.extractCode("Your code is 482173. Sent 2026 Nov 23"))
    }

    @Test
    fun `a non-otp message yields no code`() {
        assertNull(MessageClassifier.extractCode("Your delivery 12345 is on the way"))
    }

    @Test
    fun `classification is case insensitive`() {
        assertTrue(MessageClassifier.isOtp("YOUR OTP IS 5566"))
        assertTrue(MessageClassifier.isOtp("Your Code: 5566"))
    }

    @Test
    fun `an empty or tiny message never crashes`() {
        // This runs inside a broadcast receiver, where an exception would kill
        // capture for every subsequent message too.
        assertFalse(MessageClassifier.isOtp(""))
        assertFalse(MessageClassifier.isOtp("hi"))
        assertNull(MessageClassifier.extractCode(""))
    }

    // The same cases as receiver/test/spam.spec.ts: the Host decides whether
    // to wake a Receiver, the Receiver where to list the message, and the two
    // must not disagree.

    @Test
    fun `the carriers' opt-out line marks an advertisement, however it is written`() {
        for (tail in listOf("لغو11", "لغو ۱۱", "لغو=11", "لغو: ۱۱", "لغو ٢٢")) {
            assertTrue(tail, MessageClassifier.looksLikeAd("فروش ویژه‌ی زمستانه شروع شد\n$tail"))
        }
    }

    @Test
    fun `a sale needs a link beside it, and a link a sale`() {
        assertTrue(MessageClassifier.looksLikeAd("۵۰٪ تخفیف فقط امروز shop.example.ir/y"))
        assertFalse(MessageClassifier.looksLikeAd("قبض شما آماده است: https://pay.example.ir/123"))
        assertFalse(MessageClassifier.looksLikeAd("تخفیف عوارض برای خودروهای برقی تصویب شد"))
    }

    @Test
    fun `a message that carries a code is never an advertisement`() {
        // A shop's login code arrives with the shop's advertising around it.
        // Staying quiet about it would be the one failure that matters.
        assertFalse(MessageClassifier.looksLikeAd("کد ورود شما: 48213\nجشنواره‌ی تخفیف: shop.example.ir\nلغو11"))
    }

    @Test
    fun `a bank's notice is not an advertisement`() {
        assertFalse(MessageClassifier.looksLikeAd("برداشت 2,500,000 ریال از حساب 1234\nمانده 10,000,000\n03/09 14:20"))
        assertFalse(MessageClassifier.looksLikeAd("لغو تراکنش شما انجام شد"))
    }
}
