package dev.jblaak.switchboard.protocol

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

@RunWith(Parameterized::class)
class ServerMessageFixtureTest(
    private val name: String,
    private val message: ServerMessage,
) {
    private val codec = ProtocolCodec()

    @Test
    fun `decodes from the JSON the Mac sends`() {
        /* Given */
        val text = fixture("server/$name")

        /* When */
        val decoded = codec.decode(text)

        /* Then */
        assertEquals(ServerMessageDecoding.Decoded(message), decoded)
    }

    @Test
    fun `encodes back the same`() {
        /* Given */
        val expected = jsonOf(fixture("server/$name"))

        /* When */
        val encoded = codec.json.encodeToString(ServerMessage.serializer(), message)

        /* Then */
        assertEquals(expected, jsonOf(encoded))
    }

    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun fixtures(): List<Array<Any>> = serverFixtures.map { (name, message) -> arrayOf(name, message) }
    }
}
