package dev.jblaak.switchboard.ui.voice

import kotlin.math.log10
import kotlin.math.sqrt
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

/** 16 kHz mono signed 16-bit little-endian PCM, as the Mac takes it. */
const val SAMPLE_RATE = 16_000
const val BYTES_PER_SECOND = SAMPLE_RATE * 2

/** The phone's microphone: [MicAudioSource] in the app, a script in tests. */
interface AudioSource {

    /**
     * Records in short frames of [SAMPLE_RATE] mono PCM16 until [letGo] turns true, then hands over what was
     * already recorded and completes, so the last word isn't clipped. Cancelling the collector drops the rest at
     * once. Fails with [MicrophoneUnavailableException] when there is no microphone to open, or
     * [SecurityException] without RECORD_AUDIO.
     */
    fun frames(letGo: StateFlow<Boolean>): Flow<AudioFrame>
}

/** A frame of PCM and its loudness, 0–1, for the meter. */
class AudioFrame(val pcm: ByteArray, val level: Float)

class MicrophoneUnavailableException(message: String) : Exception(message)

/** Quieter than this is an empty meter; the meter follows decibels so that speech fills it. */
private const val FLOOR_DB = -50.0

/** The RMS loudness of little-endian PCM16 [pcm], on a decibel scale from 0 (at [FLOOR_DB] and below) to 1 (full scale). */
fun levelOf(pcm: ByteArray): Float {
    val samples = pcm.size / 2
    if (samples == 0) return 0f
    var sum = 0.0
    for (i in 0 until samples) {
        val sample = (pcm[2 * i].toInt() and 0xFF) or (pcm[2 * i + 1].toInt() shl 8)
        sum += sample.toDouble() * sample
    }
    val rms = sqrt(sum / samples) / 32_768.0
    if (rms <= 0.0) return 0f
    return ((20 * log10(rms) - FLOOR_DB) / -FLOOR_DB).coerceIn(0.0, 1.0).toFloat()
}
