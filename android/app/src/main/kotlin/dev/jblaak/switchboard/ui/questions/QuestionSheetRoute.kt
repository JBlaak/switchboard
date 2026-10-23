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
import dev.jblaak.switchboard.protocol.PendingQuestions
import dev.jblaak.switchboard.theme.SwitchboardTheme
import dev.jblaak.switchboard.ui.connected.PhoneLink
import dev.jblaak.switchboard.ui.connected.rememberScopedModel
import dev.jblaak.switchboard.ui.voice.rememberHoldToTalk
import dev.jblaak.switchboard.ui.voice.withDictated

/** The question sheet over a session, for one [set]; [onClose] when it is answered, withdrawn or put off. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun QuestionSheetRoute(link: PhoneLink, set: PendingQuestions, sessionName: String?, onClose: () -> Unit) {
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
            override fun skip() = model.skip()
            override fun acceptRecommendation() = model.acceptRecommendation()
            override fun failureSeen() = model.failureSeen()
            override fun later() = close()
        }
    }
    ModalBottomSheet(
        onDismissRequest = onClose,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = SwitchboardTheme.colors.bgPanel,
    ) {
        QuestionSheetContent(state, sessionName, actions, voice)
    }
}
