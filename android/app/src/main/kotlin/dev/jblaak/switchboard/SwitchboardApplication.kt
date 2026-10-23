package dev.jblaak.switchboard

import android.app.Application
import android.content.Context
import dev.jblaak.switchboard.link.MacLink
import dev.jblaak.switchboard.link.createMacLink
import dev.jblaak.switchboard.link.pairing.SharedPreferencesPairingStore
import dev.jblaak.switchboard.lock.AppLock
import dev.jblaak.switchboard.shell.AppScreenModel
import dev.jblaak.switchboard.ui.connected.PhoneLink
import dev.jblaak.switchboard.ui.connected.SessionBoard
import dev.jblaak.switchboard.ui.connected.asPhoneLink
import dev.jblaak.switchboard.ui.voice.MicAudioSource
import dev.jblaak.switchboard.ui.voice.VoiceInput
import kotlin.time.Duration.Companion.minutes
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch

/** Owns the process's one [MacLink] and the [AppScreenModel] that follows it, so both outlive the activity. */
class SwitchboardApplication : Application() {

    private val scope: CoroutineScope = MainScope()

    lateinit var link: MacLink
        private set

    lateinit var screens: AppScreenModel
        private set

    /** The phone's view of the link, and the board that keeps the session list and questions it sends. */
    lateinit var phoneLink: PhoneLink
        private set

    lateinit var board: SessionBoard
        private set

    /** Hold-to-talk, listening from the start like the board: the Mac's voice status comes with welcome. */
    lateinit var voice: VoiceInput
        private set

    override fun onCreate() {
        super.onCreate()
        link = createMacLink(this, scope)
        // The Mac sends the session list and the questions right after welcome, and the link doesn't replay
        // them, so the board has to be listening before the link starts.
        phoneLink = link.asPhoneLink()
        board = SessionBoard(phoneLink, scope)
        voice = VoiceInput(phoneLink, MicAudioSource(), scope)
        screens = AppScreenModel(
            appVersion = packageManager.getPackageInfo(packageName, 0).versionName.orEmpty(),
            knownMacName = SharedPreferencesPairingStore(getSharedPreferences("pairing", Context.MODE_PRIVATE)).loadOrNull()?.macName,
            lock = AppLock(timeout = 5.minutes),
        )
        scope.launch(Dispatchers.Main.immediate) {
            link.state.collect(screens::linkChanged)
        }
        link.start()
    }
}
