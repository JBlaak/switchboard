package dev.jblaak.switchboard.ui.voice

import org.junit.Assert.assertEquals
import org.junit.Test

class LevelTest {

    private fun pcmOf(vararg samples: Int): ByteArray {
        return samples.flatMap { listOf((it and 0xFF).toByte(), (it shr 8).toByte()) }.toByteArray()
    }

    @Test
    fun `silence is an empty meter`() {
        /* Given */
        val pcm = pcmOf(0, 0, 0, 0)

        /* When */
        val level = levelOf(pcm)

        /* Then */
        assertEquals(0f, level)
    }

    @Test
    fun `full scale is a full meter`() {
        /* Given */
        val pcm = pcmOf(-32_768, -32_768)

        /* When */
        val level = levelOf(pcm)

        /* Then */
        assertEquals(1f, level)
    }

    @Test
    fun `a tenth of full scale fills most of the meter`() {
        /* Given: a tenth of full scale, -20 dB, either way round */
        val pcm = pcmOf(3_277, -3_277)

        /* When */
        val level = levelOf(pcm)

        /* Then */
        assertEquals(0.6f, level, 0.01f)
    }
}
