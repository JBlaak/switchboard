package dev.jblaak.switchboard.ui.voice

import android.os.SystemClock
import dev.jblaak.switchboard.link.LinkState
import dev.jblaak.switchboard.link.SendOutcome
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.ServerMessage
import dev.jblaak.switchboard.protocol.VoiceResult
import dev.jblaak.switchboard.protocol.VoiceStatus
import dev.jblaak.switchboard.ui.connected.PhoneLink
import java.io.ByteArrayOutputStream
import java.util.Base64
import java.util.UUID
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** A shorter hold is a tap: "Hold to talk". */
private const val MIN_HOLD_MILLIS = 500L

/** Audio goes out in chunks of about a quarter of a second. */
private const val CHUNK_BYTES = BYTES_PER_SECOND / 4

private val TICK = 100.milliseconds

/** The mic hands over what it already recorded within a read or two; a mic that takes longer is cut off. */
private val DRAIN_TIMEOUT = 2.seconds

/** Whisper and Haiku take seconds; past this the Mac isn't going to answer. */
private val RESULT_TIMEOUT = 60.seconds

/**
 * [VoiceControls] over the link: streams the mic to the Mac while it is held and waits for the Mac's text.
 *
 * The Mac sends its voice status right after `welcome`, and [PhoneLink.messages] does not replay, so create this
 * before the link starts and keep it as long as the link, as [dev.jblaak.switchboard.ui.connected.SessionBoard].
 * Call it from [scope]'s thread.
 */
