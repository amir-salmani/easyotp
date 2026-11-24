package ir.rhinocloud.easyotp.pair

import ir.rhinocloud.easyotp.net.Command
import ir.rhinocloud.easyotp.net.CommandInbox
import ir.rhinocloud.easyotp.net.Hpke
import ir.rhinocloud.easyotp.net.HpkeKeyPair
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import java.io.File

/**
 * The pairing, written down by the Receiver's code
 * (receiver/test/pairing-vectors.json) and recomputed here by the Host's.
 *
 * The two are separate implementations of one protocol. If they disagree on a
 * single byte, two honest people see different pictures and are told someone
 * is in the way. The Receiver has the same test against the same file
 * (receiver/test/vectors.spec.ts).
 */
class PairingVectorsTest {

    private val v = JSONObject(File("../receiver/test/pairing-vectors.json").readText())
    private val receiver = v.getJSONObject("receiver")
    private val oneTime = v.getJSONObject("oneTime").let { HpkeKeyPair(it.getString("publicKey"), it.getString("privateKey")) }
    private val offer = v.getJSONObject("offer")

    @Test
    fun `meets at the same slot and box`() {
        assertEquals(v.getString("slotId"), PairCodec.slotId(v.getString("code")))
        assertEquals(receiver.getString("boxId"), PairCodec.boxId(receiver.getString("boxKey")))
    }

    @Test
    fun `commits to the same nonce and names the same offer`() {
        assertEquals(v.getString("commitment"), PairCodec.commitment(v.getString("hostNonce")))
        assertEquals(v.getString("offerId"), PairCodec.offerId(offer.getString("enc"), offer.getString("ct")))
    }

    @Test
    fun `cuts a long name where the Receiver cuts it`() {
        assertEquals(v.getString("hostLabel"), PairCodec.cleanLabel(v.getString("rawLabel")))
    }

    @Test
    fun `opens the offer a Receiver sealed`() {
        val body = PairCodec.offerBody(Hpke.open(oneTime, offer.getString("enc"), offer.getString("ct"))!!)!!
        assertEquals(receiver.getString("publicKey"), body.publicKey)
        assertEquals(receiver.getString("boxId"), body.boxId)
        assertEquals(receiver.getString("label"), body.label)
        assertEquals(receiver.getString("nonce"), body.nonce)
    }

    @Test
    fun `draws the same picture`() {
        val sas = PairCodec.sas(
            code = v.getString("code"),
            hostNonce = v.getString("hostNonce"),
            receiverNonce = receiver.getString("nonce"),
            publicKey = receiver.getString("publicKey"),
            boxId = receiver.getString("boxId"),
            oneTimeKey = oneTime.publicKey,
            hostLabel = v.getString("hostLabel"),
            receiverLabel = receiver.getString("label"),
        )
        assertEquals(v.getString("sas"), PairCodec.b64(sas))
    }

    @Test
    fun `half an emoji is encoded as a browser encodes it`() {
        // A name cut by an older Receiver can end in half a character. The
        // browser hashes U+FFFD for it; so must this.
        val half = "a\uD83D"
        assertEquals(listOf(0x61, 0xEF, 0xBF, 0xBD), PairCodec.utf8(half).map { it.toInt() and 0xFF })
    }

    @Test
    fun `obeys a command a Receiver sealed, once`() {
        val c = v.getJSONObject("command")
        val keys = c.getJSONObject("keys").let { HpkeKeyPair(it.getString("publicKey"), it.getString("privateKey")) }
        val inbox = CommandInbox(keys)

        val command = inbox.accept(c.getString("id"), c.getString("enc"), c.getString("ct"))
        assertNotNull(command)
        assertEquals(Command.What.BUZZ, command!!.what)

        // The second bridge delivers the same command. The phone rings once.
        assertNull(inbox.accept(c.getString("id"), c.getString("enc"), c.getString("ct")))
    }

    @Test
    fun `refuses a command replayed under another id`() {
        val c = v.getJSONObject("command")
        val keys = c.getJSONObject("keys").let { HpkeKeyPair(it.getString("publicKey"), it.getString("privateKey")) }
        // A bridge that kept an old "ring" cannot make it new by renaming it.
        assertNull(CommandInbox(keys).accept("someOtherIdOfTheRightLength0000", c.getString("enc"), c.getString("ct")))
    }

    @Test
    fun `refuses a command sealed to another key`() {
        val c = v.getJSONObject("command")
        assertNull(CommandInbox(Hpke.newKeyPair()).accept(c.getString("id"), c.getString("enc"), c.getString("ct")))
        assertFalse(c.getString("enc").isEmpty())
    }
}
