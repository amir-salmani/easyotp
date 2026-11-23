package ir.rhinocloud.easyotp.net

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PayloadTest {

    private val salt = ByteArray(32) { it.toByte() }

    @Test
    fun `the wire id is the same on every retry and at every bridge`() {
        // The Receiver shows a message once per id. An id that changed between
        // attempts would show the same SMS twice.
        assertEquals(Payload.wireId(salt, "key"), Payload.wireId(salt, "key"))
    }

    @Test
    fun `the wire id says nothing without the phone's salt`() {
        // A bridge sees the id. Two phones receiving the same text must not
        // produce the same one, or a bridge could test guesses at the text.
        assertNotEquals(Payload.wireId(salt, "key"), Payload.wireId(ByteArray(32), "key"))
        assertNotEquals(Payload.wireId(salt, "key"), Payload.wireId(salt, "other"))
    }

    @Test
    fun `the wire id has the shape a bridge accepts`() {
        assertTrue(Payload.wireId(salt, "key").matches(Regex("[A-Za-z0-9_-]{16,64}")))
    }

    @Test
    fun `a message without a code says so explicitly`() {
        // The Receiver tells "no code" from "field missing", so the key must
        // be present and null.
        val json = JSONObject(String(Payload("i".repeat(32), "sim", "from", "hello", null, 1L).encode()))
        assertTrue(json.has("code"))
        assertTrue(json.isNull("code"))
        assertEquals(setOf("v", "id", "sim", "from", "body", "code", "at"), json.keys().asSequence().toSet())
        assertEquals(2, json.getInt("v"))
    }

    @Test
    fun `persian text survives encoding`() {
        val body = "رمز شما ۴۸۲۱ است"
        val json = JSONObject(String(Payload("i".repeat(32), "sim", "from", body, "4821", 1L).encode()))
        assertEquals(body, json.getString("body"))
    }
}
