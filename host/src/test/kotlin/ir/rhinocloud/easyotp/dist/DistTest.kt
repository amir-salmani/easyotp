package ir.rhinocloud.easyotp.dist

import ir.rhinocloud.easyotp.net.ReceiverSealer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.nio.file.Files
import java.util.zip.GZIPOutputStream

/**
 * What the Host takes from the bridges (DECISIONS D32). The files checked
 * here are the real ones the bridges serve, signed on the maintainer's
 * machine, so this also proves they were signed with the key the APK carries.
 */
class DistTest {

    private fun served(name: String) = File("../bridge/dist-files/$name.json").readText()

    @Test
    fun `the bridge list the bridges serve is signed with the key the APK carries`() {
        val list = Dist.verify(served("bridges"), "bridges")
        assertNotNull(list)
        val bridges = Dist.bridgesOf(list!!.payload)!!
        assertTrue(bridges.all { (_, url) -> url.startsWith("https://") })
        assertTrue(bridges.any { (id, _) -> id == "cfworker" })
    }

    @Test
    fun `the screens the bridges serve are signed, and unpack`() {
        val ui = Dist.verify(served("host-ui"), "host-ui")!!
        assertTrue(ui.core <= Screens.CORE)
        val dir = Files.createTempDirectory("ui").toFile()
        assertTrue(Dist.unpack(ui.payload, dir))
        assertTrue(File(dir, "host.html").isFile)
        dir.deleteRecursively()
    }

    @Test
    fun `a changed byte, a renamed kind or a changed version is refused`() {
        val good = JSONObject(served("bridges"))
        val payload = good.getString("payload")
        // A bridge that edits the list.
        assertNull(Dist.verify(JSONObject(good.toString()).put("payload", payload.dropLast(1) + if (payload.last() == 'A') "B" else "A").toString(), "bridges"))
        // A bridge that serves an old file as new.
        assertNull(Dist.verify(JSONObject(good.toString()).put("version", good.getLong("version") + 1).toString(), "bridges"))
        // A bridge that passes one kind of file off as another.
        assertNull(Dist.verify(good.toString(), "host-ui"))
        // A file signed with another key.
        assertNull(Dist.verify(good.toString(), "bridges", publicKey = ReceiverSealer.base64UrlEncode(ByteArray(32) { 1 })))
    }

    @Test
    fun `a list with a plain-http bridge, or none at all, is not taken`() {
        assertNull(Dist.bridgesOf("""{"bridges":[{"id":"a","baseUrl":"http://x.test"}]}""".toByteArray()))
        assertNull(Dist.bridgesOf("""{"bridges":[]}""".toByteArray()))
        assertEquals(listOf("a" to "https://x.test"), Dist.bridgesOf("""{"bridges":[{"id":"a","baseUrl":"https://x.test/"}]}""".toByteArray()))
    }

    private fun bundle(vararg files: Pair<String, String>): ByteArray {
        val json = JSONObject().put("files", JSONObject().apply { files.forEach { (k, v) -> put(k, ReceiverSealer.base64UrlEncode(v.toByteArray())) } })
        return ByteArrayOutputStream().also { out -> GZIPOutputStream(out).use { it.write(json.toString().toByteArray()) } }.toByteArray()
    }

    @Test
    fun `a bundle that would write outside its folder writes nothing`() {
        val dir = Files.createTempDirectory("ui").toFile()
        val target = File(dir, "inner")
        assertFalse(Dist.unpack(bundle("host.html" to "ok", "../escape.txt" to "x"), target))
        assertFalse(File(dir, "escape.txt").exists())
        assertFalse(target.exists())
        assertFalse(Dist.unpack(bundle("other.html" to "no start page"), target))
        dir.deleteRecursively()
    }
}
