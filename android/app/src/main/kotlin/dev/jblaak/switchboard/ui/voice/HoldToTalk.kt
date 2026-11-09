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

    /** Held and slid far enough left that letting go drops the recording. */
    internal var cancelling by mutableStateOf(false)

    /**
     * Slid up far enough to lock: the recording carries on with the finger lifted, until [stop] sends it or
     * [cancel] drops it. [holding] stays true meanwhile, as this mic is still the one recording.
     */
    internal var locked by mutableStateOf(false)

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
        locked = false
        haptics?.performHapticFeedback(HapticFeedbackType.LongPress)
        controls.start(sessionId(), onText)
        return true
    }

    /**
     * The finger moved by [dx], [dy] from where it pressed: up past [lockAt] locks the recording, left past
     * [cancelAt] means letting go cancels it. Once locked, the finger can go anywhere.
     */
    internal fun slide(dx: Float, dy: Float, lockAt: Float, cancelAt: Float) {
        if (!holding || locked) return
        when (slideOf(dx, dy, lockAt, cancelAt)) {
            Slide.Lock -> {
                locked = true
                cancelling = false
                haptics?.performHapticFeedback(HapticFeedbackType.GestureThresholdActivate)
            }
            Slide.Cancel -> {
                if (!cancelling) haptics?.performHapticFeedback(HapticFeedbackType.SegmentTick)
                cancelling = true
            }
            Slide.None -> cancelling = false
        }
    }

    /** Let go: transcribe, or drop the recording when slid off. Locked, the recording carries on. */
    internal fun release() {
        if (!holding || locked) return
        holding = false
        if (cancelling) controls.cancel() else controls.stop()
        cancelling = false
    }

    /** The locked recording's Stop: transcribe, as letting go does. */
    internal fun stop() {
        if (!holding || !locked) return
        holding = false
        locked = false
        controls.stop()
    }

    /** The locked recording's cancel: drop it, and nothing is sent. */
    internal fun cancel() {
        if (!holding || !locked) return
        holding = false
        locked = false
        controls.cancel()
    }

    /** The gesture was taken away, or the mic left the screen, while held or locked. */
    internal fun abandon() {
        if (!holding) return
        holding = false
        cancelling = false
        locked = false
        controls.cancel()
    }

    /**
     * What [controls] are doing now. A locked recording that ended on its own (the link dropped, the mic failed)
     * is no longer this mic's to stop, so the lock goes with it.
     */
    internal fun controlsNow(state: VoiceState) {
        if (!locked || state is VoiceState.Recording) return
        locked = false
        holding = false
        cancelling = false
    }

    internal fun denied() {
        localProblem = VoiceProblem.NoPermission
    }

    internal fun dismiss() {
        if (localProblem != null) localProblem = null else controls.dismissProblem()
    }
}

/** Where a held mic's finger has slid to. */
enum class Slide { None, Lock, Cancel }

/**
 * Slid [dx], [dy] from where the mic was pressed: up past [lockAt] locks, left past [cancelAt] cancels, and
 * whichever way the finger went further wins, so a slide that drifts a little never does the other one. Down and
 * right do nothing.
 */
fun slideOf(dx: Float, dy: Float, lockAt: Float, cancelAt: Float): Slide {
    val up = -dy
    val left = -dx
    return when {
        up >= lockAt && up > left -> Slide.Lock
        left >= cancelAt && left >= up -> Slide.Cancel
        else -> Slide.None
    }
}

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
            voice.controlsNow(state)
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
