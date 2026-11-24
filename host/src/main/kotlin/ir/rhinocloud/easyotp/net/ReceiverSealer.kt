package ir.rhinocloud.easyotp.net

import com.google.crypto.tink.HybridEncrypt
import com.google.crypto.tink.KeysetHandle
import com.google.crypto.tink.RegistryConfiguration
import com.google.crypto.tink.hybrid.HpkePublicKey
import com.google.crypto.tink.util.Bytes

/** An HPKE envelope, split the way it travels: encapsulated key and ciphertext. */
data class SealedEnvelope(val enc: ByteArray, val ciphertext: ByteArray) {
    // Value semantics: data class would compare arrays by reference, which makes
    // every test assertion on an envelope silently wrong.
    override fun equals(other: Any?): Boolean =
        other is SealedEnvelope &&
            enc.contentEquals(other.enc) &&
            ciphertext.contentEquals(other.ciphertext)

    override fun hashCode(): Int = 31 * enc.contentHashCode() + ciphertext.contentHashCode()
}

/**
 * Seals a message to one Receiver's public key with HPKE (RFC 9180).
 *
 * The Receiver holds the private key and nobody else does, so every bridge and
 * every network in between carries bytes it cannot read (DECISIONS D16). That is
 * what makes a bridge inside Iran an acceptable path.
 *
 * The cipher suite must match the Receiver exactly -- X25519 + HKDF-SHA256 +
 * ChaCha20-Poly1305 -- and so must two settings that are easy to get wrong:
 *
 *  - **`Variant.NO_PREFIX`**. Tink's default `TINK` variant prepends a five-byte
 *    key-id prefix to the ciphertext. That is a Tink convention, not part of
 *    RFC 9180, and a standards-compliant implementation like hpke-js cannot open
 *    it. This single setting is the difference between interoperating and not.
 *  - **empty `contextInfo`**. Tink passes it as HPKE `info` during key schedule
 *    setup; the Receiver uses the hpke-js default, which is empty. A non-empty
 *    value on one side only produces a decrypt failure with no useful diagnostic.
 *
 * Both are covered by an end-to-end fixture: a unit test seals with this class,
 * and receiver/test/interop.spec.ts opens the result. A change to either side's
 * settings fails CI instead of shipping messages no Receiver can open.
 */
class ReceiverSealer(private val receiverPublicKey: ByteArray) {

    init {
        require(receiverPublicKey.size == X25519_PUBLIC_KEY_BYTES) {
            "receiver public key must be $X25519_PUBLIC_KEY_BYTES bytes, got ${receiverPublicKey.size}"
        }
    }

    private val encryptor: HybridEncrypt by lazy {
        val publicKey = HpkePublicKey.create(
            Hpke.PARAMETERS,
            Bytes.copyFrom(receiverPublicKey),
            /* idRequirement = */ null,
        )

        KeysetHandle.newBuilder()
            .addEntry(KeysetHandle.importKey(publicKey).withRandomId().makePrimary())
            .build()
            .getPrimitive(RegistryConfiguration.get(), HybridEncrypt::class.java)
    }

    /**
     * Seals a payload.
     *
     * Tink returns the encapsulated key concatenated with the ciphertext. They
     * travel as separate fields, and for X25519 the encapsulated key is
     * always exactly 32 bytes, so the split point is fixed rather than guessed.
     */
    fun seal(plaintext: ByteArray): SealedEnvelope {
        val output = encryptor.encrypt(plaintext, Hpke.EMPTY_CONTEXT_INFO)
        check(output.size > X25519_PUBLIC_KEY_BYTES) { "HPKE output shorter than its encapsulated key" }
        return SealedEnvelope(
            enc = output.copyOfRange(0, X25519_PUBLIC_KEY_BYTES),
            ciphertext = output.copyOfRange(X25519_PUBLIC_KEY_BYTES, output.size),
        )
    }

    companion object {
        const val X25519_PUBLIC_KEY_BYTES = 32

        fun fromBase64Url(key: String): ReceiverSealer = ReceiverSealer(base64UrlDecode(key))

        fun base64UrlDecode(value: String): ByteArray {
            val padded = value.replace('-', '+').replace('_', '/')
                .let { it + "=".repeat((4 - it.length % 4) % 4) }
            return java.util.Base64.getDecoder().decode(padded)
        }

        fun base64UrlEncode(bytes: ByteArray): String =
            java.util.Base64.getEncoder().withoutPadding().encodeToString(bytes)
                .replace('+', '-').replace('/', '_')
    }
}
