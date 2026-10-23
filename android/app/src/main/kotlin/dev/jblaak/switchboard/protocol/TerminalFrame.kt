package dev.jblaak.switchboard.protocol

/**
 * One chunk of a session's output, from a binary WebSocket frame laid out as
 * `[u16 big-endian: byte length of the session id][session id, UTF-8][output, UTF-8]`
 * (see "Terminal frames" in `src/domain/phone/protocol.ts`).
 */
data class TerminalFrame(
    val sessionId: String,
    /** The text the Mac's terminal is fed, to be written to the phone's terminal as is. */
    val output: String,
) {
    companion object {
        /** Null when [bytes] is too short for the session id its header announces. */
        fun decodeOrNull(bytes: ByteArray): TerminalFrame? {
            if (bytes.size < 2) return null
            val idLength = ((bytes[0].toInt() and 0xFF) shl 8) or (bytes[1].toInt() and 0xFF)
            val outputStart = 2 + idLength
            if (bytes.size < outputStart) return null
            return TerminalFrame(
                sessionId = bytes.decodeToString(2, outputStart),
                output = bytes.decodeToString(outputStart, bytes.size),
            )
        }
    }
}
