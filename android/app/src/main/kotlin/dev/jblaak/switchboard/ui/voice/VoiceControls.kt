package dev.jblaak.switchboard.ui.voice

import androidx.compose.runtime.staticCompositionLocalOf
import kotlinx.coroutines.flow.StateFlow

/**
 * Hold-to-talk voice input: the phone records while the mic is held, the Mac transcribes with Whisper and cleans
 * the text up with Haiku, and the text lands in the box being typed in, for review before sending.
 */
interface VoiceControls {
    val state: StateFlow<VoiceState>

    /**
     * Start recording. [sessionId] is the session being typed into, if any, so the Mac can prime Whisper with its
     * project. [onText] gets the cleaned-up text once, unless the recording is cancelled or fails. The caller has
     * already been granted RECORD_AUDIO.
     */
    fun start(sessionId: String?, onText: (String) -> Unit)

    /** The mic was let go: send what was recorded for transcribing. Too short a hold becomes [VoiceProblem.TooShort]. */
    fun stop()

    /** The finger slid off the mic: drop the recording. */
    fun cancel()

    /** The problem's note was dismissed, or timed out. */
    fun dismissProblem()
}

sealed interface VoiceState {
    data object Idle : VoiceState

    /** [level] is the input loudness, 0–1, for the meter. */
    data class Recording(val level: Float, val elapsedMillis: Long) : VoiceState

    /** Let go; waiting for the Mac's text. */
    data object Transcribing : VoiceState

    /** Shown as a short note by the mic until dismissed. */
    data class Problem(val problem: VoiceProblem) : VoiceState
}

sealed interface VoiceProblem {
    /** Held for under half a second: "Hold to talk". */
    data object TooShort : VoiceProblem
    data object NothingHeard : VoiceProblem
    data object NoPermission : VoiceProblem
    data object NoMicrophone : VoiceProblem
    data object NotConnected : VoiceProblem
    /** `brew install whisper-cpp` on the Mac. */
    data object NoWhisper : VoiceProblem
    /** The Mac is downloading the model; [progress] 0–1, or null when unknown. */
    data class Preparing(val progress: Double?) : VoiceProblem
    data class PrepareFailed(val reason: String) : VoiceProblem
    data class Failed(val reason: String) : VoiceProblem
}

/** Provided by the connected app; null outside it (previews), where the mic is hidden. */
val LocalVoiceControls = staticCompositionLocalOf<VoiceControls?> { null }
