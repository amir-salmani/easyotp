package ir.rhinocloud.easyotp.net

import com.google.crypto.tink.HybridDecrypt
import com.google.crypto.tink.InsecureSecretKeyAccess
import com.google.crypto.tink.KeysetHandle
import com.google.crypto.tink.RegistryConfiguration
import com.google.crypto.tink.hybrid.HpkeParameters
import com.google.crypto.tink.hybrid.HpkePrivateKey
import com.google.crypto.tink.hybrid.HpkePublicKey
import com.google.crypto.tink.hybrid.HybridConfig
import com.google.crypto.tink.subtle.X25519
import com.google.crypto.tink.util.Bytes
import com.google.crypto.tink.util.SecretBytes

/** An X25519 key pair, both halves base64url as they are stored and sent. */
data class HpkeKeyPair(val publicKey: String, val privateKey: String)

/**
 * The Host's own keys, and opening what was sealed to them.
 *
 * A Host mostly seals ([ReceiverSealer]). It opens in two places: the offer a
 * Receiver sends during pairing, sealed to a key made for that one pairing, and
 * the commands a paired Receiver sends afterwards (DECISIONS D24, D26).
 *
 * The suite and its two awkward settings are the ones [ReceiverSealer]
 * explains. They are stated once, here, and both classes use them.
 */
object Hpke {

    val PARAMETERS: HpkeParameters by lazy {
        HybridConfig.register()
        HpkeParameters.builder()
            .setKemId(HpkeParameters.KemId.DHKEM_X25519_HKDF_SHA256)
            .setKdfId(HpkeParameters.KdfId.HKDF_SHA256)
            .setAeadId(HpkeParameters.AeadId.CHACHA20_POLY1305)
            .setVariant(HpkeParameters.Variant.NO_PREFIX)
            .build()
    }

    /** Must stay empty to match the Receiver; see [ReceiverSealer]. */
    val EMPTY_CONTEXT_INFO = ByteArray(0)

    fun newKeyPair(): HpkeKeyPair {
        val private = X25519.generatePrivateKey()
        return HpkeKeyPair(
            publicKey = ReceiverSealer.base64UrlEncode(X25519.publicFromPrivate(private)),
            privateKey = ReceiverSealer.base64UrlEncode(private),
        )
    }

    /**
     * Opens what was sealed to [keys].
     *
     * @return null if it does not open. Why is deliberately not reported: a
     *   detailed failure would tell whoever is guessing how close they came.
     */
    fun open(keys: HpkeKeyPair, enc: String, ct: String): ByteArray? = runCatching {
        val public = HpkePublicKey.create(
            PARAMETERS,
            Bytes.copyFrom(ReceiverSealer.base64UrlDecode(keys.publicKey)),
            /* idRequirement = */ null,
        )
        val private = HpkePrivateKey.create(
            public,
            SecretBytes.copyFrom(ReceiverSealer.base64UrlDecode(keys.privateKey), InsecureSecretKeyAccess.get()),
        )
        val decryptor = KeysetHandle.newBuilder()
            .addEntry(KeysetHandle.importKey(private).withRandomId().makePrimary())
            .build()
            .getPrimitive(RegistryConfiguration.get(), HybridDecrypt::class.java)
        // Tink takes the encapsulated key and the ciphertext as one run of bytes.
        decryptor.decrypt(
            ReceiverSealer.base64UrlDecode(enc) + ReceiverSealer.base64UrlDecode(ct),
            EMPTY_CONTEXT_INFO,
        )
    }.getOrNull()
}