class VoiceInput(
    private val link: PhoneLink,
    private val audio: AudioSource,
    private val scope: CoroutineScope,
    private val now: () -> Long = SystemClock::elapsedRealtime,
    private val newVoiceId: () -> String = { UUID.randomUUID().toString() },
) : VoiceControls {

    private val mutableState = MutableStateFlow<VoiceState>(VoiceState.Idle)
    override val state: StateFlow<VoiceState> = mutableState.asStateFlow()

    /** The recording being made or transcribed, if any. */
    private var take: Take? = null

    private inner class Take(val voiceId: String, val onText: (String) -> Unit) {
        val startedAt = now()
        var level = 0f
        var seq = 0
        val unsent = ByteArrayOutputStream()

        /** Turns true on let go: the mic stops and hands over what it already recorded. */
        val letGo = MutableStateFlow(false)
        var recorder: Job? = null
        var ticker: Job? = null
        var drainTimeout: Job? = null
        var resultTimeout: Job? = null

        /** The whole recording is with the Mac: `voice-end` went out. */
        var ended = false

        val elapsedMillis: Long get() = now() - startedAt

        fun stopAll() {
            recorder?.cancel()
            ticker?.cancel()
            drainTimeout?.cancel()
            resultTimeout?.cancel()
        }
    }

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            link.messages.collect { receive(it) }
        }
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            link.state.collect { if (it !is LinkState.Connected) disconnected() }
        }
    }

    // Even when the Mac last said whisper-cli is missing, the recording starts as usual: the Mac looks again on
    // every start and, if it is still missing, says so straight away, which stops the mic.
    override fun start(sessionId: String?, onText: (String) -> Unit) {
        if (take != null) return
        if (link.state.value !is LinkState.Connected) return problem(VoiceProblem.NotConnected)
        val voiceId = newVoiceId()
        if (link.send(ClientMessage.VoiceStart(voiceId, sessionId)) != SendOutcome.Sent) {
            return problem(VoiceProblem.NotConnected)
        }
        val recording = Take(voiceId, onText)
        take = recording
        mutableState.value = VoiceState.Recording(level = 0f, elapsedMillis = 0)
        recording.recorder = scope.launch {
            try {
                audio.frames(recording.letGo).collect { heard(recording, it) }
            } catch (exception: MicrophoneUnavailableException) {
                return@launch micFailed(recording, VoiceProblem.NoMicrophone)
            } catch (exception: SecurityException) {
                return@launch micFailed(recording, VoiceProblem.NoPermission)
            }
            // The mic ended; on its own (before a let go) there is nothing to do until the let go.
            if (recording.letGo.value) end(recording)
        }
        recording.ticker = scope.launch {
            while (true) {
                delay(TICK)
                showRecording(recording)
            }
        }
    }

    override fun stop() {
        val recording = take ?: return
        if (recording.letGo.value) return
        recording.letGo.value = true
        recording.ticker?.cancel()
        if (recording.elapsedMillis < MIN_HOLD_MILLIS) {
            take = null
            recording.stopAll()
            link.send(ClientMessage.VoiceCancel(recording.voiceId))
            return problem(VoiceProblem.TooShort)
        }
        mutableState.value = VoiceState.Transcribing
        if (recording.recorder?.isActive != true) return end(recording)
        recording.drainTimeout = scope.launch {
            delay(DRAIN_TIMEOUT)
            recording.recorder?.cancel()
            end(recording)
        }
    }

    override fun cancel() {
        val recording = take ?: return
        take = null
        recording.stopAll()
        // After the end the Mac is already transcribing; its text is ignored when it comes.
        if (!recording.ended) link.send(ClientMessage.VoiceCancel(recording.voiceId))
        mutableState.value = VoiceState.Idle
    }

    override fun dismissProblem() {
        if (mutableState.value is VoiceState.Problem) mutableState.value = VoiceState.Idle
    }

    private fun heard(recording: Take, frame: AudioFrame) {
        if (take !== recording || recording.ended) return
        recording.level = frame.level
        recording.unsent.write(frame.pcm)
        if (recording.unsent.size() >= CHUNK_BYTES && !sendUnsent(recording)) {
            take = null
            recording.stopAll()
            return problem(VoiceProblem.NotConnected)
        }
        showRecording(recording)
    }

    /** The mic has handed over everything after the let go: the rest of the audio goes out, then the end. */
    private fun end(recording: Take) {
        if (take !== recording || recording.ended) return
        recording.ended = true
        recording.drainTimeout?.cancel()
        if (!sendUnsent(recording) || link.send(ClientMessage.VoiceEnd(recording.voiceId)) != SendOutcome.Sent) {
            take = null
            recording.stopAll()
            return problem(VoiceProblem.NotConnected)
        }
        recording.resultTimeout = scope.launch {
            delay(RESULT_TIMEOUT)
            if (take === recording) {
                take = null
                problem(VoiceProblem.Failed("The Mac didn't send the text back"))
            }
        }
    }

    /** Sends what was recorded since the last chunk; false when the link is down. */
    private fun sendUnsent(recording: Take): Boolean {
        if (recording.unsent.size() == 0) return true
        val audio = Base64.getEncoder().encodeToString(recording.unsent.toByteArray())
        recording.unsent.reset()
        val outcome = link.send(ClientMessage.VoiceChunk(recording.voiceId, recording.seq++, audio))
        return outcome == SendOutcome.Sent
    }

    private fun showRecording(recording: Take) {
        if (take !== recording || recording.letGo.value) return
        mutableState.value = VoiceState.Recording(recording.level, recording.elapsedMillis)
    }

    private fun micFailed(recording: Take, problem: VoiceProblem) {
        if (take !== recording) return
        take = null
        recording.stopAll()
        link.send(ClientMessage.VoiceCancel(recording.voiceId))
        problem(problem)
    }

    private fun receive(message: ServerMessage) {
        when (message) {
            is ServerMessage.VoiceStatusChanged -> statusChanged(message.status)
            is ServerMessage.VoiceTranscribed -> transcribed(message.voiceId, message.result)
            else -> Unit
        }
    }

    private fun statusChanged(status: VoiceStatus) {
        // Keep a "preparing" note's progress moving while it shows.
        val shown = (mutableState.value as? VoiceState.Problem)?.problem
        if (shown is VoiceProblem.Preparing && status is VoiceStatus.Preparing) {
            problem(VoiceProblem.Preparing(status.progress))
        }
    }

    private fun transcribed(voiceId: String, result: VoiceResult) {
        val recording = take
        if (recording == null || recording.voiceId != voiceId) return
        take = null
        // An unavailable answer comes straight after the start, while the mic is still held.
        recording.stopAll()
        when (result) {
            is VoiceResult.Text -> if (result.text.isBlank()) {
                problem(VoiceProblem.NothingHeard)
            } else {
                mutableState.value = VoiceState.Idle
                recording.onText(result.text)
            }
            VoiceResult.Empty -> problem(VoiceProblem.NothingHeard)
            is VoiceResult.Unavailable -> problem(unavailable(result.status))
            is VoiceResult.Failed -> problem(VoiceProblem.Failed(result.reason))
        }
    }

    private fun disconnected() {
        val recording = take ?: return
        take = null
        recording.stopAll()
        problem(VoiceProblem.NotConnected)
    }

    private fun problem(problem: VoiceProblem) {
        mutableState.value = VoiceState.Problem(problem)
    }
}

private fun unavailable(status: VoiceStatus): VoiceProblem {
    return when (status) {
        VoiceStatus.NoWhisper -> VoiceProblem.NoWhisper
        is VoiceStatus.Preparing -> VoiceProblem.Preparing(status.progress)
        is VoiceStatus.PrepareFailed -> VoiceProblem.PrepareFailed(status.reason)
        // Never sent as unavailable.
        VoiceStatus.Ready -> VoiceProblem.Failed("The Mac couldn't transcribe")
    }
}
