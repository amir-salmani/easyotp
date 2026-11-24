package ir.rhinocloud.easyotp.service

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.util.Log

/**
 * Makes the phone ring and vibrate, because a paired Receiver asked (DECISIONS
 * D26). The point is to get someone near the phone to look at it: to plug it
 * in, or to confirm it is where it should be.
 *
 * It stops by itself after [RING_MILLIS], and at once when someone presses
 * the button the app shows while it rings, or taps or swipes away the
 * notification that says why it is ringing.
 * A sound nobody at the phone can turn off is a reason to uninstall.
 *
 * It plays as an alarm, and turns the alarm volume up for as long as it rings.
 * A phone left on silent in a drawer is exactly the phone this is for, and the
 * alarm stream is the one Android lets through in that state.
 */
object Buzzer {

    private val main = Handler(Looper.getMainLooper())
    private var player: MediaPlayer? = null
    private var restoreVolume: Int? = null

    /** Who asked for the ring that is sounding now, or null when the phone is quiet. For the screens. */
    @Volatile
    var ringingFor: String? = null
        private set

    fun ring(context: Context, askedBy: String) = main.post {
        val app = context.applicationContext
        stop(app)
        ringingFor = askedBy
        HostEvents.changed()
        val audio = app.getSystemService(AudioManager::class.java)
        runCatching {
            if (audio != null) {
                restoreVolume = audio.getStreamVolume(AudioManager.STREAM_ALARM)
                audio.setStreamVolume(AudioManager.STREAM_ALARM, audio.getStreamMaxVolume(AudioManager.STREAM_ALARM), 0)
            }
            val sound = RingtoneManager.getActualDefaultRingtoneUri(app, RingtoneManager.TYPE_ALARM)
                ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
            player = MediaPlayer().apply {
                setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                        .build(),
                )
                setDataSource(app, sound)
                isLooping = true
                prepare()
                start()
            }
        }.onFailure { Log.w(TAG, "ring: no sound: ${it.javaClass.simpleName}") }

        // Vibration is separate, so a phone with no alarm sound set still does something.
        runCatching {
            @Suppress("DEPRECATION") // The replacement, VibratorManager, is API 31.
            val vibrator = app.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
            val pattern = longArrayOf(0, 600, 400)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                vibrator?.vibrate(VibrationEffect.createWaveform(pattern, 0))
            }
        }
        main.postDelayed({ stop(app) }, RING_MILLIS)
    }

    /** Whoever is holding the phone has heard it. Safe from any thread, and when nothing is ringing. */
    fun silence(context: Context) {
        val app = context.applicationContext
        main.post { stop(app) }
    }

    private fun stop(context: Context) {
        main.removeCallbacksAndMessages(null)
        if (ringingFor != null) {
            ringingFor = null
            HostEvents.changed()
        }
        runCatching { player?.stop() }
        runCatching { player?.release() }
        player = null
        runCatching {
            @Suppress("DEPRECATION")
            (context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator)?.cancel()
        }
        restoreVolume?.let { volume ->
            runCatching {
                context.getSystemService(AudioManager::class.java)?.setStreamVolume(AudioManager.STREAM_ALARM, volume, 0)
            }
        }
        restoreVolume = null
    }

    private const val TAG = "EasyOTP"

    /** Long enough to find a phone in the next room, short enough not to be a punishment. */
    private const val RING_MILLIS = 20_000L
}
