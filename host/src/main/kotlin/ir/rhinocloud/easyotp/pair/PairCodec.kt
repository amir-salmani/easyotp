package ir.rhinocloud.easyotp.pair

import ir.rhinocloud.easyotp.net.ReceiverSealer
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.CharBuffer
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest

/** What a Receiver offers during pairing, once its seal is opened. */
data class OfferBody(val publicKey: String, val boxId: String, val label: String, val nonce: String)

/**
 * Everything in a pairing that both sides must compute identically.
 *
 * Each function here has a twin in receiver/src/pairing.ts or ids.ts, and
 * receiver/test/pairing-vectors.json pins the two together: a test on each side
 * recomputes the same file. A change here that is not made there shows two
 * people different pictures, which reads to them as an attack.
 */
object PairCodec {

    private val KEY_SHAPE = Regex("^[A-Za-z0-9_-]{43}$")
    private val NONCE_SHAPE = Regex("^[A-Za-z0-9_-]{22,43}$")
    private val B64URL = Regex("^[A-Za-z0-9_-]+$")
    private val CONTROL = Regex("[\\u0000-\\u001f\\u007f\\u2028\\u2029]")
    private const val MAX_LABEL = 40

    fun b64(bytes: ByteArray): String = ReceiverSealer.base64UrlEncode(bytes)

    /**
     * UTF-8 the way a browser's TextEncoder does it: half of a surrogate pair
     * becomes U+FFFD. Kotlin's own encoder writes `?` instead, and one byte of
     * difference in a name is a different picture.
     */
    fun utf8(text: String): ByteArray {
        val encoder = Charsets.UTF_8.newEncoder()
            .onMalformedInput(CodingErrorAction.REPLACE)
            .onUnmappableCharacter(CodingErrorAction.REPLACE)
            .replaceWith(byteArrayOf(0xEF.toByte(), 0xBF.toByte(), 0xBD.toByte()))
        val out: ByteBuffer = encoder.encode(CharBuffer.wrap(text))
        return ByteArray(out.remaining()).also { out.get(it) }
    }

    fun sha256(vararg parts: ByteArray): ByteArray =
        MessageDigest.getInstance("SHA-256").apply { parts.forEach(::update) }.digest()

    /** Where the two sides meet, from the code one person reads to the other. */
    fun slotId(code: String): String = b64(sha256(utf8("easyotp/pair-slot/v1"), utf8(code)))

    /** The box a key opens. Must match bridge/src/ids.ts. */
    fun boxId(boxKey: String): String =
        b64(sha256(ReceiverSealer.base64UrlDecode(boxKey), utf8("easyotp/box-id/v2")))

    fun commitment(hostNonce: String): String =
        b64(sha256(utf8("easyotp/pair-commit/v1"), ReceiverSealer.base64UrlDecode(hostNonce)))

    /** Which offer a reveal answers. */
    fun offerId(enc: String, ct: String): String = b64(sha256(utf8("easyotp/pair-offer/v1"), utf8("$enc\n$ct")))

    /**
     * The 32 bytes both pictures are drawn from. Every field on its own line,
     * and names in base64 so a name cannot contain a line break.
     */
    fun sas(
        code: String,
        hostNonce: String,
        receiverNonce: String,
        publicKey: String,
        boxId: String,
        oneTimeKey: String,
        hostLabel: String,
        receiverLabel: String,
    ): ByteArray = sha256(
        utf8(
            listOf(
                "easyotp/pair-sas/v2", code, hostNonce, receiverNonce, publicKey, boxId, oneTimeKey,
                b64(utf8(hostLabel)), b64(utf8(receiverLabel)),
            ).joinToString("\n"),
        ),
    )

    /** Names are shown to a person: short, no control characters, never half a character. */
    fun cleanLabel(value: String?): String {
        val cut = (value ?: "").replace(CONTROL, "").take(MAX_LABEL)
        return if (cut.isNotEmpty() && cut.last().isHighSurrogate()) cut.dropLast(1) else cut
    }

    /** A pairing message as it sits in a slot: base64url of its JSON. */
    fun encode(message: JSONObject): String = b64(utf8(message.toString()))

    fun commit(commitment: String, oneTimeKey: String): JSONObject =
        JSONObject().put("t", "commit").put("c", commitment).put("e", oneTimeKey)

    fun reveal(hostNonce: String, label: String, offerId: String, enc: String, ct: String): JSONObject =
        JSONObject().put("t", "reveal").put("n", hostNonce).put("label", label).put("o", offerId)
            .put("enc", enc).put("ct", ct)

    /** The two sealed halves of an offer, or null if this is not an offer. Anyone can write to a slot. */
    fun offerOf(data: String): Pair<String, String>? = runCatching {
        val m = JSONObject(String(ReceiverSealer.base64UrlDecode(data), Charsets.UTF_8))
        if (m.optString("t") != "offer") return null
        val enc = m.optString("enc")
        val ct = m.optString("ct")
        if (KEY_SHAPE.matches(enc) && B64URL.matches(ct)) enc to ct else null
    }.getOrNull()

    fun offerBody(plaintext: ByteArray): OfferBody? = runCatching {
        val m = JSONObject(String(plaintext, Charsets.UTF_8))
        val pk = m.optString("pk")
        val box = m.optString("box")
        val n = m.optString("n")
        if (!KEY_SHAPE.matches(pk) || !KEY_SHAPE.matches(box) || !NONCE_SHAPE.matches(n)) return null
        // A label that is missing or not text is an empty one, as on the Receiver.
        val label = (m.opt("label") as? String).let(::cleanLabel)
        OfferBody(pk, box, label, n)
    }.getOrNull()
}
