package dev.jblaak.switchboard.protocol

/**
 * The wire protocol version this app speaks: PROTOCOL_VERSION in `src/domain/phone/protocol.ts`, the source of
 * truth for every shape in this package. Change the two together.
 */
const val PROTOCOL_VERSION = 1

/** The Bonjour service type the Mac advertises. */
const val BONJOUR_SERVICE_TYPE = "_switchboard._tcp"

/** The WebSocket close codes the Mac ends a connection with, each of which the app shows a screen for. */
enum class CloseReason(val code: Int) {
    /** A malformed or unexpected message. */
    ProtocolError(4000),

    /** The versions differ: "Update the app". */
    UpdateRequired(4001),

    /** The device is not, or no longer, enrolled: "No longer paired". */
    NotPaired(4003),

    /** Phone access was turned off on the Mac. */
    TurnedOff(4004),

    /** A pairing attempt ended (accepted, declined, expired); reconnect as paired or not. */
    PairingOver(4005),
    ;

    companion object {
        fun fromCodeOrNull(code: Int): CloseReason? = entries.firstOrNull { it.code == code }
    }
}
