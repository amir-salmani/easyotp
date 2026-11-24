package ir.rhinocloud.easyotp.ui

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import android.window.OnBackInvokedDispatcher
import ir.rhinocloud.easyotp.dist.DistUpdater
import ir.rhinocloud.easyotp.dist.Screens
import ir.rhinocloud.easyotp.service.ForwarderService
import ir.rhinocloud.easyotp.service.HostEvents
import ir.rhinocloud.easyotp.shell.WebShell

/**
 * The Host's one window. Every screen in it is a web page bundled in the APK
 * (DECISIONS D19); this class only shows the page and tells it when something
 * it displays may have changed. What the page can ask for is [HostApi].
 */
class MainActivity : Activity() {

    private lateinit var web: WebView

    /** The fetched screens this window is showing, or null for the APK's own. */
    private var trying: java.io.File? = null

    /** The version of the screens this window shows, fetched or built in. */
    val screensVersion: Long
        get() = trying?.name?.toLongOrNull() ?: Screens.builtIn(this)

    /** Set by the page through HostApi.ready. */
    @Volatile
    var drew = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        // If Android kills the page's process, this window starts again.
        // Newer screens fetched from the bridges, if there are any and they have not failed.
        trying = Screens.fetched(this)
        val shell = WebShell(this, assetRoot = "ui", network = false, onGone = ::recreate, directory = trying)
        setContentView(shell.frame(web))
        web.addJavascriptInterface(HostApi(this), "EasyOtpNative")
        shell.attach(web, "host.html")
        HostEvents.listen(onChange)
        trying?.let { dir ->
            // They must say they drew. If not, they are not tried again, and
            // this window opens once more with the screens the APK carries.
            web.postDelayed({
                if (!drew) {
                    Screens.failed(this, dir.name.toLong())
                    recreate()
                }
            }, DRAW_MILLIS)
        }
        // The page decides what Back means: close what is open, or leave.
        // From Android 13 a back gesture is delivered only this way.
        if (Build.VERSION.SDK_INT >= 33) {
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { tell(BACK) }
        }
    }

    override fun onResume() {
        super.onResume()
        // Opening the app is the one moment Android always lets the service
        // start, so it is also the repair for a service that was stopped.
        ForwarderService.wake(this)
        // Someone has the app open: look for newer screens and bridges, at
        // most every few hours. Here and not only in the service, which does
        // not run at all on a phone nobody is paired to yet.
        DIST.execute { runCatching { DistUpdater(applicationContext).runIfDue() } }
        // The person may be coming back from a permission screen.
        changed()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        changed()
    }

    override fun onDestroy() {
        HostEvents.forget(onChange)
        web.destroy()
        super.onDestroy()
    }

    /** Back on Android 12 and older, where the callback above does not exist. */
    @Suppress("GestureBackNavigation", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        tell(BACK)
    }

    /** The page reads everything again. Safe from any thread. */
    private fun changed() = tell("easyotp:change")

    /** One object, so that the window forgetting itself can be told from a newer window. */
    private val onChange: () -> Unit = ::changed

    private fun tell(event: String) {
        web.post { web.evaluateJavascript("window.dispatchEvent(new Event('$event'))", null) }
    }

    private companion object {
        const val BACK = "easyotp:back"
        const val DRAW_MILLIS = 8_000L
        val DIST: java.util.concurrent.ExecutorService = java.util.concurrent.Executors.newSingleThreadExecutor()
    }
}
