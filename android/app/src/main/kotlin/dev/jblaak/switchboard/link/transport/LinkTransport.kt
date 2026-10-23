package dev.jblaak.switchboard.link.transport

import dev.jblaak.switchboard.link.discovery.MacAddress
import dev.jblaak.switchboard.link.identity.DeviceKey
import kotlinx.coroutines.channels.ReceiveChannel

/** Opens the WebSocket to a Mac: mutual TLS 1.3, the device key as client certificate, the Mac's pinned. */
interface LinkTransport {

    fun open(address: MacAddress, key: DeviceKey, macFingerprint: String): LinkConnection
}

/** One WebSocket. Its [events] end with a [TransportEvent.Closed] or [TransportEvent.Failed]. */
interface LinkConnection {

    val events: ReceiveChannel<TransportEvent>

    /** False when the socket is already closing or gone. */
    fun send(text: String): Boolean

    fun close(code: Int, reason: String)
}

sealed interface TransportEvent {

    data object Opened : TransportEvent

    data class Text(val text: String) : TransportEvent

    class Binary(val bytes: ByteArray) : TransportEvent

    /** The Mac closed the WebSocket with [code], one of the protocol's close codes or a standard one. */
    data class Closed(val code: Int, val reason: String) : TransportEvent

    data class Failed(val failure: TransportFailure) : TransportEvent
}

enum class TransportFailure {
    /** The server's certificate is not the pinned one. */
    WrongMac,

    /** The pinned Mac completed the handshake, then turned the connection away: it does not know this key. */
    Refused,

    /** No answer, or the connection broke before the Mac identified itself. */
    Unreachable,

    /** An open connection broke without a closing handshake. */
    Dropped,
}
