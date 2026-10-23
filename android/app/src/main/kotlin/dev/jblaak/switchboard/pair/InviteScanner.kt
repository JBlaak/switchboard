package dev.jblaak.switchboard.pair

import dev.jblaak.switchboard.protocol.PairingInvite
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Reads the QR codes the camera sees, frame by frame: the first Switchboard invite is [ScanOutcome.Found] once,
 * and further frames are ignored until [resume]. Any other QR code raises [ScanHint.NotSwitchboard] and keeps
 * scanning.
 */
class InviteScanner {

    private var isHolding = false

    private val mutableHint = MutableStateFlow(ScanHint.HoldSteady)
    val hint: StateFlow<ScanHint> = mutableHint.asStateFlow()

    /** [codes] are the raw values of the QR codes in one camera frame. */
    fun scanned(codes: List<String>): ScanOutcome {
        if (isHolding || codes.isEmpty()) return ScanOutcome.Ignored
        val invite = codes.firstNotNullOfOrNull { PairingInvite.parseOrNull(it) }
        if (invite == null) {
            mutableHint.value = ScanHint.NotSwitchboard
            return ScanOutcome.NotSwitchboard
        }
        isHolding = true
        mutableHint.value = ScanHint.HoldSteady
        return ScanOutcome.Found(invite)
    }

    /** Scan again, after the unlock for a found invite was cancelled. */
    fun resume() {
        isHolding = false
    }
}

sealed interface ScanOutcome {
    data class Found(val invite: PairingInvite) : ScanOutcome

    /** A QR code that is not a Switchboard invite. */
    data object NotSwitchboard : ScanOutcome

    /** No code in the frame, or an invite was already found. */
    data object Ignored : ScanOutcome
}

enum class ScanHint {
    HoldSteady,
    NotSwitchboard,
}
