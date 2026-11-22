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
     * When several candidates appear, the shortest wins. Longer digit runs in an
     * OTP message are usually account or reference numbers, while the code itself
     * is the short one the reader is being asked to type.
     */
    fun extractCode(body: String): String? {
        val normalized = normalizeDigits(body)
        if (!isOtp(body)) return null
        return CODE.findAll(normalized)
            .map { it.groupValues[1] }
            .minByOrNull { it.length }
    }
}
