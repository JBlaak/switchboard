package dev.jblaak.switchboard.link

import dev.jblaak.switchboard.protocol.PairRejection

/** Where the phone's link to the Mac stands; each state is a screen, or a banner over the last one. */
sealed interface LinkState {

    /** Not started, or stopped. */
    data object Idle : LinkState

    /** This phone has never paired, or forgot its pairing: the pair screen. */
    data object Unpaired : LinkState

    /** Looking for the Mac on the network. */
    data object Searching : LinkState

    data object Connecting : LinkState

    /** The Mac opened a pairing connection; the code is on its way to be checked. */
    data class Pairing(val macName: String) : LinkState

    /** The code was right; the Mac is asking its user to confirm this phone. */
    data class PairPending(val macName: String) : LinkState

    data class PairFailed(val failure: PairFailure) : LinkState

    data class Connected(val deviceId: String, val macName: String) : LinkState

    /** A connection dropped and the link is trying again, silently, while the key is still unlocked. */
    data object Reconnecting : LinkState

    /** The Mac could not be reached (asleep, Phone access off, another network): "Mac not found" with a retry. */
    data object NotFound : LinkState

    /** The Mac revoked this phone, or reset its identity: "This phone is no longer paired". */
    data object NotPaired : LinkState

    /** The Mac speaks another protocol version: "Update the app". Null when the Mac did not say its version. */
    data class UpdateRequired(val macVersion: String?) : LinkState

    /** Phone access was turned off on the Mac. */
    data object TurnedOff : LinkState

    /** The key needs a biometric unlock before the link can connect again; call [MacLink.unlocked] after one. */
    data object Locked : LinkState
}

sealed interface PairFailure {

    /** The Mac turned the code down. */
    data class Rejected(val reason: PairRejection) : PairFailure

    /** The QR code is from a Mac that speaks protocol [macProtocol], not this app's. */
    data class ProtocolMismatch(val macProtocol: Int) : PairFailure

    /** No strong biometric is enrolled, so no biometric-bound key can be made. */
    data object BiometricsUnavailable : PairFailure

    /** Every server that answered had a certificate other than the one in the QR code. */
    data object WrongMac : PairFailure

    /** The Mac answered but no pairing code is live any more. */
    data object NotPairing : PairFailure

    data object NotFound : PairFailure

    /** The connection ended before the Mac decided. */
    data object Interrupted : PairFailure
}
