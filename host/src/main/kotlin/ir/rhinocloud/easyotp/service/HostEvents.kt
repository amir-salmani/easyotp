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

    /** Set by the screen while it is showing. Called on any thread. */
    @Volatile
    var onChange: (() -> Unit)? = null

    fun testFinished(ok: Boolean, at: Long) {
        lastTest = TestResult(ok, at)
        onChange?.invoke()
    }
}
