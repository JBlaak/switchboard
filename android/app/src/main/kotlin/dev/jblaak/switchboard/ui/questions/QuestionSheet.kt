package dev.jblaak.switchboard.ui.questions

import android.content.res.Configuration
import androidx.compose.animation.AnimatedContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.protocol.AnsweredOn
import dev.jblaak.switchboard.protocol.PendingQuestions
import dev.jblaak.switchboard.protocol.Question
import dev.jblaak.switchboard.protocol.QuestionOption
import dev.jblaak.switchboard.protocol.QuestionsSource
import dev.jblaak.switchboard.theme.SwitchboardTheme
import dev.jblaak.switchboard.ui.connected.CheckIcon
import dev.jblaak.switchboard.ui.connected.MicIcon
import dev.jblaak.switchboard.ui.connected.PhoneIcon

/** What the question sheet can be asked to do. */
interface QuestionSheetActions {
    fun pick(label: String)
    fun type(text: String)
    fun next()
    fun back()
    fun skip()
    fun acceptRecommendation()
    fun dictate()
    fun failureSeen()
    fun later()
}

/** The inside of the question sheet: a question of the set, or why the set went away. */
@Composable
fun QuestionSheetContent(state: QuestionSheetState, sessionName: String?, actions: QuestionSheetActions) {
    Column(Modifier.navigationBarsPadding()) {
        when (val phase = state.phase) {
            is QuestionPhase.AnsweredElsewhere -> AnsweredElsewhere(phase.on, actions)
            else -> {
                SheetHeader(state, sessionName)
                AnimatedContent(
                    targetState = state.step,
                    label = "question step",
                    modifier = Modifier.weight(1f, fill = false),
                ) { step ->
                    val question = state.set.questions[step]
                    val draft = state.drafts[step]
                    Column {
                        if (state.isGrill) GrillQuestion(question, draft, actions) else AskQuestion(question, draft, actions)
                    }
                }
                SheetFooter(state, actions)
            }
        }
    }
}

@Composable
private fun SheetHeader(state: QuestionSheetState, sessionName: String?) {
    val colors = SwitchboardTheme.colors
    val tone = if (state.isGrill) colors.pinned else colors.remote
    val chip = if (state.isGrill) stringResource(R.string.questions_grill_round) else state.question.header
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 4.dp),
    ) {
        if (chip.isNotEmpty()) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .height(26.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(tone.fill)
                    .padding(horizontal = 10.dp),
            ) {
                Text(chip, style = MaterialTheme.typography.labelMedium.copy(fontSize = 12.sp), color = tone.ink)
            }
        }
        Text(
            text = sessionName.orEmpty(),
            style = MaterialTheme.typography.bodySmall,
            color = colors.textMuted,
            maxLines = 1,
            modifier = Modifier.weight(1f),
        )
        if (state.set.questions.size > 1) {
            Text(
                text = stringResource(R.string.questions_step, state.step + 1, state.set.questions.size),
                style = MaterialTheme.typography.labelMedium,
                color = colors.textDim,
            )
        }
    }
    if (state.set.questions.size > 1) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 12.dp),
        ) {
            state.set.questions.indices.forEach { index ->
                val color = when {
                    index == state.step -> colors.accent
                    index < state.step -> colors.running.dot
                    else -> colors.line
                }
                Box(
                    Modifier
                        .weight(1f)
                        .height(4.dp)
                        .clip(RoundedCornerShape(2.dp))
                        .background(color),
                )
            }
        }
    }
}

@Composable
private fun ColumnScope.AskQuestion(question: Question, draft: Draft, actions: QuestionSheetActions) {
    val colors = SwitchboardTheme.colors
    QuestionTitle(question.question)
    Text(
        text = stringResource(if (question.multiSelect) R.string.questions_hint_multi else R.string.questions_hint_single),
        style = MaterialTheme.typography.bodyMedium,
        color = colors.textMuted,
        modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 18.dp),
    )
    Column(
        verticalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier
            .weight(1f, fill = false)
            .verticalScroll(rememberScrollState())
            .padding(horizontal = 12.dp),
    ) {
        for (option in question.options) {
            OptionRow(option, picked = option.label in draft.picked, multiSelect = question.multiSelect, onClick = { actions.pick(option.label) })
        }
        OwnWordsField(
            text = draft.ownWords,
            placeholder = stringResource(R.string.questions_own_words),
            onChange = actions::type,
            onDictate = actions::dictate,
            shape = MaterialTheme.shapes.medium,
        )
    }
}

