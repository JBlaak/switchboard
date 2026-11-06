package dev.jblaak.switchboard.ui.session

import dev.jblaak.switchboard.link.LinkState
import dev.jblaak.switchboard.protocol.ChatMessage
import dev.jblaak.switchboard.protocol.ChatRole
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.MacFeatures
import dev.jblaak.switchboard.protocol.ServerMessage
import dev.jblaak.switchboard.ui.connected.DEVICE_ID
import dev.jblaak.switchboard.ui.connected.FakePhoneLink
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class ChatModelTest {

    private val link = FakePhoneLink().apply { state.value = connectedWithChat }

    private fun TestScope.newModel(sessionId: String = "s-1"): ChatModel = ChatModel(link, sessionId, backgroundScope)

    private fun message(id: String, text: String, role: ChatRole = ChatRole.Assistant) = ChatMessage(id, role, text)

    @Test
    fun `showing the chat subscribes to the session`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()

        /* When */
        model.show()

        /* Then */
        assertEquals(listOf(ClientMessage.ChatSubscribe("s-1")), link.sent)
    }

    @Test
    fun `the chat the Mac sends is shown, and what it appends is added at the end`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.show()

        /* When */
        link.macSays(ServerMessage.Chat("s-1", available = true, messages = listOf(message("u1:0", "Fix it", ChatRole.User))))
        link.macSays(ServerMessage.ChatAppend("s-1", listOf(message("a1:0", "Fixed."))))

        /* Then */
        assertEquals(
            ChatState.Shown(listOf(message("u1:0", "Fix it", ChatRole.User), message("a1:0", "Fixed."))),
            model.state.value,
        )
    }

    @Test
    fun `another session's chat is not shown`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.show()

        /* When */
        link.macSays(ServerMessage.Chat("s-2", available = true, messages = listOf(message("a1:0", "Elsewhere"))))

        /* Then */
        assertEquals(ChatState.Loading, model.state.value)
    }

    @Test
    fun `a session without a transcript on the Mac has no chat`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.show()

        /* When */
        link.macSays(ServerMessage.Chat("s-1", available = false, messages = emptyList()))

        /* Then */
        assertEquals(ChatState.Unavailable, model.state.value)
    }

    @Test
    fun `a Mac that doesn't name the chat is never sent a subscription`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        link.state.value = LinkState.Connected(DEVICE_ID, "joris-mbp.local")
        val model = newModel()

        /* When */
        model.show()

        /* Then */
        assertEquals(emptyList<ClientMessage>(), link.sent)
        assertEquals(ChatState.MacTooOld, model.state.value)
    }

    @Test
    fun `hiding the chat unsubscribes and keeps what it showed`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.show()
        link.macSays(ServerMessage.Chat("s-1", available = true, messages = listOf(message("a1:0", "Kept"))))

        /* When */
        model.hide()

        /* Then */
        assertEquals(ClientMessage.ChatUnsubscribe("s-1"), link.sent.last())
        assertEquals(ChatState.Shown(listOf(message("a1:0", "Kept"))), model.state.value)
    }

    @Test
    fun `a shown chat subscribes again after a reconnect`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.show()
        link.state.value = LinkState.Reconnecting

        /* When */
        link.state.value = connectedWithChat

        /* Then */
        assertEquals(listOf(ClientMessage.ChatSubscribe("s-1"), ClientMessage.ChatSubscribe("s-1")), link.sent)
    }

    @Test
    fun `a hidden chat stays unsubscribed after a reconnect`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        newModel()
        link.state.value = LinkState.Reconnecting

        /* When */
        link.state.value = connectedWithChat

        /* Then */
        assertEquals(emptyList<ClientMessage>(), link.sent)
    }

    @Test
    fun `the chat follows the session to its new id`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.show()

        /* When */
        link.macSays(ServerMessage.SessionRekeyed(from = "s-1", to = "s-9"))
        link.macSays(ServerMessage.Chat("s-9", available = true, messages = listOf(message("a1:0", "Planned"))))

        /* Then */
        assertEquals(ChatState.Shown(listOf(message("a1:0", "Planned"))), model.state.value)
    }

    @Test
    fun `only the latest messages are held`() = runTest(UnconfinedTestDispatcher()) {
        /* Given */
        val model = newModel()
        model.show()
        val many = (1..MAX_CHAT_MESSAGES).map { message("a$it:0", "Message $it") }
        link.macSays(ServerMessage.Chat("s-1", available = true, messages = many))

        /* When */
        link.macSays(ServerMessage.ChatAppend("s-1", listOf(message("new:0", "Newest"))))

        /* Then */
        val shown = (model.state.value as ChatState.Shown).messages
        assertEquals(MAX_CHAT_MESSAGES, shown.size)
        assertEquals(listOf("a2:0", "new:0"), listOf(shown.first().id, shown.last().id))
    }

    private companion object {
        val connectedWithChat = LinkState.Connected(DEVICE_ID, "joris-mbp.local", setOf(MacFeatures.CHAT))
    }
}
