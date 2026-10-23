package dev.jblaak.switchboard.shell

import dev.jblaak.switchboard.link.PairFailure

/** The one screen the app shows, picked from the link's state by [AppScreenModel]. */
sealed interface AppScreen {

    /** Before the link reports anything: the bare background. */
    data object Starting : AppScreen

    /** Finding or dialling the paired Mac. [macName] is null until the app has heard it. */
    data class Connecting(val macName: String?) : AppScreen

    /** The camera, reading the pairing QR code. [canGoBack] when it was opened over a failure that back returns to. */
    data class Scan(val canGoBack: Boolean) : AppScreen

    /** A scanned invite on its way through: "Confirm on your Mac" with the checklist. */
    data class Confirm(val host: String, val step: PairingStep) : AppScreen

    data class PairFailed(val failure: PairFailure) : AppScreen

    /** The link is up: the connected screens take over. */
    data object Connected : AppScreen

    /** "Can't find your Mac". [isTrying] while a retry is under way, so the screen stays put instead of flickering. */
    data class NotFound(val macName: String?, val isTrying: Boolean) : AppScreen

    data class NotPaired(val macName: String?) : AppScreen

    /** [macVersion] is null when the Mac did not say its version. */
    data class UpdateRequired(val macVersion: String?, val appVersion: String) : AppScreen

    data class TurnedOff(val macName: String?) : AppScreen

    /** The app, or the link's key, waits for a biometric unlock. */
    data class Locked(val macName: String?) : AppScreen
}

/** How far a pairing got, as the checklist on the confirm screen shows it. */
enum class PairingStep {
    /** Looking for the Mac at the invite's address, then on the network. */
    Finding,

    /** The Mac answered with the pinned certificate; the code is being checked. */
    CheckingCode,

    /** The code was right; the Mac is asking its user. */
    WaitingOnMac,
}
