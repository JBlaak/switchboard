package dev.jblaak.switchboard.ui.ask

import androidx.activity.compose.BackHandler
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import dev.jblaak.switchboard.ui.connected.PhoneLink
import dev.jblaak.switchboard.ui.connected.SessionBoard
import dev.jblaak.switchboard.ui.connected.rememberScopedModel
import dev.jblaak.switchboard.ui.voice.rememberHoldToTalk
import dev.jblaak.switchboard.ui.voice.withDictated
import java.util.UUID

/** Ask Patch, wired to its [AskModel]. */
@Composable
fun AskRoute(
    link: PhoneLink,
    board: SessionBoard,
    onSessionStarted: (sessionId: String, project: String) -> Unit,
    onClose: () -> Unit,
) {
    val started by rememberUpdatedState(onSessionStarted)
    val closed by rememberUpdatedState(onClose)
    val model = rememberScopedModel(Unit, onLeave = AskModel::close) { scope ->
        val events = object : AskModel.Events {
            override fun askSessionStarted(sessionId: String, project: String) = started(sessionId, project)
            override fun askClosed() = closed()
        }
        AskModel(link, board, events, newRequestId = { UUID.randomUUID().toString() }, scope)
    }
    val step by model.state.collectAsState()
    val voice = rememberHoldToTalk(sessionId = null) { heard ->
        val compose = model.state.value as? AskStep.Compose
        if (compose != null) model.type(withDictated(compose.text, heard))
    }
    val actions = remember(model) {
        object : AskActions {
            override fun type(text: String) = model.type(text)
            override fun ask() = model.ask()
            override fun pickProjectMyself() = model.pickProjectMyself()
            override fun anotherProject() = model.anotherProject()
            override fun filter(text: String) = model.filter(text)
            override fun start(projectPath: String) = model.start(projectPath)
            override fun back() = model.back()
        }
    }
    BackHandler(onBack = model::back)
    AskScreen(step, actions, voice)
}
