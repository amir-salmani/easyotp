package ir.rhinocloud.easyotp.net

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Deposit outcomes and how they feed back into bridge health.
 *
 * The distinction these cover is easy to get wrong and expensive to get wrong: a
 * 4xx means the message was refused, a 5xx or a socket error means the bridge
 * failed. Counting a 4xx against a bridge would let one malformed message mark
 * every healthy bridge as broken.
 */
class BridgeClientTest {

    private val cf = Bridge("cf", "https://bridge.example.com")
    private val ir = Bridge("ir", "https://bridge.example.ir")

    private val boxId = "b".repeat(43)
    private val messageId = "m".repeat(32)
    private val sealed = SealedEnvelope(enc = ByteArray(32) { 1 }, ciphertext = ByteArray(48) { 2 })

    private class FakeConnection(
        url: String,
        private val code: Int,
        private val body: String,
        private val throwOnConnect: Boolean,
    ) : HttpURLConnection(URL(url)) {
        val sent = ByteArrayOutputStream()

        override fun connect() { if (throwOnConnect) throw IOException("blocked") }
        override fun disconnect() = Unit
        override fun usingProxy() = false
        override fun getOutputStream(): OutputStream {
            if (throwOnConnect) throw IOException("blocked")
            return sent
        }
        override fun getResponseCode(): Int {
            if (throwOnConnect) throw IOException("blocked")
            return code
        }
        override fun getInputStream(): InputStream = ByteArrayInputStream(body.toByteArray())
        override fun getErrorStream(): InputStream = ByteArrayInputStream(body.toByteArray())
    }

    data class Spec(val code: Int = 200, val body: String = "{}", val fails: Boolean = false)

    private class Harness(val client: BridgeClient, val health: BridgeHealth, val opened: List<FakeConnection>)

    private fun harness(
        vararg responses: Pair<Bridge, Spec>,
        slow: Bridge? = null,
        slowMillis: Long = 0,
    ): Harness {
        val byBase = responses.associate { it.first.baseUrl to it.second }
        val health = BridgeHealth(responses.map { it.first })
        val opened = CopyOnWriteArrayList<FakeConnection>()
        val client = BridgeClient(
            health = health,
            clock = { NOW },
            open = { url ->
                if (slow != null && url.startsWith(slow.baseUrl)) Thread.sleep(slowMillis)
                val spec = byBase.entries.first { url.startsWith(it.key) }.value
                FakeConnection(url, spec.code, spec.body, spec.fails).also { opened += it }
            },
        )
        return Harness(client, health, opened)
    }

    private fun Harness.deposit() = client.deposit(boxId, messageId, sealed)

    @Test
    fun `a message is left at every bridge, not just the first that answers`() {
        val h = harness(cf to Spec(), ir to Spec())
        assertEquals(DepositResult.Accepted(listOf("cf", "ir")), h.deposit())
        assertEquals(2, h.opened.size)
    }

    @Test
    fun `the request is the box url and the sealed envelope, and nothing else`() {
        val h = harness(cf to Spec())
        h.deposit()
        val connection = h.opened.single()
        assertEquals("https://bridge.example.com/v2/box/$boxId", connection.url.toString())
        val body = JSONObject(connection.sent.toString())
        assertEquals(setOf("v", "id", "enc", "ct"), body.keys().asSequence().toSet())
        assertEquals(2, body.getInt("v"))
        assertEquals(messageId, body.getString("id"))
        assertEquals(ReceiverSealer.base64UrlEncode(sealed.enc), body.getString("enc"))
        assertEquals(ReceiverSealer.base64UrlEncode(sealed.ciphertext), body.getString("ct"))
    }

    @Test
    fun `one working bridge is enough`() {
        val h = harness(cf to Spec(fails = true), ir to Spec())
        assertEquals(DepositResult.Accepted(listOf("ir")), h.deposit())
    }

    @Test
    fun `all bridges down reports unreachable so the message stays queued`() {
        // Must not be Rejected: that would mark the row undeliverable and drop a
        // message that a returning network would have carried fine.
        val h = harness(cf to Spec(fails = true), ir to Spec(fails = true))
        assertEquals(DepositResult.Unreachable, h.deposit())
    }

    @Test
    fun `a 4xx does not count against the bridge`() {
        val h = harness(
            cf to Spec(400, """{"error":"malformed"}"""),
            ir to Spec(400, """{"error":"malformed"}"""),
        )
        repeat(5) { h.deposit() }
        assertTrue(
            "a refused message must leave bridge health intact",
            h.health.snapshot().all { it.healthy },
        )
    }

    @Test
    fun `a 5xx does count against the bridge`() {
        val h = harness(cf to Spec(503), ir to Spec(503))
        repeat(5) { h.deposit() }
        assertTrue("a failing bridge must show as failing", h.health.snapshot().none { it.healthy })
    }

    @Test
    fun `a full bridge is the bridge failing, not the message`() {
        // 507 must leave the message queued for retry, and the other bridge
        // must still be enough on its own.
        val full = Spec(507, """{"error":"bridge_full"}""")
        assertEquals(DepositResult.Unreachable, harness(cf to full, ir to full).deposit())
        assertEquals(DepositResult.Accepted(listOf("ir")), harness(cf to full, ir to Spec()).deposit())
    }

    @Test
    fun `a refusal is reported with the bridge's reason code`() {
        val h = harness(
            cf to Spec(413, """{"error":"too_large"}"""),
            ir to Spec(fails = true),
        )
        assertEquals(DepositResult.Rejected("too_large"), h.deposit())
    }

    @Test
    fun `a 4xx that the bridge did not write is the bridge failing`() {
        // A CDN's block page or a misrouted 404 says nothing about the message.
        // Treating it as a refusal would give up on a deliverable message, and
        // counting it as healthy would hide a bridge that delivers nothing.
        val blocked = harness(cf to Spec(403, "<html>Access denied</html>"), ir to Spec(404, "{}"))
        repeat(5) { assertEquals(DepositResult.Unreachable, blocked.deposit()) }
        assertTrue(blocked.health.snapshot().none { it.healthy })
    }

    @Test
    fun `text from the other end never becomes a reason`() {
        // The reason is written to the outbox and the log, so only the
        // bridge's own short codes are ever accepted as one.
        val freeText = harness(cf to Spec(400, """{"error":"Your code is 4821"}"""))
        assertEquals(DepositResult.Unreachable, freeText.deposit())
    }

    @Test
    fun `a bridge that hangs does not hold up a message another bridge accepted`() {
        val h = harness(cf to Spec(), ir to Spec(), slow = ir, slowMillis = 4_000)
        val started = System.nanoTime()
        assertEquals(DepositResult.Accepted(listOf("cf")), h.deposit())
        val tookMillis = (System.nanoTime() - started) / 1_000_000
        assertTrue("waited $tookMillis ms for the slow bridge", tookMillis < 3_000)
    }

    private companion object {
        const val NOW = 1_700_000_000_000L
    }
}
