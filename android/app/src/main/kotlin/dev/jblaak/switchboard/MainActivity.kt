package dev.jblaak.switchboard

import android.os.Build
import android.os.Bundle
import android.os.SystemClock
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.fragment.app.FragmentActivity
import dev.jblaak.switchboard.lock.BiometricUnlock
import dev.jblaak.switchboard.shell.AppShell
import dev.jblaak.switchboard.shell.ConnectedSlot
import dev.jblaak.switchboard.theme.SwitchboardTheme
import kotlin.time.Duration.Companion.milliseconds

class MainActivity : FragmentActivity() {

    private val app: SwitchboardApplication
        get() = application as SwitchboardApplication

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        val unlock = BiometricUnlock(this)
        setContent {
            SwitchboardTheme {
                AppShell(
                    link = app.link,
                    model = app.screens,
                    unlock = unlock,
                    deviceName = Build.MODEL,
                    connectedContent = { ConnectedSlot(app.link, app.phoneLink, app.board, app.voice) },
                )
            }
        }
    }

    override fun onStart() {
        super.onStart()
        app.screens.foregrounded(at = SystemClock.elapsedRealtime().milliseconds)
    }

    override fun onStop() {
        super.onStop()
        app.screens.backgrounded(at = SystemClock.elapsedRealtime().milliseconds)
    }
}
