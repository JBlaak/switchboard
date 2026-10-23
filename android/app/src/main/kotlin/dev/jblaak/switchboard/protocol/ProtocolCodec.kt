package dev.jblaak.switchboard.protocol

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/**
 * Turns protocol messages into the JSON text frames they travel as, and back. Unknown keys are ignored, so a
 * Mac that added an optional field does not break an older app.
 */
class ProtocolCodec {

    internal val json = Json {
        classDiscriminator = "type"
        ignoreUnknownKeys = true
    }

    fun encode(message: ClientMessage): String = json.encodeToString(ClientMessage.serializer(), message)

    fun decode(text: String): ServerMessageDecoding {
        return try {
            ServerMessageDecoding.Decoded(json.decodeFromString(ServerMessage.serializer(), text))
        } catch (exception: SerializationException) {
            ServerMessageDecoding.Unreadable(exception.message.orEmpty())
        } catch (exception: IllegalArgumentException) {
            ServerMessageDecoding.Unreadable(exception.message.orEmpty())
        }
    }
}

/** What a text frame from the Mac turned out to be. */
sealed interface ServerMessageDecoding {

    data class Decoded(val message: ServerMessage) : ServerMessageDecoding

    /** Not JSON, an unknown `type`, or a known one with fields missing or of the wrong kind. */
    data class Unreadable(val reason: String) : ServerMessageDecoding
}
