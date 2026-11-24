package ir.rhinocloud.easyotp.service

/**
 * The little the screens need to hear from the rest of the app while they are
 * open. One process, so a plain object: nothing here outlives it or needs to.
 */
object HostEvents {

    data class TestResult(val ok: Boolean, val at: Long)

    @Volatile
    var lastTest: TestResult? = null
        private set

    @Volatile
    private var listener: (() -> Unit)? = null

    /** The window that is showing registers itself. A newer window replaces an older one. */
    fun listen(onChange: () -> Unit) {
        listener = onChange
    }

    /** A window that is going away. It must not silence the one that replaced it. */
    fun forget(onChange: () -> Unit) {
        if (listener === onChange) listener = null
    }

    /**
     * Something the screens show may have changed. Reaches whichever window
     * is showing now, which need not be the one that started the work.
     * Called on any thread.
     */
    fun changed() {
        listener?.invoke()
    }

    fun testFinished(ok: Boolean, at: Long) {
        lastTest = TestResult(ok, at)
        changed()
    }
}
