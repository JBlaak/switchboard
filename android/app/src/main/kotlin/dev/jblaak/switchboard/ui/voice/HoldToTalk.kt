package dev.jblaak.switchboard.ui.voice

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.hapticfeedback.HapticFeedback
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.core.content.ContextCompat
import kotlinx.coroutines.delay

/**
 * One mic's hold-to-talk: the press, slide and release it turns into [VoiceControls] calls, and what it shows.
 * Several mics can be on screen at once (the question sheet over a session), but only the one that started what
 * the controls are doing shows it.
 */
@Stable
class HoldToTalk internal constructor(
    internal val controls: VoiceControls,
    private val sessionId: () -> String?,
    private val onText: (String) -> Unit,
    private val hasPermission: () -> Boolean,
    private val haptics: HapticFeedback?,
) {
    /** This mic started what [controls] are doing. */
    internal var owns by mutableStateOf(false)

    /** The finger is on the mic and it is recording. */
    internal var holding by mutableStateOf(false)
        private set

    /** Held and slid far enough off the mic that letting go drops the recording. */
    internal var cancelling by mutableStateOf(false)

    /** A problem found here rather than by [controls]: the microphone permission was denied. */
    internal var localProblem by mutableStateOf<VoiceProblem?>(null)

    internal var askPermission: () -> Unit = {}

    /** Pressed: start recording, or, without the microphone permission yet, only ask for it. True when it started. */
    internal fun press(): Boolean {
        localProblem = null
        val now = controls.state.value
        if (now is VoiceState.Recording || now is VoiceState.Transcribing) return false
        if (!hasPermission()) {
            askPermission()
            return false
        }
        owns = true
        holding = true
        cancelling = false
        haptics?.performHapticFeedback(HapticFeedbackType.LongPress)
        controls.start(sessionId(), onText)
        return true
    }

    /** The finger moved by [dx], [dy] from where it pressed. */
    internal fun slide(dx: Float, dy: Float, threshold: Float) {
        val off = slidOff(dx, dy, threshold)
        if (off && !cancelling) haptics?.performHapticFeedback(HapticFeedbackType.SegmentTick)
        cancelling = off
    }

    /** Let go: transcribe, or drop the recording when slid off. */
    internal fun release() {
        if (!holding) return
        holding = false
        if (cancelling) controls.cancel() else controls.stop()
        cancelling = false
    }

    /** The gesture was taken away, or the mic left the screen, while held. */
    internal fun abandon() {
        if (!holding) return
        holding = false
        cancelling = false
        controls.cancel()
    }

    internal fun denied() {
        localProblem = VoiceProblem.NoPermission
    }

    internal fun dismiss() {
        if (localProblem != null) localProblem = null else controls.dismissProblem()
    }
}

/** Slid [dx], [dy] from where the mic was pressed: far enough off it to cancel. */
fun slidOff(dx: Float, dy: Float, threshold: Float): Boolean = dx * dx + dy * dy >= threshold * threshold

/** What a mic shows of the controls' [state]: nothing unless it [owns] it, and a [localProblem] over anything. */
fun shownVoiceOf(state: VoiceState, owns: Boolean, localProblem: VoiceProblem?): VoiceState {
    if (localProblem != null) return VoiceState.Problem(localProblem)
    return if (owns) state else VoiceState.Idle
}

/** What this mic shows. */
@Composable
fun HoldToTalk.shown(): VoiceState {
    val state by controls.state.collectAsState()
    return shownVoiceOf(state, owns, localProblem)
}

/**
 * Hold-to-talk for a box being typed in: [onText] gets what was said, to add to the box. Null where there is no
 * voice (previews), so the mic is left out.
 */
@Composable
fun rememberHoldToTalk(sessionId: String?, onText: (String) -> Unit): HoldToTalk? {
    val controls = LocalVoiceControls.current ?: return null
    val context = LocalContext.current
    val haptics = LocalHapticFeedback.current
    val currentSessionId by rememberUpdatedState(sessionId)
    val currentOnText by rememberUpdatedState(onText)
    val voice = remember(controls) {
        HoldToTalk(
            controls = controls,
            sessionId = { currentSessionId },
            onText = { currentOnText(it) },
            hasPermission = {
                ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
            },
            haptics = haptics,
        )
    }
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (!granted) voice.denied()
    }
    SideEffect { voice.askPermission = { launcher.launch(Manifest.permission.RECORD_AUDIO) } }

    // Once what this mic started is over, it stops showing the controls' state.
    LaunchedEffect(voice) {
        var busy = false
        controls.state.collect { state ->
            when {
                !voice.owns -> busy = false
                state !is VoiceState.Idle -> busy = true
                busy && !voice.holding -> {
                    voice.owns = false
                    busy = false
                }
            }
        }
    }
    val shown = voice.shown()
    LaunchedEffect(shown) {
        if (shown is VoiceState.Problem) {
            delay(noteMillisOf(shown.problem))
            voice.dismiss()
        }
    }
    DisposableEffect(voice) {
        onDispose { voice.abandon() }
    }
    return voice
}
