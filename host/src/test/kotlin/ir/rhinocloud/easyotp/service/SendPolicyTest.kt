package ir.rhinocloud.easyotp.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * When this phone will send an SMS for a Receiver. Each test is one way a lost
 * or hostile Receiver, or a bridge replaying what it kept, could otherwise
 * write as the SIM's owner.
 */
class SendPolicyTest {

    private val now = 1_800_000_000_000L
    private val hour = 60 * 60 * 1000L

    private fun refusal(
        allowed: Boolean = true,
        commandAt: Long = now,
        to: String? = "+989120000000",
        text: String? = "باشه",
        lastHeardFrom: Long? = now - hour,
        sentAt: List<Long> = emptyList(),
    ) = SendPolicy.refusal(allowed, now, commandAt, to, text, lastHeardFrom, sentAt)

    @Test
    fun `an answer to someone who wrote is sent`() {
        assertNull(refusal())
    }

    @Test
    fun `a Receiver the owner did not allow cannot send`() {
        // Off is the state every Receiver starts in.
        assertEquals(SendPolicy.NOT_ALLOWED, refusal(allowed = false))
    }

    @Test
    fun `an old command is not obeyed`() {
        // A bridge keeps sealed commands for two days. One of them must not
        // be an SMS waiting to be sent whenever it is delivered again.
        assertEquals(SendPolicy.STALE, refusal(commandAt = now - 11 * 60 * 1000))
        assertEquals(SendPolicy.STALE, refusal(commandAt = now + 11 * 60 * 1000))
        assertNull(refusal(commandAt = now - 9 * 60 * 1000))
    }

    @Test
    fun `a number that never contacted this SIM cannot be written to`() {
        // Only an answer. Not a premium number, not a stranger, not a bank's command line.
        assertEquals(SendPolicy.STRANGER, refusal(lastHeardFrom = null))
        assertEquals(SendPolicy.STRANGER, refusal(lastHeardFrom = now - 31 * 24 * hour))
        assertNull(refusal(lastHeardFrom = now - 29 * 24 * hour))
    }

    @Test
    fun `a day has a limit`() {
        val full = List(SendPolicy.DAILY_CAP) { now - it * 60_000L }
        assertEquals(SendPolicy.TOO_MANY, refusal(sentAt = full))
        // Yesterday's do not count against today.
        assertNull(refusal(sentAt = List(SendPolicy.DAILY_CAP) { now - 25 * hour }))
        assertNull(refusal(sentAt = full.drop(1)))
    }

    @Test
    fun `nothing and too much are both refused`() {
        assertEquals(SendPolicy.EMPTY, refusal(text = " "))
        assertEquals(SendPolicy.EMPTY, refusal(to = null))
        assertEquals(SendPolicy.TOO_LONG, refusal(text = "x".repeat(SendPolicy.MAX_CHARS + 1)))
        assertNull(refusal(text = "x".repeat(SendPolicy.MAX_CHARS)))
    }

    @Test
    fun `not being allowed is said before anything else`() {
        // A Receiver that may not send learns nothing about who has written to this SIM.
        assertEquals(SendPolicy.NOT_ALLOWED, refusal(allowed = false, lastHeardFrom = null, text = ""))
    }
}
