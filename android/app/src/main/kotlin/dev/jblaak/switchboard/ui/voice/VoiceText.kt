package dev.jblaak.switchboard.ui.voice

import androidx.annotation.StringRes
import dev.jblaak.switchboard.R
import kotlin.math.roundToInt

/** Dictated [heard] added to [text], with a space between. */
fun withDictated(text: String, heard: String): String {
    if (text.isBlank()) return heard
    return if (text.endsWith(' ') || text.endsWith('\n')) text + heard else "$text $heard"
}

/** How long the mic has been held, as m:ss. */
fun elapsedOf(millis: Long): String {
    val seconds = millis.coerceAtLeast(0) / 1000
    return "${seconds / 60}:${(seconds % 60).toString().padStart(2, '0')}"
}

/** A problem's note by the mic: its text, and whether it is something that went wrong rather than a hint. */
data class VoiceNote(@StringRes val text: Int, val args: List<Any>, val wrong: Boolean)

fun noteOf(problem: VoiceProblem): VoiceNote {
    return when (problem) {
        VoiceProblem.TooShort -> VoiceNote(R.string.voice_hold_to_talk, emptyList(), wrong = false)
        VoiceProblem.NothingHeard -> VoiceNote(R.string.voice_nothing_heard, emptyList(), wrong = false)
        VoiceProblem.NoPermission -> VoiceNote(R.string.voice_no_permission, emptyList(), wrong = true)
        VoiceProblem.NoMicrophone -> VoiceNote(R.string.voice_no_microphone, emptyList(), wrong = true)
        VoiceProblem.NotConnected -> VoiceNote(R.string.voice_not_connected, emptyList(), wrong = true)
        VoiceProblem.NoWhisper -> VoiceNote(R.string.voice_no_whisper, emptyList(), wrong = true)
        is VoiceProblem.Preparing -> when (val progress = problem.progress) {
            null -> VoiceNote(R.string.voice_preparing, emptyList(), wrong = false)
            else -> VoiceNote(R.string.voice_preparing_progress, listOf((progress * 100).roundToInt().coerceIn(0, 100)), wrong = false)
        }
        is VoiceProblem.PrepareFailed -> VoiceNote(R.string.voice_prepare_failed, listOf(problem.reason), wrong = true)
        is VoiceProblem.Failed -> VoiceNote(R.string.voice_failed, listOf(problem.reason), wrong = true)
    }
}

/** How long a problem's note stays up: long enough to read, longer when there is something to do about it. */
fun noteMillisOf(problem: VoiceProblem): Long {
    return when (problem) {
        VoiceProblem.TooShort, VoiceProblem.NothingHeard -> 2_500
        VoiceProblem.NoWhisper, is VoiceProblem.PrepareFailed, is VoiceProblem.Failed -> 8_000
        else -> 4_000
    }
}

/** The meter's recent [levels], oldest first, with [level] added and only the last [size] kept. */
fun withLevel(levels: List<Float>, level: Float, size: Int): List<Float> {
    return (levels + level.coerceIn(0f, 1f)).takeLast(size)
}
