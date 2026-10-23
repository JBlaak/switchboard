package dev.jblaak.switchboard.shell

import dev.jblaak.switchboard.link.LinkState
import dev.jblaak.switchboard.link.PairFailure
import dev.jblaak.switchboard.lock.AppLock
import dev.jblaak.switchboard.protocol.PROTOCOL_VERSION
import dev.jblaak.switchboard.protocol.PairingInvite
import kotlin.time.Duration
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Picks the [AppScreen] from the link's state and what the user did on top of it: a scanned invite turns the
 * link's searching into the pairing checklist, "Pair again" and "Try again" open the camera while the link still
 * reports the failure, and the [AppLock] covers every screen outside the pairing flow until a biometric unlock.
 *
 * [knownMacName] is the paired Mac's name from storage, for the screens shown before the link has heard it.
 */
class AppScreenModel(
    private val appVersion: String,
    knownMacName: String?,
    private val lock: AppLock,
) {

    private var linkState: LinkState = LinkState.Idle
    private var linkScreen: AppScreen = AppScreen.Starting
    private var macName: String? = knownMacName
    private var invite: PairingInvite? = null
    private var isScanRequested = false

    private val mutableScreen = MutableStateFlow<AppScreen>(AppScreen.Starting)
    val screen: StateFlow<AppScreen> = mutableScreen.asStateFlow()

    fun linkChanged(state: LinkState) {
        if (state == linkState) return
        linkState = state
        isScanRequested = false
        rememberMacName(state)
        if (endsPairing(state)) invite = null
        linkScreen = screenFor(state)
        show()
    }

    /** The user scanned [scanned] and unlocked: the link is about to pair with it. */
    fun pairingStarted(scanned: PairingInvite) {
        lock.unlocked()
        isScanRequested = false
        if (scanned.protocol == PROTOCOL_VERSION) {
            invite = scanned
            linkScreen = AppScreen.Confirm(scanned.host, PairingStep.Finding)
        } else {
            linkScreen = AppScreen.PairFailed(PairFailure.ProtocolMismatch(scanned.protocol))
        }
        show()
    }

    /** "Pair again" or "Try again": the camera, over whatever the link last said. */
    fun scanRequested() {
        isScanRequested = true
        show()
    }

    /** Back out of a camera that [scanRequested] opened. */
    fun scanDismissed() {
        isScanRequested = false
        show()
    }

    fun unlocked() {
        lock.unlocked()
        show()
    }

    fun backgrounded(at: Duration) {
        lock.backgrounded(at)
    }

    fun foregrounded(at: Duration) {
        lock.foregrounded(at)
        show()
    }

    private fun show() {
        mutableScreen.value = when {
            isScanRequested -> AppScreen.Scan(canGoBack = true)
            lock.isLocked && isLockable(linkScreen) -> AppScreen.Locked(macName)
            else -> linkScreen
        }
    }

    private fun screenFor(state: LinkState): AppScreen {
        val pairingHost = invite?.host
        return when (state) {
            LinkState.Idle -> AppScreen.Starting
            LinkState.Unpaired -> AppScreen.Scan(canGoBack = false)
            LinkState.Searching, LinkState.Connecting -> when {
                pairingHost != null -> linkScreen as? AppScreen.Confirm ?: AppScreen.Confirm(pairingHost, PairingStep.Finding)
                else -> stillTryingOr(AppScreen.Connecting(macName))
            }
            LinkState.Reconnecting -> when (linkScreen) {
                AppScreen.Connected -> AppScreen.Connected
                else -> stillTryingOr(AppScreen.Connecting(macName))
            }
            is LinkState.Pairing -> AppScreen.Confirm(pairingHost ?: state.macName, PairingStep.CheckingCode)
            is LinkState.PairPending -> AppScreen.Confirm(pairingHost ?: state.macName, PairingStep.WaitingOnMac)
            is LinkState.PairFailed -> AppScreen.PairFailed(state.failure)
            is LinkState.Connected -> AppScreen.Connected
            LinkState.NotFound -> AppScreen.NotFound(macName, isTrying = false)
            LinkState.NotPaired -> AppScreen.NotPaired(macName)
            is LinkState.UpdateRequired -> AppScreen.UpdateRequired(state.macVersion, appVersion)
            LinkState.TurnedOff -> AppScreen.TurnedOff(macName)
            LinkState.Locked -> AppScreen.Locked(macName)
        }
    }

    private fun stillTryingOr(screen: AppScreen): AppScreen {
        val notFound = linkScreen as? AppScreen.NotFound ?: return screen
        return notFound.copy(isTrying = true)
    }

    private fun rememberMacName(state: LinkState) {
        when (state) {
            is LinkState.Pairing -> macName = state.macName.ifEmpty { macName }
            is LinkState.PairPending -> macName = state.macName.ifEmpty { macName }
            is LinkState.Connected -> macName = state.macName
            LinkState.Unpaired -> macName = null
            else -> Unit
        }
    }

    private fun endsPairing(state: LinkState): Boolean {
        return when (state) {
            LinkState.Idle, LinkState.Searching, LinkState.Connecting, LinkState.Locked,
            is LinkState.Pairing, is LinkState.PairPending -> false
            else -> true
        }
    }

    private fun isLockable(screen: AppScreen): Boolean {
        return when (screen) {
            AppScreen.Starting, is AppScreen.Scan, is AppScreen.Confirm, is AppScreen.PairFailed -> false
            else -> true
        }
    }
}
