package dev.jblaak.switchboard.ui.voice

import dev.jblaak.switchboard.R
import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceTextTest {

    @Test
    fun `dictated text fills an empty box`() {
        /* Given */
        val text = "  "

        /* When */
        val result = withDictated(text, "fix the key bar")

        /* Then */
        assertEquals("fix the key bar", result)
    }

    @Test
    fun `dictated text goes after what is typed, with a space between`() {
        /* Given */
        val text = "Please"

        /* When */
        val result = withDictated(text, "fix the key bar")

        /* Then */
        assertEquals("Please fix the key bar", result)
    }

    @Test
    fun `dictated text adds no second space after a space or a new line`() {
        /* Given */
        val texts = listOf("Please ", "Please\n")

        /* When */
        val results = texts.map { withDictated(it, "fix it") }

        /* Then */
        assertEquals(listOf("Please fix it", "Please\nfix it"), results)
    }

    @Test
    fun `the time held reads as minutes and seconds`() {
        /* Given */
        val millis = listOf(0L, 999L, 7_400L, 63_000L, 600_000L)

        /* When */
        val texts = millis.map(::elapsedOf)

        /* Then */
        assertEquals(listOf("0:00", "0:00", "0:07", "1:03", "10:00"), texts)
    }

    @Test
    fun `a hold that was too short reads as a hint to hold`() {
        /* Given */
        val problem = VoiceProblem.TooShort

        /* When */
        val note = noteOf(problem)

        /* Then */
        assertEquals(VoiceNote(R.string.voice_hold_to_talk, emptyList(), wrong = false), note)
    }

    @Test
    fun `getting voice ready shows its progress as a percentage when known`() {
        /* Given */
        val problems = listOf(VoiceProblem.Preparing(0.428), VoiceProblem.Preparing(null))

        /* When */
        val notes = problems.map(::noteOf)

        /* Then */
        assertEquals(
            listOf(
                VoiceNote(R.string.voice_preparing_progress, listOf(43), wrong = false),
                VoiceNote(R.string.voice_preparing, emptyList(), wrong = false),
            ),
            notes,
        )
    }

    @Test
    fun `a failure says why`() {
        /* Given */
        val problems = listOf(VoiceProblem.Failed("whisper crashed"), VoiceProblem.PrepareFailed("no disk space"))

        /* When */
        val notes = problems.map(::noteOf)

        /* Then */
        assertEquals(
            listOf(
                VoiceNote(R.string.voice_failed, listOf("whisper crashed"), wrong = true),
                VoiceNote(R.string.voice_prepare_failed, listOf("no disk space"), wrong = true),
            ),
            notes,
        )
    }

    @Test
    fun `a note with something to do about it stays up longer than a hint`() {
        /* Given */
        val hint = VoiceProblem.TooShort
        val todo = VoiceProblem.NoWhisper

        /* When */
        val hintMillis = noteMillisOf(hint)
        val todoMillis = noteMillisOf(todo)

        /* Then */
        assertEquals(true, todoMillis > hintMillis)
    }

    @Test
    fun `the meter keeps only its most recent levels, clamped to 0 to 1`() {
        /* Given */
        val levels = listOf(0.1f, 0.2f, 0.3f)

        /* When */
        val result = withLevel(levels, 1.4f, size = 3)

        /* Then */
        assertEquals(listOf(0.2f, 0.3f, 1f), result)
    }
}
