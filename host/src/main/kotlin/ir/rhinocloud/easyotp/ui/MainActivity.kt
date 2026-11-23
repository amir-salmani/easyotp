package ir.rhinocloud.easyotp.ui

import android.app.Activity
import android.os.Bundle
import android.widget.TextView
import ir.rhinocloud.easyotp.R

/**
 * A placeholder. The real screens are a signed web bundle that this activity
 * will load (DECISIONS D19), so nothing is built here that would be thrown away.
 */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val padding = (24 * resources.displayMetrics.density).toInt()
        setContentView(
            TextView(this).apply {
                setText(R.string.placeholder)
                textSize = 18f
                setPadding(padding, padding, padding, padding)
            },
        )
    }
}
