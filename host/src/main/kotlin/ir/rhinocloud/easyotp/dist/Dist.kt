package ir.rhinocloud.easyotp.dist

import com.google.crypto.tink.subtle.Ed25519Verify
import ir.rhinocloud.easyotp.net.ReceiverSealer
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.File
import java.util.zip.GZIPInputStream

/** A file the Host checked and may use. */
class Verified(val kind: String, val version: Long, val core: Int, val payload: ByteArray)

/**
 * Checking what arrives from the bridges before trusting it (DECISIONS D32).
 *
 * The bridge list and the Host's screens are signed on the maintainer's
 * machine. The public key is compiled in here, so a bridge can withhold a
 * file but not alter one, and not pass an old one off as new: the kind and
 * the version are part of what is signed. The format is `receiver/src/dist.ts`.
 */
object Dist {

    const val PUBLIC_KEY = "NOUSVubm1JMqUKtlPPc8UyjnPawVxLc_mVOEqPwejpg"

    /** The payload of a correctly signed file of this kind, or null. Never says why. */
    fun verify(envelope: String, kind: String, publicKey: String = PUBLIC_KEY): Verified? = runCatching {
        val e = JSONObject(envelope)
        if (e.getInt("v") != 1 || e.getString("kind") != kind) return null
        val version = e.getLong("version")
        val core = e.getInt("core")
        val payload = e.getString("payload")
        val signed = "easyotp/dist/v1\n$kind\n$version\n$core\n$payload".toByteArray()
        Ed25519Verify(ReceiverSealer.base64UrlDecode(publicKey)).verify(ReceiverSealer.base64UrlDecode(e.getString("sig")), signed)
        Verified(kind, version, core, ReceiverSealer.base64UrlDecode(payload))
    }.getOrNull()

    /** The bridges a signed list names. Null unless every one is an https address. */
    fun bridgesOf(payload: ByteArray): List<Pair<String, String>>? = runCatching {
        val array = JSONObject(String(payload)).getJSONArray("bridges")
        val list = (0 until array.length()).map { array.getJSONObject(it).let { b -> b.getString("id") to b.getString("baseUrl").trimEnd('/') } }
        list.takeIf { it.isNotEmpty() && it.all { (id, url) -> id.isNotBlank() && url.startsWith("https://") && !url.contains(' ') } }
    }.getOrNull()

    /**
     * Writes a screen bundle's files under [dir]. False, with nothing kept,
     * if any path in it would land outside [dir].
     */
    fun unpack(payload: ByteArray, dir: File): Boolean {
        val files = runCatching {
            JSONObject(String(GZIPInputStream(ByteArrayInputStream(payload)).readBytes())).getJSONObject("files")
        }.getOrNull() ?: return false
        val root = dir.canonicalFile
        val out = mutableListOf<Pair<File, ByteArray>>()
        for (name in files.keys()) {
            val target = File(root, name).canonicalFile
            if (!target.path.startsWith(root.path + File.separator)) return false
            out += target to ReceiverSealer.base64UrlDecode(files.getString(name))
        }
        if (out.none { it.first.name == "host.html" }) return false
        root.mkdirs()
        out.forEach { (file, bytes) ->
            file.parentFile?.mkdirs()
            file.writeBytes(bytes)
        }
        return true
    }
}
