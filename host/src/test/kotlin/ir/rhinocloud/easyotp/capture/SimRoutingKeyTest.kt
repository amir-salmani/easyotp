package ir.rhinocloud.easyotp.capture

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The key a SIM's route is stored under. If two SIMs ever share one, one
 * person's codes are sealed to the other person's Receiver.
 */
class SimRoutingKeyTest {

    @Test
    fun `the iccid is the key where android reveals it`() {
        assertEquals("8998100000000000001", SimRegistry.routingKey("8998100000000000001", 3))
    }

    @Test
    fun `two sims that both hide their iccid still get different keys`() {
        // Android 10 and later give an ordinary app an empty ICCID for every SIM.
        val first = SimRegistry.routingKey("", 1)
        val second = SimRegistry.routingKey("", 2)
        assertNotEquals(first, second)
        assertTrue(first.isNotBlank() && second.isNotBlank())
    }

    @Test
    fun `a missing or blank iccid never becomes a blank key`() {
        assertEquals("sub:7", SimRegistry.routingKey(null, 7))
        assertEquals("sub:7", SimRegistry.routingKey("   ", 7))
    }

    @Test
    fun `a subscription key cannot be mistaken for an iccid`() {
        // An ICCID is digits. The prefix keeps the two kinds of key apart.
        assertTrue(SimRegistry.routingKey("", 8998).startsWith("sub:"))
    }
}
