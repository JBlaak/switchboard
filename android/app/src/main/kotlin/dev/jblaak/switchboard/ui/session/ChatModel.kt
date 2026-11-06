package dev.jblaak.switchboard.ui.session

import dev.jblaak.switchboard.link.LinkState
import dev.jblaak.switchboard.link.SendOutcome
import dev.jblaak.switchboard.protocol.ChatMessage
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.MacFeatures
import dev.jblaak.switchboard.protocol.ServerMessage
import dev.jblaak.switchboard.ui.connected.PhoneLink
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** The most messages the chat view holds; the oldest go first. */
const val MAX_CHAT_MESSAGES = 500

/**
 * A session's chat view: its transcript as messages, which the Mac sends while the view is shown. Follows the
 * session through re-keys, and subscribes again after every reconnect, since the Mac forgets a subscription when
 * the connection drops. What it was sent stays while the view is hidden, so showing it again starts where it was.
 */
class ChatModel(
    private val link: PhoneLink,
    sessionId: String,
    scope: CoroutineScope,
) {

    private var sessionId = sessionId
    private var shown = false
    private var subscribed = false

    private val mutableState = MutableStateFlow<ChatState>(ChatState.Loading)
    val state: StateFlow<ChatState> = mutableState.asStateFlow()

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            link.messages.collect { receive(it) }
        }
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            var wasConnected = link.state.value is LinkState.Connected
            link.state.collect { linkState ->
                val connected = linkState is LinkState.Connected
                if (connected && !wasConnected && shown) subscribe()
                if (!connected) subscribed = false
                wasConnected = connected
            }
        }
    }

    /** The chat view is on screen: follow the session. */
    fun show() {
        if (shown) return
        shown = true
        subscribe()
    }

    /** The terminal is on screen instead, or the screen is going: stop following. */
    fun hide() {
        shown = false
        if (subscribed) link.send(ClientMessage.ChatUnsubscribe(sessionId))
        subscribed = false
    }

    private fun subscribe() {
        val connected = link.state.value as? LinkState.Connected ?: return
        if (MacFeatures.CHAT !in connected.features) {
            mutableState.value = ChatState.MacTooOld
            return
        }
        subscribed = link.send(ClientMessage.ChatSubscribe(sessionId)) == SendOutcome.Sent
    }

    private fun receive(message: ServerMessage) {
        when (message) {
            is ServerMessage.SessionRekeyed -> if (message.from == sessionId) sessionId = message.to
            is ServerMessage.Chat -> if (message.sessionId == sessionId) {
                mutableState.value = if (message.available) {
                    ChatState.Shown(message.messages.takeLast(MAX_CHAT_MESSAGES))
                } else {
                    ChatState.Unavailable
                }
            }
            is ServerMessage.ChatAppend -> if (message.sessionId == sessionId) {
                val current = mutableState.value as? ChatState.Shown ?: return
                mutableState.value = ChatState.Shown((current.messages + message.messages).takeLast(MAX_CHAT_MESSAGES))
            }
            else -> Unit
        }
    }
}

/** What the chat view shows. */
sealed interface ChatState {
    /** Asked for, not answered yet. */
    data object Loading : ChatState

    /** The Mac's Switchboard predates the chat view. */
    data object MacTooOld : ChatState

    /** The session has no transcript on the Mac: a terminal, an SSH or VM session. */
    data object Unavailable : ChatState

    /** Oldest first. */
    data class Shown(val messages: List<ChatMessage>) : ChatState
}
