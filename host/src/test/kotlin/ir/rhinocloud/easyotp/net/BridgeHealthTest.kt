package ir.rhinocloud.easyotp.net

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * What the app believes about each bridge. On an unattended phone this is the
 * only warning that a bridge has stopped working, so it has to react quickly
 * and must not be fooled by timeouts.
 */
class BridgeHealthTest {

    private val cf = Bridge("cf", "https://bridge.example.com")
    private val ir = Bridge("ir", "https://bridge.example.ir")

    private fun health() = BridgeHealth(listOf(cf, ir))

    private fun fail(h: BridgeHealth, id: String, times: Int) {
        repeat(times) { h.record(id, success = false, latencyMillis = 10_000, now = NOW) }
    }

    private fun succeed(h: BridgeHealth, id: String, latency: Long = 100, times: Int = 1) {
        repeat(times) { h.record(id, success = true, latencyMillis = latency, now = NOW) }
    }

    private fun BridgeHealth.status(id: String) = snapshot().first { it.id == id }

    @Test
    fun `a blocked bridge shows as failing within a few attempts`() {
        // Iranian filtering changes on the scale of minutes. Needing dozens of
        // failures to notice would hide an outage for most of its length.
        val h = health()
        succeed(h, "ir")
        fail(h, "cf", times = 3)
        assertFalse(h.status("cf").healthy)
        assertTrue(h.status("ir").healthy)
    }

    @Test
    fun `a recovered bridge shows as working again`() {
        val h = health()
        fail(h, "cf", times = 10)
        assertFalse(h.status("cf").healthy)
        succeed(h, "cf", times = 5)
        assertTrue(h.status("cf").healthy)
    }

    @Test
    fun `an untried bridge is not reported as broken`() {
        val h = health()
        assertTrue(h.snapshot().all { it.healthy && it.attempts == 0L })
    }

    @Test
    fun `failure latency does not make a dead bridge look merely slow`() {
        // Timeouts must not be folded into the latency average.
        val h = health()
        succeed(h, "cf", latency = 50, times = 3)
        val before = h.status("cf").latencyMillis
        fail(h, "cf", times = 3)
        assertEquals("timeouts must not shift latency", before, h.status("cf").latencyMillis)
    }

    @Test
    fun `no bridge is ever dropped, however badly it does`() {
        // A bridge missing from the list can never be tried again, so a
        // passing failure would become permanent.
        val h = health()
        fail(h, "cf", times = 50)
        assertEquals(listOf(cf, ir), h.all())
    }

    @Test
    fun `an outcome for an unknown bridge is ignored`() {
        val h = health()
        h.record("gone", success = false, latencyMillis = 1, now = NOW)
        assertEquals(2, h.snapshot().size)
    }

    @Test
    fun `at least one bridge is required`() {
        assertTrue(runCatching { BridgeHealth(emptyList()) }.exceptionOrNull() is IllegalArgumentException)
    }

    private companion object {
        const val NOW = 1_700_000_000_000L
    }
}
