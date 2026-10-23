package dev.jblaak.switchboard.ui.voice

import dev.jblaak.switchboard.link.LinkState
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.ServerMessage
import dev.jblaak.switchboard.protocol.VoiceResult
import dev.jblaak.switchboard.protocol.VoiceStatus
import dev.jblaak.switchboard.ui.connected.FakePhoneLink
import java.util.Base64
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class VoiceInputTest {

    private val link = FakePhoneLink()
    private val mic = FakeMic()
    private val heard = mutableListOf<String>()
    private var recordings = 0

    private fun TestScope.newVoice(): VoiceInput {
        return VoiceInput(link, mic, backgroundScope, now = { testScheduler.currentTime }, newVoiceId = { "v-${++recordings}" })
    }

    /** Started, and held for [heldFor]. */
    private fun TestScope.holding(heldFor: Long = 1_100): VoiceInput {
        val voice = newVoice()
        voice.start("s-1") { heard += it }
        advanceTimeBy(heldFor.milliseconds)
        return voice
    }

    /** Let go, and the mic handed over the rest. */
    private fun TestScope.letGo(voice: VoiceInput) {
        voice.stop()
        advanceTimeBy(200.milliseconds)
    }

    private fun chunks(): List<ClientMessage.VoiceChunk> = link.sent.filterIsInstance<ClientMessage.VoiceChunk>()

    @Test
    fun `starting tells the Mac which session it is for and records`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val voice = newVoice()

        /* When */
        voice.start("s-1") { heard += it }

        /* Then */
        assertEquals(listOf(ClientMessage.VoiceStart("v-1", "s-1")), link.sent)
        assertEquals(VoiceState.Recording(level = 0f, elapsedMillis = 0), voice.state.value)
        assertTrue(mic.recording)
    }

    @Test
    fun `while held the meter follows the mic and the timer runs`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        mic.level = 0.4f

        /* When */
        val voice = holding(heldFor = 301)

        /* Then */
        assertEquals(VoiceState.Recording(level = 0.4f, elapsedMillis = 300), voice.state.value)
    }

    @Test
    fun `the audio goes out in quarter-second chunks counted from 0`() = runTest(UnconfinedTestDispatcher()) {
        /* When */
        holding(heldFor = 1_001)

        /* Then */
        assertEquals(listOf(0, 1, 2, 3), chunks().map { it.seq })
        assertTrue(chunks().all { it.voiceId == "v-1" && Base64.getDecoder().decode(it.audio).size == 8_000 })
    }

    @Test
    fun `letting go waits for the mic to hand over the rest`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val voice = holding(heldFor = 1_100)

        /* When */
        voice.stop()

        /* Then */
        assertEquals(VoiceState.Transcribing, voice.state.value)
        assertEquals(listOf(0, 1, 2, 3), chunks().map { it.seq })
        assertFalse(link.sent.last() is ClientMessage.VoiceEnd)
    }

    @Test
    fun `audio the mic hands over after the let go is in the last chunk`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        mic.buffered = listOf(ByteArray(1_600) { 7 }, ByteArray(1_600) { 8 })
        val voice = holding(heldFor = 1_100)

        /* When */
        letGo(voice)

        /* Then */
        assertEquals(listOf(0, 1, 2, 3, 4), chunks().map { it.seq })
        val last = Base64.getDecoder().decode(chunks().last().audio)
        // The frame unsent at the let go, the one being read then, and the two the mic still held.
        assertEquals(6_400, last.size)
        assertTrue(last.takeLast(3_200).toByteArray().contentEquals(ByteArray(1_600) { 7 } + ByteArray(1_600) { 8 }))
        assertEquals(ClientMessage.VoiceEnd("v-1"), link.sent.last())
        assertFalse(mic.recording)
    }

    @Test
    fun `a mic that doesn't finish is cut off`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        mic.hangs = true
        val voice = holding()
        letGo(voice)

        /* When */
        advanceTimeBy(2_100.milliseconds)

        /* Then */
        assertEquals(ClientMessage.VoiceEnd("v-1"), link.sent.last())
        assertFalse(mic.recording)
    }

    @Test
    fun `the Mac's text goes to the box`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val voice = holding()
        letGo(voice)

        /* When */
        link.macSays(ServerMessage.VoiceTranscribed("v-1", VoiceResult.Text("Wrap the key bar.")))

        /* Then */
        assertEquals(listOf("Wrap the key bar."), heard)
        assertEquals(VoiceState.Idle, voice.state.value)
    }

    @Test
    fun `sliding off drops the recording`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val voice = holding()
        val sentBefore = link.sent.size

        /* When */
        voice.cancel()
        advanceTimeBy(1.seconds)

        /* Then */
        assertEquals(listOf(ClientMessage.VoiceCancel("v-1")), link.sent.drop(sentBefore))
        assertEquals(VoiceState.Idle, voice.state.value)
        assertFalse(mic.recording)
    }

    @Test
    fun `a tap is too short to send`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val voice = holding(heldFor = 499)

        /* When */
        voice.stop()

        /* Then */
        assertEquals(ClientMessage.VoiceCancel("v-1"), link.sent.last())
        assertEquals(VoiceState.Problem(VoiceProblem.TooShort), voice.state.value)
        assertFalse(mic.recording)
    }

    @Test
    fun `the Mac being unable to transcribe stops the recording`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val voice = holding(heldFor = 100)

        /* When */
        link.macSays(ServerMessage.VoiceTranscribed("v-1", VoiceResult.Unavailable(VoiceStatus.Preparing(0.4))))
        advanceTimeBy(1.seconds)

        /* Then */
        assertEquals(VoiceState.Problem(VoiceProblem.Preparing(0.4)), voice.state.value)
        assertTrue(chunks().isEmpty())
        assertFalse(mic.recording)
    }

    @Test
    fun `a preparing note follows the download`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val voice = holding(heldFor = 100)
        link.macSays(ServerMessage.VoiceTranscribed("v-1", VoiceResult.Unavailable(VoiceStatus.Preparing(0.4))))

        /* When */
        link.macSays(ServerMessage.VoiceStatusChanged(VoiceStatus.Preparing(0.5)))

        /* Then */
        assertEquals(VoiceState.Problem(VoiceProblem.Preparing(0.5)), voice.state.value)
    }

    @Test
    fun `a failed model download is said as such`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val voice = holding(heldFor = 100)

        /* When */
        link.macSays(ServerMessage.VoiceTranscribed("v-1", VoiceResult.Unavailable(VoiceStatus.PrepareFailed("offline"))))

        /* Then */
        assertEquals(VoiceState.Problem(VoiceProblem.PrepareFailed("offline")), voice.state.value)
    }

    @Test
    fun `silence comes back as nothing heard`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val voice = holding()
        letGo(voice)

        /* When */
        link.macSays(ServerMessage.VoiceTranscribed("v-1", VoiceResult.Empty))

        /* Then */
        assertEquals(VoiceState.Problem(VoiceProblem.NothingHeard), voice.state.value)
        assertTrue(heard.isEmpty())
    }

    @Test
    fun `a failed transcription says why`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val voice = holding()
        letGo(voice)

        /* When */
        link.macSays(ServerMessage.VoiceTranscribed("v-1", VoiceResult.Failed("whisper-cli crashed")))

        /* Then */
        assertEquals(VoiceState.Problem(VoiceProblem.Failed("whisper-cli crashed")), voice.state.value)
    }

    @Test
    fun `text for an earlier recording is ignored`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val voice = holding()
        voice.cancel()
        voice.start("s-1") { heard += it }
        advanceTimeBy(1.seconds)
        letGo(voice)

        /* When */
        link.macSays(ServerMessage.VoiceTranscribed("v-1", VoiceResult.Text("old")))

        /* Then */
        assertTrue(heard.isEmpty())
        assertEquals(VoiceState.Transcribing, voice.state.value)
    }

    @Test
    fun `no answer in a minute is a failure`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val voice = holding()
        letGo(voice)

        /* When */
        advanceTimeBy(61.seconds)

        /* Then */
        assertTrue((voice.state.value as VoiceState.Problem).problem is VoiceProblem.Failed)
    }

    @Test
    fun `without a connection nothing is recorded`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val voice = newVoice()
        link.state.value = LinkState.Reconnecting

        /* When */
        voice.start("s-1") { heard += it }

        /* Then */
        assertEquals(VoiceState.Problem(VoiceProblem.NotConnected), voice.state.value)
        assertTrue(link.sent.isEmpty())
        assertFalse(mic.recording)
    }

    @Test
    fun `losing the connection while held stops the recording`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val voice = holding()

        /* When */
        link.state.value = LinkState.Reconnecting

        /* Then */
        assertEquals(VoiceState.Problem(VoiceProblem.NotConnected), voice.state.value)
        assertFalse(mic.recording)
    }

    @Test
    fun `a missing whisper still records, so the Mac looks again`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val voice = newVoice()
        link.macSays(ServerMessage.VoiceStatusChanged(VoiceStatus.NoWhisper))

        /* When */
        voice.start(null) { heard += it }

        /* Then */
        assertEquals(listOf(ClientMessage.VoiceStart("v-1", null)), link.sent)
        assertEquals(VoiceState.Recording(level = 0f, elapsedMillis = 0), voice.state.value)
    }

    @Test
    fun `the Mac still missing whisper stops the mic`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val voice = holding(heldFor = 30)

        /* When */
        link.macSays(ServerMessage.VoiceTranscribed("v-1", VoiceResult.Unavailable(VoiceStatus.NoWhisper)))

        /* Then */
        assertEquals(VoiceState.Problem(VoiceProblem.NoWhisper), voice.state.value)
        assertFalse(mic.recording)
    }

    @Test
    fun `no microphone to open is said as such`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val voice = newVoice()
        mic.failure = MicrophoneUnavailableException("busy")

        /* When */
        voice.start("s-1") { heard += it }

        /* Then */
        assertEquals(VoiceState.Problem(VoiceProblem.NoMicrophone), voice.state.value)
        assertEquals(ClientMessage.VoiceCancel("v-1"), link.sent.last())
    }

    @Test
    fun `no permission for the microphone is said as such`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val voice = newVoice()
        mic.failure = SecurityException("RECORD_AUDIO")

        /* When */
        voice.start("s-1") { heard += it }

        /* Then */
        assertEquals(VoiceState.Problem(VoiceProblem.NoPermission), voice.state.value)
    }

    @Test
    fun `dismissing a problem goes back to idle`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val voice = holding(heldFor = 100)
        voice.stop()

        /* When */
        voice.dismissProblem()

        /* Then */
        assertEquals(VoiceState.Idle, voice.state.value)
    }
}

/**
 * A mic that hears a 50 ms frame of PCM at [level] every 50 ms of virtual time, or fails with [failure]. After the
 * let go it finishes the frame it was reading, then hands over [buffered] (10 ms apart), unless it [hangs].
 */
private class FakeMic : AudioSource {
    var level = 0.5f
    var failure: Throwable? = null
    var buffered = listOf(ByteArray(1_600))
    var hangs = false
    var recording = false

    override fun frames(letGo: StateFlow<Boolean>): Flow<AudioFrame> = flow {
        failure?.let { throw it }
        recording = true
        try {
            while (!letGo.value) {
                delay(50)
                emit(AudioFrame(ByteArray(1_600), level))
            }
            if (hangs) awaitCancellation()
            for (pcm in buffered) {
                delay(10)
                emit(AudioFrame(pcm, level))
            }
        } finally {
            recording = false
        }
    }
}
