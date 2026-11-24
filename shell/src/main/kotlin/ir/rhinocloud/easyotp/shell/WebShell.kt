package ir.rhinocloud.easyotp.shell

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import java.io.ByteArrayInputStream

/**
 * Shows screens that are bundled inside the APK (DECISIONS D19).
 *
 * The screens are a web build copied into the APK's assets. They are served to
 * the WebView under an https address that exists nowhere, by answering its
 * requests from the assets before they reach the network. An https origin is
 * what gives a page modules, storage and Web Crypto; a file:// page gets none
 * of them reliably.
 *
 * @param assetRoot the folder under assets/ that holds the build.
 * The screens never navigate away: a link out would replace the app with a
 * web page that inherits its window.
 *
 * @param network whether the screens may talk to the network themselves. The
 *   Receiver's must, to reach the bridges. The Host's never do: everything the
 *   Host sends goes through its native code, and a screen that cannot make a
 *   request cannot leak one.
 */
class WebShell(
    private val context: Context,
    private val assetRoot: String,
    private val network: Boolean,
    /**
     * Android killed the page's process to free memory. The WebView it
     * belonged to cannot be used again, so the caller starts a new window.
     */
    private val onGone: () -> Unit,
    /** A link that leads out of the app, for the caller to hand to a browser. Null drops such links. */
    private val onExternalLink: ((Uri) -> Unit)? = null,
    /** Serve from this directory instead of the APK's assets: screens fetched later (DECISIONS D32). */
    private val directory: java.io.File? = null,
) {

    @SuppressLint("SetJavaScriptEnabled") // The screens are this app's own, read from its own APK.
    fun attach(view: WebView, startPage: String = "index.html") {
        val debuggable = context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0
        WebView.setWebContentsDebuggingEnabled(debuggable)

        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            // Nothing outside the bundle is read from the device.
            allowFileAccess = false
            allowContentAccess = false
            setGeolocationEnabled(false)
            // A WebView ignores the phone's font size unless told. The people
            // this is for are the people who turn it up.
            textZoom = (context.resources.configuration.fontScale * 100).toInt()
        }
        view.webViewClient = Client(startPage)
        view.loadUrl("$ORIGIN/$startPage")
    }

    /**
     * The view to hand to `setContentView`: the WebView, kept clear of the
     * status bar, the navigation bar and the keyboard. Android now draws an
     * app under all three, and a page cannot reliably ask where they are.
     */
    fun frame(view: WebView): View = FrameLayout(context).apply {
        setBackgroundColor(PAPER)
        addView(view, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        setOnApplyWindowInsetsListener { frame, insets ->
            // The insets stop here. Passed on, a WebView on a recent Android
            // also reports them to the page as safe-area insets, the page pads
            // for them a second time, and its last button ends up off screen.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                val bars = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime())
                frame.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                WindowInsets.CONSUMED
            } else {
                @Suppress("DEPRECATION")
                frame.setPadding(
                    insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                    insets.systemWindowInsetRight, insets.systemWindowInsetBottom,
                )
                @Suppress("DEPRECATION")
                insets.consumeSystemWindowInsets()
            }
        }
    }

    private inner class Client(private val startPage: String) : WebViewClient() {

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val url = request.url
            if (url.scheme == "https" && url.host == HOST) return serve(url, startPage)
            // Not ours. The Receiver's screens reach the bridges this way.
            return if (network) null else refused()
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url
            if (url.scheme == "https" && url.host == HOST) return false
            if (url.scheme == "https" && request.hasGesture()) onExternalLink?.invoke(url)
            return true
        }

        /** Returning true keeps the app alive; the window is then replaced. */
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            onGone()
            return true
        }
    }

    private fun serve(url: Uri, startPage: String): WebResourceResponse {
        val path = assetPath(url.path, startPage) ?: return refused()
        val bytes = try {
            if (directory != null) java.io.File(directory, path).readBytes()
            else context.assets.open("$assetRoot/$path").use { it.readBytes() }
        } catch (e: Exception) {
            return WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
        }
        val headers = mutableMapOf("X-Content-Type-Options" to "nosniff", "Cache-Control" to "no-cache")
        if (path.endsWith(".html")) headers["Content-Security-Policy"] = policy(network)
        return WebResourceResponse(mimeOf(path), "utf-8", 200, "OK", headers, ByteArrayInputStream(bytes))
    }

    private fun refused() =
        WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", emptyMap(), ByteArrayInputStream(ByteArray(0)))

    companion object {
        /**
         * Reserved by Google for exactly this use, so it will never be a real
         * site. Changing it would orphan everything the screens have stored.
         */
        const val HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$HOST"

        /** The screens' background (`--background` in globals.css), so nothing flashes white around them. */
        private const val PAPER = 0xFFFBFAF8.toInt()
        private const val MATCH_PARENT = ViewGroup.LayoutParams.MATCH_PARENT

        /**
         * The asset a path names, or null if the path is not one this serves.
         * A path with no file extension is a screen, and every screen is the
         * start page.
         */
        fun assetPath(path: String?, startPage: String): String? {
            val clean = (path ?: "/").trim('/')
            if (clean.isEmpty()) return startPage
            val parts = clean.split('/')
            if (parts.any { it.isEmpty() || it == "." || it == ".." || it.contains('\\') }) return null
            return if (parts.last().contains('.')) clean else startPage
        }

        fun mimeOf(path: String): String = when (path.substringAfterLast('.', "").lowercase()) {
            "html" -> "text/html"
            "js", "mjs" -> "text/javascript"
            "css" -> "text/css"
            "json", "webmanifest" -> "application/json"
            "png" -> "image/png"
            "svg" -> "image/svg+xml"
            "ico" -> "image/x-icon"
            "woff2" -> "font/woff2"
            else -> "application/octet-stream"
        }

        /**
         * What a page may load and where it may send. Scripts only from the
         * bundle. Inline styles are allowed because the screens set a few
         * (the colour of a pairing picture is one).
         */
        fun policy(network: Boolean): String = listOf(
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data:",
            "font-src 'self'",
            "connect-src ${if (network) "https:" else "'none'"}",
            "frame-src 'none'",
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
        ).joinToString("; ")
    }
}
