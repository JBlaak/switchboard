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
    fun `sliding less than the thresholds neither locks nor cancels`() {
        /* Given */
        val lockAt = 72f
        val cancelAt = 96f

        /* When */
        val slide = slideOf(-60f, -50f, lockAt, cancelAt)

        /* Then */
        assertEquals(Slide.None, slide)
    }

    @Test
    fun `sliding up past the lock threshold locks`() {
        /* Given */
        val lockAt = 72f
        val cancelAt = 96f

        /* When */
        val slide = slideOf(-20f, -80f, lockAt, cancelAt)

        /* Then */
        assertEquals(Slide.Lock, slide)
    }

    @Test
    fun `sliding left past the cancel threshold cancels`() {
        /* Given */
        val lockAt = 72f
        val cancelAt = 96f

        /* When */
        val slide = slideOf(-100f, -40f, lockAt, cancelAt)

        /* Then */
        assertEquals(Slide.Cancel, slide)
    }

    @Test
    fun `sliding down or right does nothing however far`() {
        /* Given */
        val lockAt = 72f
        val cancelAt = 96f

        /* When */
        val slides = listOf(slideOf(0f, 300f, lockAt, cancelAt), slideOf(300f, 0f, lockAt, cancelAt))

        /* Then */
        assertEquals(listOf(Slide.None, Slide.None), slides)
    }

    @Test
    fun `a slide up and left goes the way it went further`() {
        /* Given */
        val lockAt = 72f
        val cancelAt = 96f

        /* When */
        val slides = listOf(slideOf(-100f, -130f, lockAt, cancelAt), slideOf(-130f, -100f, lockAt, cancelAt))

        /* Then */
        assertEquals(listOf(Slide.Lock, Slide.Cancel), slides)
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
        voice.slide(-150f, 0f, lockAt = 72f, cancelAt = 100f)

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
        voice.slide(-150f, 0f, lockAt = 72f, cancelAt = 100f)
        voice.slide(-20f, 0f, lockAt = 72f, cancelAt = 100f)

        /* When */
        voice.release()

        /* Then */
        assertEquals(listOf("start s-1", "stop"), controls.calls)
    }

    @Test
    fun `sliding up locks and letting go keeps recording`() {
        /* Given */
        voice.press()
        voice.slide(0f, -100f, lockAt = 72f, cancelAt = 100f)

        /* When */
        voice.release()

        /* Then */
        assertEquals(listOf("start s-1"), controls.calls)
        assertTrue(voice.locked)
        assertTrue(voice.holding)
    }

    @Test
    fun `stop on a locked recording transcribes, as letting go does`() {
        /* Given */
        voice.press()
        voice.slide(0f, -100f, lockAt = 72f, cancelAt = 100f)
        voice.release()

        /* When */
        voice.stop()

        /* Then */
        assertEquals(listOf("start s-1", "stop"), controls.calls)
        assertFalse(voice.locked)
        assertFalse(voice.holding)
    }

    @Test
    fun `cancel on a locked recording drops it`() {
        /* Given */
        voice.press()
        voice.slide(0f, -100f, lockAt = 72f, cancelAt = 100f)
        voice.release()

        /* When */
        voice.cancel()

        /* Then */
        assertEquals(listOf("start s-1", "cancel"), controls.calls)
        assertFalse(voice.locked)
    }

    @Test
    fun `once locked, sliding left no longer cancels`() {
        /* Given */
        voice.press()
        voice.slide(0f, -100f, lockAt = 72f, cancelAt = 100f)

        /* When */
        voice.slide(-200f, 0f, lockAt = 72f, cancelAt = 100f)
        voice.release()

        /* Then */
        assertFalse(voice.cancelling)
        assertTrue(voice.locked)
        assertEquals(listOf("start s-1"), controls.calls)
    }

    @Test
    fun `sliding left past the threshold then up locks instead of cancelling`() {
        /* Given */
        voice.press()
        voice.slide(-150f, 0f, lockAt = 72f, cancelAt = 100f)

        /* When */
        voice.slide(-20f, -150f, lockAt = 72f, cancelAt = 100f)

        /* Then */
        assertFalse(voice.cancelling)
        assertTrue(voice.locked)
    }

    @Test
    fun `stop without a lock does nothing`() {
        /* Given */
        voice.press()

        /* When */
        voice.stop()
        voice.cancel()

        /* Then */
        assertEquals(listOf("start s-1"), controls.calls)
        assertTrue(voice.holding)
    }

    @Test
    fun `a locked recording the controls ended on their own is no longer locked`() {
        /* Given */
        voice.press()
        voice.slide(0f, -100f, lockAt = 72f, cancelAt = 100f)
        voice.release()

        /* When */
        voice.controlsNow(VoiceState.Problem(VoiceProblem.NotConnected))

        /* Then */
        assertFalse(voice.locked)
        assertFalse(voice.holding)
        assertEquals(listOf("start s-1"), controls.calls)
    }

    @Test
    fun `the mic leaving the screen drops a locked recording`() {
        /* Given */
        voice.press()
        voice.slide(0f, -100f, lockAt = 72f, cancelAt = 100f)
        voice.release()

        /* When */
        voice.abandon()

        /* Then */
        assertEquals(listOf("start s-1", "cancel"), controls.calls)
        assertFalse(voice.locked)
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
