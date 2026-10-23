package dev.jblaak.switchboard.ui.connected

import dev.jblaak.switchboard.link.LinkState
import dev.jblaak.switchboard.link.MacLink
import dev.jblaak.switchboard.link.SendOutcome
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.ServerMessage
import dev.jblaak.switchboard.protocol.TerminalFrame
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow

/** What the connected screens need of the link to the Mac: [MacLink] in the app, a fake in tests. */
interface PhoneLink {
    val state: StateFlow<LinkState>

    /** Not replayed: a holder sees only what arrives after it starts collecting. */
    val messages: Flow<ServerMessage>

    val terminalFrames: Flow<TerminalFrame>

    fun send(message: ClientMessage): SendOutcome
}

fun MacLink.asPhoneLink(): PhoneLink {
    val link = this
    return object : PhoneLink {
        override val state: StateFlow<LinkState> = link.state
        override val messages: Flow<ServerMessage> = link.messages
        override val terminalFrames: Flow<TerminalFrame> = link.terminalFrames
        override fun send(message: ClientMessage): SendOutcome = link.send(message)
    }
}
