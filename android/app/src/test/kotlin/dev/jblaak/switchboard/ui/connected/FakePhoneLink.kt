package dev.jblaak.switchboard.ui.connected

import dev.jblaak.switchboard.link.LinkState
import dev.jblaak.switchboard.link.SendOutcome
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.PendingQuestions
import dev.jblaak.switchboard.protocol.PhoneSession
import dev.jblaak.switchboard.protocol.Question
import dev.jblaak.switchboard.protocol.QuestionOption
import dev.jblaak.switchboard.protocol.QuestionsSource
import dev.jblaak.switchboard.protocol.ServerMessage
import dev.jblaak.switchboard.protocol.SessionState
import dev.jblaak.switchboard.protocol.TerminalFrame
import dev.jblaak.switchboard.protocol.TerminalOwner
import dev.jblaak.switchboard.protocol.WaitingReason
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow

/** The Mac's side of the link, scripted: what it says arrives on the flows, what the phone sends is kept in [sent]. */
class FakePhoneLink : PhoneLink {
    override val state = MutableStateFlow<LinkState>(LinkState.Connected(DEVICE_ID, "joris-mbp.local"))
    override val messages = MutableSharedFlow<ServerMessage>(extraBufferCapacity = 64)
    override val terminalFrames = MutableSharedFlow<TerminalFrame>(extraBufferCapacity = 64)

    val sent = mutableListOf<ClientMessage>()

    override fun send(message: ClientMessage): SendOutcome {
        if (state.value !is LinkState.Connected) return SendOutcome.NotConnected
        sent += message
        return SendOutcome.Sent
    }

    fun macSays(message: ServerMessage) {
        check(messages.tryEmit(message))
    }

    fun macStreams(sessionId: String, output: String) {
        check(terminalFrames.tryEmit(TerminalFrame(sessionId, output)))
    }
}

const val DEVICE_ID = "device-1"

val THIS_PHONE = TerminalOwner.Device(DEVICE_ID, "Pixel 9")

fun phoneSession(
    id: String,
    state: SessionState = SessionState.Idle,
    owner: TerminalOwner = TerminalOwner.Mac,
    waiting: WaitingReason? = null,
): PhoneSession {
    return PhoneSession(
        id = id,
        name = "Session $id",
        project = "switchboard",
        projectPath = "/Users/joris/Development/JBlaak/switchboard",
        remote = null,
        state = state,
        waiting = waiting,
        owner = owner,
        changedAt = 0,
    )
}

fun question(text: String, multiSelect: Boolean = false, vararg labels: String): Question {
    return Question(text, header = "", options = labels.map { QuestionOption(it, "") }, multiSelect = multiSelect)
}

fun pendingQuestions(
    sessionId: String,
    toolUseId: String = "toolu_1",
    source: QuestionsSource = QuestionsSource.Ask,
    questions: List<Question> = listOf(question("Which transport?", false, "WebSocket (Recommended)", "HTTP")),
): PendingQuestions {
    return PendingQuestions(sessionId, toolUseId, source, questions, askedAt = 0, deadline = null)
}
