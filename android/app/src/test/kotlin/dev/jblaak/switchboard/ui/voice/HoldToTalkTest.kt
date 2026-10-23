package dev.jblaak.switchboard.ui.voice

import kotlinx.coroutines.flow.MutableStateFlow
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HoldToTalkTest {

    private class FakeVoiceControls : VoiceControls {
        override val state = MutableStateFlow<VoiceState>(VoiceState.Idle)
        val calls = mutableListOf<String>()

        override fun start(sessionId: String?, onText: (String) -> Unit) {
            calls += "start $sessionId"
        }

        override fun stop() {
            calls += "stop"
        }

        override fun cancel() {
            calls += "cancel"
        }

        override fun dismissProblem() {
            calls += "dismiss"
        }
    }

    private val controls = FakeVoiceControls()
    private var permitted = true
    private var asked = 0
    private val voice = HoldToTalk(controls, sessionId = { "s-1" }, onText = {}, hasPermission = { permitted }, haptics = null)
        .apply { askPermission = { asked++ } }

    @Test
    fun `sliding less than the threshold does not cancel`() {
        /* Given */
        val threshold = 100f

        /* When */
        val off = slidOff(-60f, -70f, threshold)

        /* Then */
        assertFalse(off)
    }

    @Test
    fun `sliding the threshold away in any direction cancels`() {
        /* Given */
        val threshold = 100f

        /* When */
        val off = listOf(slidOff(-100f, 0f, threshold), slidOff(0f, -120f, threshold), slidOff(80f, 80f, threshold))

        /* Then */
        assertEquals(listOf(true, true, true), off)
    }

    @Test
    fun `a mic shows nothing of what another mic started`() {
        /* Given */
        val state = VoiceState.Recording(level = 0.5f, elapsedMillis = 1_000)

        /* When */
        val shown = shownVoiceOf(state, owns = false, localProblem = null)

        /* Then */
        assertEquals(VoiceState.Idle, shown)
    }

    @Test
    fun `a denied permission shows over what the controls are doing`() {
        /* Given */
        val state = VoiceState.Idle

        /* When */
        val shown = shownVoiceOf(state, owns = false, localProblem = VoiceProblem.NoPermission)

        /* Then */
        assertEquals(VoiceState.Problem(VoiceProblem.NoPermission), shown)
    }

    @Test
    fun `the first press without the microphone permission only asks for it`() {
        /* Given */
        permitted = false

        /* When */
        val started = voice.press()

        /* Then */
        assertFalse(started)
        assertEquals(1, asked)
        assertEquals(emptyList<String>(), controls.calls)
    }

    @Test
    fun `a press records for the session and letting go transcribes`() {
        /* Given */
        voice.press()

        /* When */
        voice.release()

        /* Then */
        assertEquals(listOf("start s-1", "stop"), controls.calls)
        assertTrue(voice.owns)
    }

    @Test
    fun `letting go after sliding away cancels`() {
        /* Given */
        voice.press()
        voice.slide(-150f, 0f, threshold = 100f)

        /* When */
        voice.release()

        /* Then */
        assertEquals(listOf("start s-1", "cancel"), controls.calls)
        assertFalse(voice.cancelling)
    }

    @Test
    fun `sliding back onto the mic before letting go still transcribes`() {
        /* Given */
        voice.press()
        voice.slide(-150f, 0f, threshold = 100f)
        voice.slide(-20f, 0f, threshold = 100f)

        /* When */
        voice.release()

        /* Then */
        assertEquals(listOf("start s-1", "stop"), controls.calls)
    }

    @Test
    fun `a hold taken away by the system cancels once`() {
        /* Given */
        voice.press()

        /* When */
        voice.abandon()
        voice.abandon()

        /* Then */
        assertEquals(listOf("start s-1", "cancel"), controls.calls)
    }

    @Test
    fun `a press while transcribing does nothing`() {
        /* Given */
        controls.state.value = VoiceState.Transcribing

        /* When */
        val started = voice.press()

        /* Then */
        assertFalse(started)
        assertEquals(emptyList<String>(), controls.calls)
    }

    @Test
    fun `dismissing a denied permission clears it here, not in the controls`() {
        /* Given */
        voice.denied()

        /* When */
        voice.dismiss()

        /* Then */
        assertEquals(null, voice.localProblem)
        assertEquals(emptyList<String>(), controls.calls)
    }

    @Test
    fun `dismissing the controls' problem tells the controls`() {
        /* Given */
        controls.state.value = VoiceState.Problem(VoiceProblem.NothingHeard)

        /* When */
        voice.dismiss()

        /* Then */
        assertEquals(listOf("dismiss"), controls.calls)
    }
}