@Composable
private fun QuestionTitle(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.headlineSmall.copy(fontSize = 21.sp, lineHeight = 28.sp),
        color = SwitchboardTheme.colors.textStrong,
        modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 22.dp, bottom = 6.dp),
    )
}

@Composable
private fun OptionRow(option: QuestionOption, picked: Boolean, multiSelect: Boolean, onClick: () -> Unit) {
    val colors = SwitchboardTheme.colors
    val shape = MaterialTheme.shapes.medium
    val selection = if (multiSelect) {
        Modifier.toggleable(value = picked, role = Role.Checkbox, onValueChange = { onClick() })
    } else {
        Modifier.selectable(selected = picked, role = Role.RadioButton, onClick = onClick)
    }
    Row(
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (picked) colors.running.fill else colors.bgRaised)
            .border(if (picked) 1.5.dp else 0.dp, if (picked) colors.accent else colors.bgRaised, shape)
            .then(selection)
            .padding(16.dp),
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .padding(top = 2.dp)
                .size(20.dp)
                .clip(if (multiSelect) RoundedCornerShape(6.dp) else CircleShape)
                .border(2.dp, if (picked) colors.accent else colors.borderStrong, if (multiSelect) RoundedCornerShape(6.dp) else CircleShape),
        ) {
            if (picked) {
                if (multiSelect) {
                    Icon(CheckIcon, contentDescription = null, tint = colors.accent, modifier = Modifier.size(14.dp))
                } else {
                    Box(
                        Modifier
                            .size(10.dp)
                            .clip(CircleShape)
                            .background(colors.accent),
                    )
                }
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    displayLabelOf(option.label),
                    style = MaterialTheme.typography.titleSmall,
                    color = colors.textStrong,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (isRecommended(option.label)) RecommendedBadge()
            }
            if (option.description.isNotEmpty()) {
                Text(option.description, style = MaterialTheme.typography.bodySmall, color = colors.textMuted)
            }
        }
    }
}

@Composable
private fun RecommendedBadge() {
    val colors = SwitchboardTheme.colors
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .height(20.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(colors.running.fill)
            .padding(horizontal = 8.dp),
    ) {
        Text(
            stringResource(R.string.questions_recommended),
            style = MaterialTheme.typography.labelSmall.copy(fontSize = 11.sp, letterSpacing = 0.sp),
            color = colors.accent,
        )
    }
}

@Composable
private fun OwnWordsField(
    text: String,
    placeholder: String,
    onChange: (String) -> Unit,
    onDictate: () -> Unit,
    shape: androidx.compose.ui.graphics.Shape,
) {
    val colors = SwitchboardTheme.colors
    BasicTextField(
        value = text,
        onValueChange = onChange,
        textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp, color = colors.textStrong),
        cursorBrush = SolidColor(colors.accent),
        maxLines = 4,
        decorationBox = { field ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 52.dp)
                    .clip(shape)
                    .background(colors.bgRaised)
                    .border(1.dp, colors.borderStrong, shape)
                    .padding(start = 16.dp, end = 4.dp),
            ) {
                Box(Modifier.weight(1f).padding(vertical = 12.dp)) {
                    if (text.isEmpty()) Text(placeholder, style = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp), color = colors.textFaint)
                    field()
                }
                IconButton(onClick = onDictate, modifier = Modifier.size(40.dp)) {
                    Icon(MicIcon, contentDescription = stringResource(R.string.questions_dictate), tint = colors.textDim, modifier = Modifier.size(20.dp))
                }
            }
        },
    )
}

