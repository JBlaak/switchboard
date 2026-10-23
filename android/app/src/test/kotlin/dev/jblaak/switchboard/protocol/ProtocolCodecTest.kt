package dev.jblaak.switchboard.protocol

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ProtocolCodecTest {

    private val codec = ProtocolCodec()

    @Test
    fun `a message with fields this app does not know decodes`() {
        /* Given */
        val text = """{"type":"exited","sessionId":"s-1","exitCode":1,"signal":"SIGTERM"}"""

        /* When */
        val decoded = codec.decode(text)

        /* Then */
        assertEquals(ServerMessageDecoding.Decoded(ServerMessage.Exited(sessionId = "s-1", exitCode = 1)), decoded)
    }

    @Test
    fun `an unknown message type is unreadable`() {
        /* Given */
        val text = """{"type":"weather","city":"Utrecht"}"""

        /* When */
        val decoded = codec.decode(text)

        /* Then */
        assertTrue(decoded is ServerMessageDecoding.Unreadable)
    }

    @Test
    fun `a message missing a field is unreadable`() {
        /* Given */
        val text = """{"type":"exited","sessionId":"s-1"}"""

        /* When */
        val decoded = codec.decode(text)

        /* Then */
        assertTrue(decoded is ServerMessageDecoding.Unreadable)
    }

    @Test
    fun `text that is not JSON is unreadable`() {
        /* Given */
        val text = "hello"

        /* When */
        val decoded = codec.decode(text)

        /* Then */
        assertTrue(decoded is ServerMessageDecoding.Unreadable)
    }

    @Test
    fun `an answer result without an error decodes with none`() {
        /* Given */
        val text = """{"type":"answer-result","sessionId":"s-1","toolUseId":"t","ok":true}"""

        /* When */
        val decoded = codec.decode(text)

        /* Then */
        assertEquals(
            ServerMessageDecoding.Decoded(ServerMessage.AnswerResult(sessionId = "s-1", toolUseId = "t", ok = true, error = null)),
            decoded,
        )
    }

    @Test
    fun `the hello carries this app's protocol version`() {
        /* Given */
        val hello = ClientMessage.Hello(protocol = PROTOCOL_VERSION, appVersion = "0.1.0")

        /* When */
        val encoded = codec.encode(hello)

        /* Then */
        assertEquals(jsonOf("""{"type":"hello","protocol":1,"appVersion":"0.1.0"}"""), jsonOf(encoded))
    }
}
