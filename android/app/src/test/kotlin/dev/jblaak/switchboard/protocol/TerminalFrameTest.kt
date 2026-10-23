package dev.jblaak.switchboard.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalFrameTest {

    @Test
    fun `a frame splits into its session id and output`() {
        /* Given */
        val bytes = frame("s-1", "\u001b[32mok\u001b[0m\r\n")

        /* When */
        val decoded = TerminalFrame.decodeOrNull(bytes)

        /* Then */
        assertEquals(TerminalFrame(sessionId = "s-1", output = "\u001b[32mok\u001b[0m\r\n"), decoded)
    }

    @Test
    fun `the id length counts bytes, not characters`() {
        /* Given */
        val bytes = frame("sessie-é", "─ ✓ 日本")

        /* When */
        val decoded = TerminalFrame.decodeOrNull(bytes)

        /* Then */
        assertEquals(TerminalFrame(sessionId = "sessie-é", output = "─ ✓ 日本"), decoded)
    }

    @Test
    fun `the id length is read big-endian`() {
        /* Given */
        val id = "x".repeat(300)
        val bytes = frame(id, "out")

        /* When */
        val decoded = TerminalFrame.decodeOrNull(bytes)

        /* Then */
        assertEquals(TerminalFrame(sessionId = id, output = "out"), decoded)
    }

    @Test
    fun `a frame may carry no output`() {
        /* Given */
        val bytes = frame("s-1", "")

        /* When */
        val decoded = TerminalFrame.decodeOrNull(bytes)

        /* Then */
        assertEquals(TerminalFrame(sessionId = "s-1", output = ""), decoded)
    }

    @Test
    fun `a frame shorter than its header is unreadable`() {
        /* Given */
        val bytes = byteArrayOf(0)

        /* When */
        val decoded = TerminalFrame.decodeOrNull(bytes)

        /* Then */
        assertNull(decoded)
    }

    @Test
    fun `a frame shorter than the id it announces is unreadable`() {
        /* Given */
        val bytes = byteArrayOf(0, 10) + "s-1".encodeToByteArray()

        /* When */
        val decoded = TerminalFrame.decodeOrNull(bytes)

        /* Then */
        assertNull(decoded)
    }

    private fun frame(sessionId: String, output: String): ByteArray {
        val id = sessionId.encodeToByteArray()
        val header = byteArrayOf((id.size shr 8).toByte(), (id.size and 0xFF).toByte())
        return header + id + output.encodeToByteArray()
    }
}