@Composable
private fun ColumnScope.GrillQuestion(question: Question, draft: Draft, actions: QuestionSheetActions) {
    val colors = SwitchboardTheme.colors
    val recommendation = question.options.firstOrNull()
    Column(
        Modifier
            .weight(1f, fill = false)
            .verticalScroll(rememberScrollState()),
    ) {
        QuestionTitle(question.question)
        question.detail?.let {
            Text(
                text = it,
                style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 23.sp),
                color = colors.textDim,
                modifier = Modifier.padding(start = 20.dp, end = 20.dp, bottom = 18.dp),
            )
        }
        if (recommendation != null) {
            Column(
                verticalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier
                    .padding(horizontal = 12.dp)
                    .fillMaxWidth()
                    .clip(MaterialTheme.shapes.medium)
                    .background(colors.running.fill)
                    .padding(16.dp),
            ) {
                Text(
                    stringResource(R.string.questions_claude_recommends).uppercase(),
                    style = MaterialTheme.typography.labelSmall.copy(letterSpacing = 0.6.sp),
                    color = colors.accent,
                )
                Text(recommendation.description, style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 22.sp), color = colors.textStrong)
            }
        }
        Column(
            verticalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(start = 12.dp, end = 12.dp, top = 8.dp),
        ) {
            for (option in question.options.drop(1)) {
                OptionRow(option, picked = option.label in draft.picked, multiSelect = false, onClick = { actions.pick(option.label) })
            }
        }
    }
    Spacer(Modifier.height(16.dp))
    HorizontalDivider(color = colors.line)
    Column(
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 16.dp),
    ) {
        PrimaryButton(
            text = stringResource(R.string.questions_grill_yes),
            onClick = actions::acceptRecommendation,
            leadingCheck = true,
        )
        OwnWordsField(
            text = draft.ownWords,
            placeholder = stringResource(R.string.questions_grill_own_words),
            onChange = actions::type,
            onDictate = actions::dictate,
            shape = RoundedCornerShape(26.dp),
        )
    }
}

@Composable
private fun SheetFooter(state: QuestionSheetState, actions: QuestionSheetActions) {
    val colors = SwitchboardTheme.colors
    val phase = state.phase
    Column(
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 20.dp),
    ) {
        if (phase is QuestionPhase.Failed) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = phase.error ?: stringResource(R.string.questions_not_sent),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.danger,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = actions::failureSeen) {
                    Text(stringResource(R.string.questions_try_again), color = colors.accent)
                }
            }
        }
        if (state.isGrill) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                TextButton(onClick = actions::back, enabled = state.step > 0) {
                    Text(stringResource(R.string.questions_back), style = MaterialTheme.typography.labelMedium.copy(fontSize = 14.sp))
                }
                Text(
                    text = if (state.set.questions.size > 1) {
                        stringResource(R.string.questions_grill_one_reply)
                    } else {
                        ""
                    },
                    style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp),
                    color = colors.textFaint,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.weight(1f),
                )
                TextButton(onClick = if (state.draft.ownWords.isNotBlank() || state.draft.picked.isNotEmpty()) actions::next else actions::skip) {
                    Text(
                        stringResource(
                            when {
                                state.draft.ownWords.isNotBlank() || state.draft.picked.isNotEmpty() ->
                                    if (state.isLastStep) R.string.questions_send else R.string.questions_next
                                else -> R.string.questions_skip
                            },
                        ),
                        style = MaterialTheme.typography.labelMedium.copy(fontSize = 14.sp),
                    )
                }
            }
        } else {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(PhoneIcon, contentDescription = null, tint = colors.textFaint, modifier = Modifier.size(14.dp))
                Text(stringResource(R.string.questions_moves_here), style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp), color = colors.textFaint)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton(
                    onClick = if (state.step > 0) actions::back else actions::later,
                    modifier = Modifier
                        .weight(1f)
                        .height(48.dp),
                ) {
                    Text(
                        stringResource(if (state.step > 0) R.string.questions_back else R.string.questions_later),
                        style = MaterialTheme.typography.titleSmall,
                        color = colors.textStrong,
                    )
                }
                Button(
                    onClick = actions::next,
                    enabled = state.canGoOn && phase == QuestionPhase.Answering,
                    colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.onAccent),
                    modifier = Modifier
                        .weight(2f)
                        .height(48.dp),
                ) {
                    Text(
                        stringResource(
                            when {
                                phase == QuestionPhase.Sending -> R.string.questions_sending
                                state.isLastStep -> R.string.questions_send
                                else -> R.string.questions_next
                            },
                        ),
                        style = MaterialTheme.typography.labelLarge,
                    )
                }
            }
        }
    }
}

@Composable
private fun PrimaryButton(text: String, onClick: () -> Unit, leadingCheck: Boolean) {
    val colors = SwitchboardTheme.colors
    Button(
        onClick = onClick,
        colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.onAccent),
        modifier = Modifier
            .fillMaxWidth()
            .height(52.dp),
    ) {
        if (leadingCheck) {
            Icon(CheckIcon, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.size(10.dp))
        }
        Text(text, style = MaterialTheme.typography.labelLarge.copy(fontSize = 16.sp))
    }
}

