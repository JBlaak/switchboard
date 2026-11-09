package dev.jblaak.switchboard.ui.questions

import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import dev.jblaak.switchboard.protocol.GrillView
import dev.jblaak.switchboard.protocol.PendingQuestions
import dev.jblaak.switchboard.protocol.QuestionsSource
import dev.jblaak.switchboard.theme.SwitchboardTheme
import dev.jblaak.switchboard.ui.connected.PhoneLink
import dev.jblaak.switchboard.ui.connected.rememberScopedModel
import dev.jblaak.switchboard.ui.voice.rememberHoldToTalk
import dev.jblaak.switchboard.ui.voice.withDictated
import kotlinx.coroutines.flow.StateFlow

/**
 * The question sheet over a session, for one [set]; [onClose] when it is answered, withdrawn or put off. A grilling
 * round shows the grilling card, drawn from the round's view in [grills] rather than from the set's questions.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QuestionSheetRoute(
    link: PhoneLink,
    grills: StateFlow<List<GrillView>>,
    set: PendingQuestions,
    sessionName: String?,
    onClose: () -> Unit,
) {
    // Dragging the sheet down closes it as its close button does: the sheet's own drag, which the options' scroll
    // only hands on once it is back at the top. Sideways swipes between questions are the sheets' own.
    ModalBottomSheet(
        onDismissRequest = onClose,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = SwitchboardTheme.colors.bgPanel,
    ) {
        if (set.source == QuestionsSource.Grill) {
            GrillSheet(link, grills, set, sessionName, onClose)
        } else {
            AskSheet(link, set, sessionName, onClose)
        }
    }
}

@Composable
private fun AskSheet(link: PhoneLink, set: PendingQuestions, sessionName: String?, onClose: () -> Unit) {
    val model = rememberScopedModel(set.toolUseId) { scope -> QuestionSheetModel(link, set, scope) }
    val state by model.state.collectAsState()
    val close by rememberUpdatedState(onClose)
    LaunchedEffect(state.phase) {
        if (state.phase == QuestionPhase.Done || state.phase == QuestionPhase.Withdrawn) close()
    }
    val voice = rememberHoldToTalk(set.sessionId) { heard -> model.type(withDictated(model.state.value.draft.ownWords, heard)) }
    val actions = remember(model) {
        object : QuestionSheetActions {
            override fun pick(label: String) = model.pick(label)
            override fun type(text: String) = model.type(text)
            override fun next() = model.next()
            override fun back() = model.back()
            override fun failureSeen() = model.failureSeen()
            override fun later() = close()
            override fun swipe(to: QuestionSwipe) = model.swipe(to)
        }
    }
    QuestionSheetContent(state, sessionName, actions, voice)
}

@Composable
private fun GrillSheet(
    link: PhoneLink,
    grills: StateFlow<List<GrillView>>,
    set: PendingQuestions,
    sessionName: String?,
    onClose: () -> Unit,
) {
    val model = rememberScopedModel(set.toolUseId) { scope -> GrillSheetModel(link, grills, set, scope) }
    val state by model.state.collectAsState()
    val close by rememberUpdatedState(onClose)
    LaunchedEffect(state.phase) {
        if (state.phase == GrillPhase.Done || state.phase == GrillPhase.Withdrawn) close()
    }
    val voice = rememberHoldToTalk(set.sessionId) { heard ->
        model.type(withDictated(model.state.value.field?.text.orEmpty(), heard))
    }
    val actions = remember(model) {
        object : GrillSheetActions {
            override fun accept() = model.accept()
            override fun pick(letter: String) = model.pick(letter)
            override fun open(field: GrillFieldKind) = model.open(field)
            override fun type(text: String) = model.type(text)
            override fun commit() = model.commit()
            override fun closeField() = model.closeField()
            override fun waitWhat() = model.waitWhat()
            override fun skip() = model.skip()
            override fun back() = model.back()
            override fun goTo(place: Int) = model.goTo(place)
            override fun dismissBanner() = model.dismissBanner()
            override fun send() = model.send()
            override fun queue() = model.queue()
            override fun cancelQueue() = model.cancelQueue()
            override fun errorSeen() = model.errorSeen()
            override fun close() = close()
            override fun swipe(to: QuestionSwipe) = model.swipe(to)
        }
    }
    GrillSheetContent(state, sessionName, actions, voice)
}
