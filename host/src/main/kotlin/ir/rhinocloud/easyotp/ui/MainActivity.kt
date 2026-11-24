package ir.rhinocloud.easyotp.ui

import android.app.Activity
import android.os.Build
import android.os.Bundle
import android.webkit.WebView
import android.window.OnBackInvokedDispatcher
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

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        val shell = WebShell(this, assetRoot = "ui", network = false)
        setContentView(shell.frame(web))
        web.addJavascriptInterface(HostApi(this), "EasyOtpNative")
        shell.attach(web, "host.html")
        HostEvents.onChange = ::changed
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
        // The person may be coming back from a permission screen.
        changed()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        changed()
    }

    override fun onDestroy() {
        HostEvents.onChange = null
        web.destroy()
        super.onDestroy()
    }

    /** Back on Android 12 and older, where the callback above does not exist. */
    @Suppress("GestureBackNavigation", "OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        tell(BACK)
    }

    /** The page reads everything again. Safe from any thread. */
    fun changed() = tell("easyotp:change")

    private fun tell(event: String) {
        web.post { web.evaluateJavascript("window.dispatchEvent(new Event('$event'))", null) }
    }

    private companion object {
        const val BACK = "easyotp:back"
    }
}