@Composable
private fun AnsweredElsewhere(on: AnsweredOn, actions: QuestionSheetActions) {
    val colors = SwitchboardTheme.colors
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 20.dp, end = 20.dp, top = 24.dp, bottom = 24.dp),
    ) {
        Text(
            stringResource(if (on == AnsweredOn.Mac) R.string.questions_answered_on_mac else R.string.questions_answered_on_phone),
            style = MaterialTheme.typography.headlineSmall,
            color = colors.textStrong,
        )
        Text(
            stringResource(R.string.questions_answered_body),
            style = MaterialTheme.typography.bodyMedium,
            color = colors.textMuted,
            textAlign = TextAlign.Center,
        )
        Spacer(Modifier.height(4.dp))
        PrimaryButton(stringResource(R.string.questions_close), actions::later, leadingCheck = false)
    }
}

private val previewActions = object : QuestionSheetActions {
    override fun pick(label: String) = Unit
    override fun type(text: String) = Unit
    override fun next() = Unit
    override fun back() = Unit
    override fun skip() = Unit
    override fun acceptRecommendation() = Unit
    override fun dictate() = Unit
    override fun failureSeen() = Unit
    override fun later() = Unit
}

private fun previewSheet(source: QuestionsSource, questions: List<Question>, phase: QuestionPhase, picked: List<String>): QuestionSheetState {
    return QuestionSheetState(
        set = PendingQuestions("s-1", "toolu_1", source, questions, askedAt = 0, deadline = null),
        step = 0,
        drafts = questions.mapIndexed { index, _ -> Draft(if (index == 0) picked else emptyList(), ownWords = "") },
        phase = phase,
    )
}

private val previewAskQuestions = listOf(
    Question(
        question = "How long should a pairing code stay valid?",
        header = "Pairing",
        options = listOf(
            QuestionOption("Two minutes (Recommended)", "Long enough to scan, short enough that a photo is useless."),
            QuestionOption("Five minutes", "Room to find the phone first."),
            QuestionOption("Until used", "Simplest, but a leaked code stays live."),
        ),
        multiSelect = false,
    ),
    Question("Which screens first?", "Screens", listOf(QuestionOption("Sessions", ""), QuestionOption("Terminal", "")), true),
    Question("Anything else?", "", emptyList(), false),
)

private val previewGrillQuestions = listOf(
    Question("Where should the code live?", "Q1", listOf(QuestionOption("Yes (Recommended)", "In the domain."), QuestionOption("Wait, what?", "")), false),
    Question(
        question = "Where should a snoozed session's row go?",
        header = "Q2",
        options = listOf(
            QuestionOption("Yes (Recommended)", "One \"Snoozed\" section across projects, soonest wake first."),
            QuestionOption("Wait, what?", "Have Claude re-pitch this one in plain words (/wait-what)"),
        ),
        multiSelect = false,
        detail = "Today a snoozed row drops into a collapsed group at the bottom of its project. That keeps the board calm, but you lose sight of when each one wakes up.",
    ),
)

@Composable
private fun SheetPreviewOf(state: QuestionSheetState) {
    SwitchboardTheme {
        Surface(color = SwitchboardTheme.colors.bgPanel, shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)) {
            QuestionSheetContent(state, sessionName = "Phone access pairing flow", actions = previewActions)
        }
    }
}

@Preview(name = "Question dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Question light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun QuestionSheetPreview() {
    SheetPreviewOf(previewSheet(QuestionsSource.Ask, previewAskQuestions, QuestionPhase.Answering, picked = listOf("Two minutes (Recommended)")))
}

@Preview(name = "Grill dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Grill light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun GrillSheetPreview() {
    SheetPreviewOf(previewSheet(QuestionsSource.Grill, previewGrillQuestions, QuestionPhase.Answering, picked = emptyList()).copy(step = 1))
}

@Preview(name = "Answered on Mac dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Answered on Mac light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun AnsweredOnMacSheetPreview() {
    SheetPreviewOf(previewSheet(QuestionsSource.Ask, previewAskQuestions, QuestionPhase.AnsweredElsewhere(AnsweredOn.Mac), picked = emptyList()))
}

@Preview(name = "Failed dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Failed light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun FailedSheetPreview() {
    SheetPreviewOf(
        previewSheet(QuestionsSource.Ask, previewAskQuestions.take(1), QuestionPhase.Failed("Those questions are no longer waiting"), picked = listOf("Five minutes")),
    )
}
