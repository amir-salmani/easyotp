package ir.rhinocloud.easyotp.pair

import ir.rhinocloud.easyotp.net.Hpke
import ir.rhinocloud.easyotp.net.HpkeKeyPair
import ir.rhinocloud.easyotp.net.ReceiverSealer
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The Host's pairing, run against a slot held in memory and a Receiver played
 * by this test. The Receiver's real code is checked against the same protocol
 * through the written-down vectors ([PairingVectorsTest]); this test is about
 * the order of the steps and what the Host does with noise.
 */
class HostPairingTest {

    /** One bridge's slot. Reads never wait, so the tests are quick. */
    private class Slot {
        val messages = CopyOnWriteArrayList<SlotMessage>()
        fun post(from: String, data: String) = messages.add(SlotMessage(messages.size + 1L, from, data))
    }

    private class Memory(private val down: Set<String> = emptySet()) : SlotTransport {
        val slots = HashMap<String, Slot>()

        @Synchronized
        fun slot(bridge: String) = slots.getOrPut(bridge) { Slot() }

        override fun post(bridge: String, slotId: String, body: String): Boolean {
            if (bridge in down) return false
            val json = JSONObject(body)
            slot(bridge).post(json.getString("from"), json.getString("data"))
            return true
        }

        override fun read(bridge: String, slotId: String, after: Long): SlotView? {
            if (bridge in down) return null
            return SlotView(1, slot(bridge).messages.filter { it.seq > after })
        }
    }

    private val bridges = listOf("one", "two")
    private val commands = Hpke.newKeyPair()
    private val commandBox = PairCodec.boxId(PairCodec.b64(ByteArray(32) { 3 }))

    private fun decode(data: String) = JSONObject(String(ReceiverSealer.base64UrlDecode(data)))

    private fun waitFor(slot: Slot, type: String): JSONObject {
        val deadline = System.currentTimeMillis() + 5_000
        while (System.currentTimeMillis() < deadline) {
            slot.messages.filter { it.from == "host" }.map { decode(it.data) }
                .firstOrNull { it.getString("t") == type }?.let { return it }
            Thread.sleep(10)
        }
        error("no $type")
    }

    private class FakeReceiver(val label: String) {
        val keys: HpkeKeyPair = Hpke.newKeyPair()
        val boxId: String = PairCodec.boxId(PairCodec.b64(ByteArray(32) { 9 }))
        val nonce: String = PairCodec.b64(ByteArray(16) { 5 })

        /** The offer as it goes in the slot, and its two sealed halves. */
        fun offerTo(oneTimeKey: String): Triple<String, String, String> {
            val body = JSONObject().put("pk", keys.publicKey).put("box", boxId).put("label", label).put("n", nonce)
            val sealed = ReceiverSealer.fromBase64Url(oneTimeKey).seal(body.toString().toByteArray())
            val enc = PairCodec.b64(sealed.enc)
            val ct = PairCodec.b64(sealed.ciphertext)
            return Triple(PairCodec.encode(JSONObject().put("t", "offer").put("enc", enc).put("ct", ct)), enc, ct)
        }
    }

    @Test
    fun `pairs, and both sides can draw the same picture`() {
        val memory = Memory()
        val pairing = HostPairing(bridges, memory, "12345678", "خانه", commands.publicKey, commandBox)
        val result = Executors.newSingleThreadExecutor().submit<PairedReceiver> { pairing.run() }

        val slot = memory.slot("two")
        val commit = waitFor(slot, "commit")
        val receiver = FakeReceiver("iPhone")
        // Noise first: anyone can write to a slot.
        slot.post("receiver", "not base64 json")
        slot.post("receiver", FakeReceiver("stranger").offerTo(Hpke.newKeyPair().publicKey).first)
        val (offer, enc, ct) = receiver.offerTo(commit.getString("e"))
        slot.post("receiver", offer)

        val paired = result.get(10, TimeUnit.SECONDS)
        assertEquals("iPhone", paired.label)
        assertEquals(receiver.keys.publicKey, paired.publicKey)
        assertEquals(receiver.boxId, paired.boxId)

        val reveal = waitFor(slot, "reveal")
        // The nonce revealed is the one committed to before the offer was seen.
        assertEquals(commit.getString("c"), PairCodec.commitment(reveal.getString("n")))
        assertEquals(PairCodec.offerId(enc, ct), reveal.getString("o"))
        assertEquals("خانه", reveal.getString("label"))

        // What the Receiver would compute from what it saw.
        val theirs = PairCodec.sas(
            "12345678", reveal.getString("n"), receiver.nonce, receiver.keys.publicKey, receiver.boxId,
            commit.getString("e"), reveal.getString("label"), "iPhone",
        )
        assertArrayEquals(theirs, paired.sas)

        // Only the Receiver that made the offer can read where to send commands.
        val channel = JSONObject(String(Hpke.open(receiver.keys, reveal.getString("enc"), reveal.getString("ct"))!!))
        assertEquals(commands.publicKey, channel.getString("pk"))
        assertEquals(commandBox, channel.getString("box"))
    }

    @Test
    fun `the nonce is not revealed before an offer opens`() {
        val memory = Memory()
        val pairing = HostPairing(bridges, memory, "12345678", "خانه", commands.publicKey, commandBox, timeoutMillis = 1_500)
        val result = Executors.newSingleThreadExecutor().submit<PairedReceiver> { pairing.run() }
        val slot = memory.slot("one")
        waitFor(slot, "commit")
        // An offer sealed to some other key: the bridge trying its own.
        slot.post("receiver", FakeReceiver("mallory").offerTo(Hpke.newKeyPair().publicKey).first)

        val failure = runCatching { result.get(10, TimeUnit.SECONDS) }.exceptionOrNull()?.cause
        assertTrue(failure is PairingFailed)
        assertEquals(PairingFailed.TIMEOUT, (failure as PairingFailed).reason)
        assertFalse(slot.messages.any { it.from == "host" && decode(it.data).getString("t") == "reveal" })
    }

    @Test
    fun `one bridge down does not stop a pairing`() {
        val memory = Memory(down = setOf("one"))
        val pairing = HostPairing(bridges, memory, "12345678", "خانه", commands.publicKey, commandBox)
        val result = Executors.newSingleThreadExecutor().submit<PairedReceiver> { pairing.run() }
        val slot = memory.slot("two")
        val commit = waitFor(slot, "commit")
        slot.post("receiver", FakeReceiver("iPad").offerTo(commit.getString("e")).first)
        assertEquals("iPad", result.get(10, TimeUnit.SECONDS).label)
    }

    @Test
    fun `no bridge at all is reported as unreachable`() {
        val pairing = HostPairing(bridges, Memory(down = bridges.toSet()), "12345678", "خانه", commands.publicKey, commandBox)
        val failure = runCatching { pairing.run() }.exceptionOrNull()
        assertEquals(PairingFailed.UNREACHABLE, (failure as PairingFailed).reason)
    }

    @Test
    fun `giving up ends the wait`() {
        val pairing = HostPairing(bridges, Memory(), "12345678", "خانه", commands.publicKey, commandBox)
        val result = Executors.newSingleThreadExecutor().submit<PairedReceiver> { pairing.run() }
        Thread.sleep(200)
        pairing.cancel()
        val failure = runCatching { result.get(5, TimeUnit.SECONDS) }.exceptionOrNull()?.cause
        assertEquals(PairingFailed.CANCELLED, (failure as PairingFailed).reason)
    }

    @Test
    fun `a code is eight digits`() {
        repeat(50) { assertTrue(Regex("^[0-9]{8}$").matches(HostPairing.newCode())) }
    }
}
