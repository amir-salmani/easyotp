package ir.rhinocloud.easyotp.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WebShellTest {

    @Test
    fun `a file is served from where it says`() {
        assertEquals("assets/index-abc.js", WebShell.assetPath("/assets/index-abc.js", "index.html"))
        assertEquals("icons/icon-192.png", WebShell.assetPath("/icons/icon-192.png", "index.html"))
    }

    @Test
    fun `the root and every screen are the start page`() {
        assertEquals("host.html", WebShell.assetPath("/", "host.html"))
        assertEquals("host.html", WebShell.assetPath(null, "host.html"))
        assertEquals("index.html", WebShell.assetPath("/pair", "index.html"))
    }

    @Test
    fun `a path cannot climb out of the bundle`() {
        // The bundle sits next to other assets. Nothing outside it is a screen.
        assertNull(WebShell.assetPath("/../secrets.json", "index.html"))
        assertNull(WebShell.assetPath("/assets/../../x.js", "index.html"))
        assertNull(WebShell.assetPath("/assets//x.js", "index.html"))
        assertNull(WebShell.assetPath("/assets/..\\x.js", "index.html"))
    }

    @Test
    fun `the Host's screens may not make a request`() {
        assertTrue(WebShell.policy(network = false).contains("connect-src 'none'"))
        assertTrue(WebShell.policy(network = true).contains("connect-src https:"))
        assertTrue(WebShell.policy(network = true).contains("script-src 'self'"))
    }

    @Test
    fun `scripts and styles are served as what they are`() {
        // A module script served as anything else is refused by the WebView.
        assertEquals("text/javascript", WebShell.mimeOf("assets/a.js"))
        assertEquals("text/css", WebShell.mimeOf("assets/a.css"))
        assertEquals("font/woff2", WebShell.mimeOf("assets/v.woff2"))
    }
}
