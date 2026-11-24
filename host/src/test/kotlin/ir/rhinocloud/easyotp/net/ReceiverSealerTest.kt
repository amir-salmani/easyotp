package ir.rhinocloud.easyotp.net

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Sealing, plus generation of the cross-language interop fixture.
 *
 * The fixture is the point. Tink and hpke-js can both be individually correct and
 * still fail to interoperate over settings that produce no useful error -- the
 * Tink key-id prefix, or a mismatched HPKE `info`. Only a message sealed by one
 * and opened by the other proves it, so this test writes one and
 * receiver/test/interop.spec.ts opens it.
 */
class ReceiverSealerTest {

    /** Public half of receiver/test/interop-keys.ts. Test-only, valid nowhere. */
    private val receiverPublicKey = "cPBUlcXX9VZOze4ZSgxhSk3rUs3a1w92okcGQO2Xk04"

    private val sealer = ReceiverSealer.fromBase64Url(receiverPublicKey)

    @Test
    fun `encapsulated key is exactly one X25519 public key`() {
        // The envelope is split at a fixed offset, so a suite change that alters
        // this length would corrupt every message silently.
        val sealed = sealer.seal("hello".toByteArray())
        assertEquals(32, sealed.enc.size)
        assertTrue(sealed.ciphertext.isNotEmpty())
    }

    @Test
    fun `sealing twice never repeats an envelope`() {
        // HPKE picks a fresh ephemeral key per seal. Identical output would mean
        // a static sender key, making every message correlatable at a bridge.
        val a = sealer.seal("same plaintext".toByteArray())
        val b = sealer.seal("same plaintext".toByteArray())
        assertNotEquals(a, b)
        assertFalse(a.enc.contentEquals(b.enc))
    }

    @Test
    fun `a wrong-sized receiver key is rejected at construction`() {
        // Better to fail when the key is first used than to send messages
        // nothing can open.
        val error = runCatching { ReceiverSealer(ByteArray(31)) }.exceptionOrNull()
        assertTrue(error is IllegalArgumentException)
    }

    @Test
    fun `base64url round-trips without padding`() {
        val bytes = ByteArray(32) { it.toByte() }
        val encoded = ReceiverSealer.base64UrlEncode(bytes)
        assertTrue("must be url-safe", !encoded.contains('+') && !encoded.contains('/'))
        assertTrue("must be unpadded", !encoded.contains('='))
        assertTrue(bytes.contentEquals(ReceiverSealer.base64UrlDecode(encoded)))
    }

    /**
     * Writes the fixture the Receiver's test opens.
     *
     * A generator more than an assertion: the verification happens in
     * receiver/test/interop.spec.ts, which fails if this message cannot be
     * opened with the matching private key, or opens to different fields.
     */
    @Test
    fun `emit interop fixture`() {
        val plaintext = INTEROP_PAYLOAD.encode()
        val sealed = sealer.seal(plaintext)

        val json = JSONObject()
            .put("note", "Sealed by ReceiverSealerTest in the Host's unit tests.")
            .put("publicKey", receiverPublicKey)
            .put("id", INTEROP_PAYLOAD.id)
            .put("plaintext", String(plaintext))
            .put("enc", ReceiverSealer.base64UrlEncode(sealed.enc))
            .put("ct", ReceiverSealer.base64UrlEncode(sealed.ciphertext))
            // A status report is a second kind of payload with its own
            // encoder, so it is proven the same way.
            .put(
                "status",
                sealer.seal(INTEROP_STATUS.encode()).let { status ->
                    JSONObject()
                        .put("id", INTEROP_STATUS.id)
                        .put("plaintext", String(INTEROP_STATUS.encode()))
                        .put("enc", ReceiverSealer.base64UrlEncode(status.enc))
                        .put("ct", ReceiverSealer.base64UrlEncode(status.ciphertext))
                },
            )
            .toString(2)

        val out = File(System.getProperty("easyotp.fixtureDir") ?: "build/interop")
        out.mkdirs()
        File(out, "hpke-fixture.json").writeText(json + "\n")
    }

    private companion object {
        /**
         * A real message in miniature: Persian text, a code, a SIM label. Built
         * by the real encoder, so the fixture proves the fields as well as the
         * seal.
         */
        val INTEROP_PAYLOAD = Payload(
            id = Payload.wireId(ByteArray(32) { 7 }, "interop"),
            sim = "همراه اول",
            from = "+98200",
            body = "رمز یکبار مصرف: 4821",
            code = "4821",
            at = 1_700_000_000_000L,
        )

        /** A phone on battery whose network it cannot name: one null of each kind the Receiver must accept. */
        val INTEROP_STATUS = HostStatus(
            id = Payload.wireId(ByteArray(32) { 7 }, "interop-status"),
            at = 1_700_000_000_000L,
            every = 900,
            battery = 17,
            charging = false,
            net = null,
            pending = 2,
            ack = "theCommandThisAnswers0000000000",
        )
    }
}
