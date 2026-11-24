package ir.rhinocloud.easyotp.service

/**
 * Whether this phone will send an SMS because a Receiver asked (DECISIONS D31).
 *
 * Reading a SIM's messages and sending as that SIM are different powers. A
 * lost Receiver that can read sees codes; one that can send can answer a
 * bank, subscribe to a paid service, or write to anyone as the SIM's owner.
 * So sending is refused unless every rule here holds, and the rules are kept
 * in one place, without Android in them, so each can be tested.
 */
object SendPolicy {

    /** Every reason a send is refused. Sent back to the Receiver as is, so never free text. */
    const val NOT_ALLOWED = "not_allowed"
    const val STALE = "stale"
    const val EMPTY = "empty"
    const val TOO_LONG = "too_long"
    const val STRANGER = "stranger"
    const val TOO_MANY = "too_many"
    const val NO_SIM = "no_sim"
    const val NO_PERMISSION = "no_permission"
    const val FAILED = "failed"
    /** A decline that found no such call ringing: it ended, or this is another call. */
    const val NO_CALL = "no_call"

    /** About three SMS of Persian text. A reply, not a letter. */
    const val MAX_CHARS = 200

    /** Per Receiver, in any twenty-four hours. Each one spends the SIM's credit. */
    const val DAILY_CAP = 20

    /** A command older or newer than this against the phone's clock is not obeyed. */
    const val FRESH_MILLIS = 10 * 60 * 1000L

    /** A number may be written to only if it wrote or called this SIM within this long. */
    const val KNOWN_MILLIS = 30L * 24 * 60 * 60 * 1000

    /**
     * @param allowed the owner switched sending on for this Receiver.
     * @param lastHeardFrom when [to] last wrote to or called this SIM, or null if it never did.
     * @param sentAt when this Receiver's earlier sends happened.
     * @return null to send, or the reason not to.
     */
    fun refusal(
        allowed: Boolean,
        now: Long,
        commandAt: Long,
        to: String?,
        text: String?,
        lastHeardFrom: Long?,
        sentAt: List<Long>,
    ): String? = when {
        !allowed -> NOT_ALLOWED
        // A sealed command kept by a bridge must not be something that can be
        // played to the phone next week.
        kotlin.math.abs(now - commandAt) > FRESH_MILLIS -> STALE
        to.isNullOrBlank() || text.isNullOrBlank() -> EMPTY
        text.length > MAX_CHARS -> TOO_LONG
        // Only an answer: never a first message to a number of the Receiver's choosing.
        lastHeardFrom == null || now - lastHeardFrom > KNOWN_MILLIS -> STRANGER
        sentAt.count { now - it < 24 * 60 * 60 * 1000L } >= DAILY_CAP -> TOO_MANY
        else -> null
    }
}
