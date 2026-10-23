package dev.jblaak.switchboard.ui.voice

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.FlowCollector
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn

/** 50 ms of audio per frame keeps the meter lively; the voice input batches frames into larger chunks to send. */
private const val FRAME_BYTES = BYTES_PER_SECOND / 20

/** The microphone through [AudioRecord], tuned for speech where the phone offers it. */
class MicAudioSource : AudioSource {

    // The caller holds RECORD_AUDIO; without it AudioRecord throws the SecurityException frames() documents.
    @SuppressLint("MissingPermission")
    override fun frames(letGo: StateFlow<Boolean>): Flow<AudioFrame> = flow {
        val record = open()
        try {
            record.startRecording()
            if (record.recordingState != AudioRecord.RECORDSTATE_RECORDING) {
                throw MicrophoneUnavailableException("The microphone didn't start (another app may be using it)")
            }
            val buffer = ByteArray(FRAME_BYTES)
            while (!letGo.value) {
                currentCoroutineContext().ensureActive()
                val read = record.read(buffer, 0, buffer.size)
                if (read < 0) throw MicrophoneUnavailableException("AudioRecord.read failed: $read")
                if (read > 0) emit(frameOf(buffer, read))
            }
            // Let go: catch up on what the mic recorded meanwhile, stop it, and take whatever it still holds.
            drain(record, buffer)
            record.stop()
            drain(record, buffer)
        } finally {
            if (record.recordingState == AudioRecord.RECORDSTATE_RECORDING) record.stop()
            record.release()
        }
    }.flowOn(Dispatchers.IO)

    /** Emits what [record] has buffered, without waiting for more. */
    private suspend fun FlowCollector<AudioFrame>.drain(record: AudioRecord, buffer: ByteArray) {
        repeat(MAX_DRAIN_READS) {
            val read = record.read(buffer, 0, buffer.size, AudioRecord.READ_NON_BLOCKING)
            if (read <= 0) return
            emit(frameOf(buffer, read))
        }
    }

    private fun frameOf(buffer: ByteArray, length: Int): AudioFrame {
        val pcm = buffer.copyOf(length)
        return AudioFrame(pcm, levelOf(pcm))
    }

    @SuppressLint("MissingPermission")
    private fun open(): AudioRecord {
        val minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
        if (minimum <= 0) throw MicrophoneUnavailableException("No recording at $SAMPLE_RATE Hz: $minimum")
        val size = maxOf(minimum, FRAME_BYTES * 4)
        for (source in listOf(MediaRecorder.AudioSource.VOICE_RECOGNITION, MediaRecorder.AudioSource.MIC)) {
            val record = try {
                AudioRecord(source, SAMPLE_RATE, CHANNEL, ENCODING, size)
            } catch (exception: IllegalArgumentException) {
                null
            }
            if (record?.state == AudioRecord.STATE_INITIALIZED) return record
            record?.release()
        }
        throw MicrophoneUnavailableException("No microphone could be opened")
    }

    private companion object {
        const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
        const val ENCODING = AudioFormat.ENCODING_PCM_16BIT

        /** A second of frames: more than the mic buffers. */
        const val MAX_DRAIN_READS = 20
    }
}
