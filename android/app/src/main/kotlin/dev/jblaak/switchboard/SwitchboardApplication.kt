package dev.jblaak.switchboard

import android.app.Application
import android.content.Context
import dev.jblaak.switchboard.link.MacLink
import dev.jblaak.switchboard.link.createMacLink
import dev.jblaak.switchboard.link.pairing.SharedPreferencesPairingStore
import dev.jblaak.switchboard.lock.AppLock
import dev.jblaak.switchboard.shell.AppScreenModel
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

    override fun onCreate() {
        super.onCreate()
        link = createMacLink(this, scope)
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
