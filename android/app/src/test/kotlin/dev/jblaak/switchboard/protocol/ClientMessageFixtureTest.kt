package dev.jblaak.switchboard.protocol

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized

@RunWith(Parameterized::class)
class ClientMessageFixtureTest(
    private val name: String,
    private val message: ClientMessage,
) {
    private val codec = ProtocolCodec()

    @Test
    fun `encodes to the JSON the Mac reads`() {
        /* Given */
        val expected = jsonOf(fixture("client/$name"))

        /* When */
        val encoded = codec.encode(message)

        /* Then */
        assertEquals(expected, jsonOf(encoded))
    }

    @Test
    fun `decodes back from the fixture`() {
        /* Given */
        val text = fixture("client/$name")

        /* When */
        val decoded = codec.json.decodeFromString(ClientMessage.serializer(), text)

        /* Then */
        assertEquals(message, decoded)
    }

    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun fixtures(): List<Array<Any>> = clientFixtures.map { (name, message) -> arrayOf(name, message) }
    }
}
