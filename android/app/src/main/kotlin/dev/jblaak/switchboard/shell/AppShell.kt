package dev.jblaak.switchboard.shell

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.withResumed
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.link.MacLink
import dev.jblaak.switchboard.lock.BiometricUnlock
import dev.jblaak.switchboard.lock.LockScreen
import dev.jblaak.switchboard.pair.ConfirmPairingScreen
import dev.jblaak.switchboard.pair.PairFailedScreen
import dev.jblaak.switchboard.pair.PairRoute
import dev.jblaak.switchboard.problems.NotFoundScreen
import dev.jblaak.switchboard.problems.NotPairedScreen
import dev.jblaak.switchboard.problems.TurnedOffScreen
import dev.jblaak.switchboard.problems.UpdateRequiredScreen
import dev.jblaak.switchboard.protocol.PairingInvite
import dev.jblaak.switchboard.theme.SwitchboardTheme
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.delay

/**
 * The app's one screen at a time, picked by [model] from the [link]'s state: pairing, the lock, the error states,
 * and, once connected, [connectedContent] with the link to talk over.
 *
 * [deviceName] is the name the Mac shows when it asks to pair this phone.
 */
@Composable
fun AppShell(
    link: MacLink,
    model: AppScreenModel,
    unlock: BiometricUnlock,
    deviceName: String,
    connectedContent: @Composable (MacLink) -> Unit,
) {
    val screen by model.screen.collectAsState()
    val uriHandler = LocalUriHandler.current
    val lifecycle = LocalLifecycleOwner.current.lifecycle

    fun promptUnlock() {
        unlock.prompt(
            title = R.string.lock_prompt_title,
            onUnlocked = {
                model.unlocked()
                link.unlocked()
            },
            onDismissed = {},
        )
    }

    fun pair(invite: PairingInvite, resumeScanning: () -> Unit) {
        val start = {
            model.pairingStarted(invite)
            link.pair(invite)
        }
        if (unlock.canPrompt()) {
            unlock.prompt(title = R.string.pair_unlock_title, onUnlocked = start, onDismissed = resumeScanning)
        } else {
            start()
        }
    }

    AnimatedContent(
        targetState = screen,
        modifier = Modifier
            .fillMaxSize()
            .background(SwitchboardTheme.colors.bgBase),
        transitionSpec = { fadeIn(tween(200)) togetherWith fadeOut(tween(200)) },
        contentKey = { it::class },
        label = "screen",
    ) { current ->
        when (current) {
            AppScreen.Starting -> Box(modifier = Modifier.fillMaxSize())
            is AppScreen.Connecting -> ConnectingScreen(macName = current.macName)
            is AppScreen.Scan -> {
                BackHandler(enabled = current.canGoBack) { model.scanDismissed() }
                PairRoute(onInviteFound = ::pair)
            }
            is AppScreen.Confirm -> {
                BackHandler { link.forget() }
                ConfirmPairingScreen(host = current.host, deviceName = deviceName, step = current.step, onCancel = link::forget)
            }
            is AppScreen.PairFailed -> PairFailedScreen(failure = current.failure, onTryAgain = model::scanRequested)
            AppScreen.Connected -> connectedContent(link)
            is AppScreen.NotFound -> {
                LaunchedEffect(current.isTrying) {
                    if (!current.isTrying) {
                        delay(10.seconds)
                        link.retry()
                    }
                }
                NotFoundScreen(macName = current.macName, isTrying = current.isTrying, onTryNow = link::retry)
            }
            is AppScreen.NotPaired -> NotPairedScreen(
                macName = current.macName,
                onPairAgain = model::scanRequested,
                onForget = link::forget,
            )
            is AppScreen.UpdateRequired -> UpdateRequiredScreen(
                macVersion = current.macVersion,
                appVersion = current.appVersion,
                onGetRelease = { uriHandler.openUri("https://github.com/JBlaak/switchboard/releases/latest") },
            )
            is AppScreen.TurnedOff -> TurnedOffScreen(macName = current.macName, onTryAgain = link::retry)
            is AppScreen.Locked -> {
                LaunchedEffect(Unit) { lifecycle.withResumed { promptUnlock() } }
                LockScreen(macName = current.macName, onUnlock = ::promptUnlock)
            }
        }
    }
}
