package ir.rhinocloud.easyotp.capture

/**
 * Decides whether a message carries a one-time code, and finds the code.
 *
 * The Receiver uses the code to offer one tap to copy it, which is the
 * difference between reading digits off a screen and pasting them.
 *
 * The bias is deliberately toward false positives. Treating an ordinary message
 * as a code costs a copy button nobody presses; missing a real code makes the
 * reader hunt for it while a login times out. There is no symmetry between those.
 */
object MessageClassifier {

    /**
     * Persian and Arabic-Indic digits normalised to ASCII.
     *
     * Iranian banks and government services routinely send codes in Persian
     * digits. A matcher that only knows 0-9 silently fails on a large share of
     * exactly the messages this product exists to forward -- and fails quietly,
     * by classifying them as routine rather than by erroring.
     */
    private const val PERSIAN_ZERO = '۰'
    private const val ARABIC_ZERO = '٠'

    fun normalizeDigits(text: String): String = buildString(text.length) {
        for (ch in text) {
            append(
                when (ch) {
                    in PERSIAN_ZERO..PERSIAN_ZERO + 9 -> '0' + (ch - PERSIAN_ZERO)
                    in ARABIC_ZERO..ARABIC_ZERO + 9 -> '0' + (ch - ARABIC_ZERO)
                    else -> ch
                },
            )
        }
    }

    /** English and Persian markers. Persian terms are what Iranian senders actually use. */
    private val KEYWORDS = listOf(
        // English
        "otp", "code", "passcode", "password", "verification", "verify",
        "one-time", "one time", "2fa", "authentication", "pin",
        // Persian: code / password / one-time password / confirmation / activation
        "کد",                       // kod
        "رمز",                 // ramz
        "یکبارمصرف", // yekbarmasraf
        "تایید",     // taeed (confirm)
        "فعالسازی", // faalsazi (activation)
        "ورود",           // vorood (login)
    )

    /**
     * Codes are 4 to 8 digits. Bounded on both sides so that account numbers,
     * card fragments, amounts and dates do not read as codes.
     */
    private val CODE = Regex("(?<![0-9])([0-9]{4,8})(?![0-9])")

    fun isOtp(body: String): Boolean {
        val normalized = normalizeDigits(body)
        if (!CODE.containsMatchIn(normalized)) return false
        val haystack = normalized.lowercase()
        return KEYWORDS.any { haystack.contains(it) }
    }

    /**
     * The most likely code in the message, or null.
     *
     * The candidate nearest a keyword wins: "رمز پویا: 48217365 مبلغ 250000"
     * means the first number, though the second is shorter. Between candidates
     * equally near, the shorter wins, since longer runs in such a message are
     * usually account or reference numbers.
     */
    fun extractCode(body: String): String? {
        if (!isOtp(body)) return null
        val haystack = normalizeDigits(body).lowercase()
        val keywords = KEYWORDS.flatMap { keyword ->
            Regex.fromLiteral(keyword).findAll(haystack).map { it.range }.toList()
        }
        return CODE.findAll(haystack)
            .minWithOrNull(
                compareBy<MatchResult>(
                    { candidate -> keywords.minOfOrNull { gap(it, candidate.range) } ?: Int.MAX_VALUE },
                    { it.value.length },
                ),
            )
            ?.value
    }

    /**
     * "لغو۱۱", "لغو 11", "لغو=11": how to stop receiving. Iranian carriers
     * require it on bulk advertising, and nothing else carries it.
     */
    private val OPT_OUT = Regex("لغو\\s*[=:：]?\\s*[0-9]{1,4}(?![0-9])")
    // ASCII lookarounds, not \\b: Java counts a Persian letter as part of a
    // word and JavaScript does not, and the two sides must agree.
    private val LINK = Regex("https?://|www\\.|(?<![a-z0-9-])[a-z0-9-]+\\.(ir|com|net|org|app|shop|co)(?![a-z0-9])")
    private val OFFER = Regex("تخفیف|جشنواره|فروش ویژه|قرعه.?کشی|جایزه|رایگان|هدیه|پیشنهاد ویژه|کد تخفیف|فرصت محدود|همین حالا بخر|(?<![a-z])off(?![a-z])|%|٪")

    /**
     * Whether a message reads as advertising. The Host forwards it all the
     * same; this only decides whether a bridge wakes a sleeping Receiver for
     * it (DECISIONS D30). Never true for a message that carries a code.
     *
     * The same rule as `looksLikeAd` in receiver/src/spam.ts, which sorts such
     * a message under Spam. The two should agree, or a person is woken for
     * something their own screen then files as an advertisement.
     */
    fun looksLikeAd(body: String): Boolean {
        if (extractCode(body) != null) return false
        val text = normalizeDigits(body).lowercase()
        return OPT_OUT.containsMatchIn(text) || (LINK.containsMatchIn(text) && OFFER.containsMatchIn(text))
    }

    /** Characters between two ranges; zero if they touch or overlap. */
    private fun gap(a: IntRange, b: IntRange): Int = when {
        a.last < b.first -> b.first - a.last - 1
        b.last < a.first -> a.first - b.last - 1
        else -> 0
    }
}
