package dev.jblaak.switchboard.ui.session

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import dev.jblaak.switchboard.protocol.PendingQuestions
import dev.jblaak.switchboard.ui.connected.PhoneLink
import dev.jblaak.switchboard.ui.connected.SessionBoard
import dev.jblaak.switchboard.ui.connected.rememberScopedModel
import dev.jblaak.switchboard.ui.questions.QuestionSheetRoute

/** A session's screen, wired to its [SessionModel], with the question sheet over it when asked for. */
@Composable
fun SessionRoute(
    link: PhoneLink,
    board: SessionBoard,
    deviceId: String,
    sessionId: String,
    startedIn: String?,
    questionsOpen: Boolean,
    onBack: () -> Unit,
) {
    val model = rememberScopedModel(sessionId, onLeave = SessionModel::close) { scope ->
        SessionModel(link, board, deviceId, sessionId, startedIn, scope)
    }
    val state by model.state.collectAsState()
    var prompt by rememberSaveable { mutableStateOf("") }
    var sheetSet by remember { mutableStateOf<PendingQuestions?>(null) }
    var sheetWanted by remember { mutableStateOf(questionsOpen) }

    LaunchedEffect(sheetWanted, state.pendingQuestions) {
        val pending = state.pendingQuestions
        if (sheetWanted && pending != null && sheetSet == null) {
            sheetSet = pending
            sheetWanted = false
        }
    }
    BackHandler(onBack = onBack)

    SessionScreen(
        state = state,
        prompt = prompt,
        onPromptChange = { prompt = it },
        onSend = {
            model.sendPrompt(prompt)
            prompt = ""
        },
        onKey = model::press,
        onUseHere = model::useHere,
        onAnswer = { sheetWanted = true },
        onStartedNoteDismissed = model::startedNoteDismissed,
        onBack = onBack,
        terminal = { modifier ->
            TerminalView(
                writes = model.terminalWrites,
                onOpened = model::terminalOpened,
                onResized = model::terminalResized,
                modifier = modifier,
            )
        },
    )
    sheetSet?.let { set ->
        QuestionSheetRoute(link, set, state.name, onClose = { sheetSet = null })
    }
}
