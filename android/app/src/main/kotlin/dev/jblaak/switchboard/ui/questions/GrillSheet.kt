package dev.jblaak.switchboard.ui.questions

import android.content.res.Configuration
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.components.webLinksIn
import dev.jblaak.switchboard.protocol.Choice
import dev.jblaak.switchboard.protocol.Choices
import dev.jblaak.switchboard.protocol.GrillAnswer
import dev.jblaak.switchboard.protocol.GrillMark
import dev.jblaak.switchboard.protocol.GrillQuestionView
import dev.jblaak.switchboard.protocol.GrillSendState
import dev.jblaak.switchboard.protocol.GrillView
import dev.jblaak.switchboard.theme.JetBrainsMonoFamily
import dev.jblaak.switchboard.theme.StatusColors
import dev.jblaak.switchboard.theme.SwitchboardTheme
import dev.jblaak.switchboard.ui.voice.HoldToTalk

/** What the grilling sheet can be asked to do; [GrillSheetModel] in the app. */
interface GrillSheetActions {
    fun accept()
    fun pick(letter: String)
    fun open(field: GrillFieldKind)
    fun type(text: String)
    fun commit()
    fun closeField()
    fun waitWhat()
    fun skip()
    fun back()
    fun goTo(place: Int)
    fun dismissBanner()
    fun send()
    fun queue()
    fun cancelQueue()
    fun errorSeen()
    fun close()
}

/**
 * The grilling card on the phone: a round's questions one at a time, with Claude's recommendation to take, a note
 * to add or an answer of your own, then a review of exactly what Claude will receive. [voice] dictates into the
 * open text field.
 */
@Composable
fun GrillSheetContent(state: GrillSheetState, sessionName: String?, actions: GrillSheetActions, voice: HoldToTalk?) {
    Column(Modifier.navigationBarsPadding()) {
        val phase = state.phase
        val view = state.view
        when {
            phase is GrillPhase.AnsweredElsewhere -> AnsweredElsewhere(phase.on, actions::close)
            view == null -> Loading()
            else -> {
                GrillHeader(state, view, sessionName)
                HorizontalDivider(color = SwitchboardTheme.colors.line)
                Column(
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                    modifier = Modifier
                        .weight(1f, fill = false)
                        .verticalScroll(rememberScrollState())
                        .padding(horizontal = 16.dp, vertical = 14.dp),
                ) {
                    Pips(state, actions)
                    Banner(state, actions)
                    val question = state.question
                    if (question == null) {
                        Review(state, actions)
                    } else {
                        QuestionCard(state, question, actions)
                        AnswerButtons(state, actions, voice)
                    }
                }
                GrillFooter(state, actions)
            }
        }
    }
}

@Composable
private fun Loading() {
    Text(
        stringResource(R.string.questions_grill_loading),
        style = MaterialTheme.typography.bodyMedium,
        color = SwitchboardTheme.colors.textMuted,
        textAlign = TextAlign.Center,
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 40.dp, horizontal = 20.dp),
    )
}

@Composable
private fun GrillHeader(state: GrillSheetState, view: GrillView, sessionName: String?) {
    val colors = SwitchboardTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 4.dp, bottom = 10.dp),
    ) {
        Text(
            text = sessionName.orEmpty(),
            style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.ExtraBold),
            color = colors.textStrong,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        if (view.agentsRunning > 0) {
            Chip(pluralStringResource(R.plurals.questions_grill_agents, view.agentsRunning, view.agentsRunning), colors.ready)
        }
        Chip(stringResource(R.string.questions_grill_answered, state.answeredCount, view.questions.size), colors.needsYou)
    }
}

@Composable
private fun Chip(text: String, tone: StatusColors) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(tone.fill)
            .padding(horizontal = 9.dp, vertical = 2.dp),
    ) {
        Text(text, style = MaterialTheme.typography.labelSmall.copy(fontSize = 11.sp, letterSpacing = 0.sp), color = tone.ink)
    }
}

/** A bar per question, drawn by how it is answered, and one for the review; the current one ringed. */
@Composable
private fun Pips(state: GrillSheetState, actions: GrillSheetActions) {
    val colors = SwitchboardTheme.colors
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        state.questions.forEachIndexed { place, question ->
            val answer = state.answerAt(place)
            val label = stringResource(R.string.questions_grill_counter, question.number, place + 1, state.questions.size)
            Pip(
                current = state.place == place,
                modifier = Modifier
                    .weight(1f)
                    .semantics { contentDescription = label },
                onClick = { actions.goTo(place) },
            ) {
                when {
                    answer is GrillAnswer.Accepted -> drawRect(colors.textStrong)
                    answer is GrillAnswer.Overridden -> drawRect(colors.accent)
                    answer is GrillAnswer.Noted -> {
                        drawRect(colors.textStrong, size = Size(size.width / 2, size.height))
                        drawRect(colors.accent, topLeft = Offset(size.width / 2, 0f), size = Size(size.width / 2, size.height))
                    }
                    question.asked -> {
                        drawRect(colors.line)
                        val dash = 5.dp.toPx()
                        val gap = 4.dp.toPx()
                        var x = 0f
                        while (x < size.width) {
                            drawRect(colors.accent, topLeft = Offset(x, 0f), size = Size(minOf(dash, size.width - x), size.height))
                            x += dash + gap
                        }
                    }
                    else -> drawRect(colors.line)
                }
            }
        }
        val review = stringResource(R.string.questions_grill_review)
        Pip(
            current = state.onReview,
            modifier = Modifier
                .width(40.dp)
                .semantics { contentDescription = review },
            onClick = { actions.goTo(state.questions.size) },
        ) { drawRect(colors.borderStrong) }
    }
}

@Composable
private fun Pip(
    current: Boolean,
    modifier: Modifier,
    onClick: () -> Unit,
    draw: androidx.compose.ui.graphics.drawscope.DrawScope.() -> Unit,
) {
    val accent = SwitchboardTheme.colors.accent
    Box(
        modifier = modifier
            .clip(RoundedCornerShape(4.dp))
            .clickable(role = Role.Tab, onClick = onClick)
            .padding(vertical = 8.dp),
    ) {
        Box(
            Modifier
                .fillMaxWidth()
                .height(if (current) 6.dp else 4.dp)
                .then(if (current) Modifier.border(1.dp, accent, RoundedCornerShape(3.dp)).padding(1.dp) else Modifier)
                .clip(RoundedCornerShape(3.dp))
                .drawBehind(draw),
        )
    }
}

/** "Not sent" after a revision cancelled a queued send, else the revision banner, else nothing. */
@Composable
private fun Banner(state: GrillSheetState, actions: GrillSheetActions) {
    val colors = SwitchboardTheme.colors
    val counts = state.revisionBanner
    when {
        state.showsNotSent -> BannerRow(
            text = stringResource(R.string.questions_grill_not_sent),
            alert = true,
            action = null,
        )
        counts != null -> {
            val parts = listOfNotNull(
                counts.changed.takeIf { it > 0 }?.let { stringResource(R.string.questions_grill_revised_changed, it) },
                counts.added.takeIf { it > 0 }?.let { stringResource(R.string.questions_grill_revised_new, it) },
                counts.dropped.takeIf { it > 0 }?.let { stringResource(R.string.questions_grill_revised_dropped, it) },
            )
            BannerRow(
                text = stringResource(R.string.questions_grill_revised, parts.joinToString(", ")),
                alert = false,
                action = { TextButton(onClick = actions::dismissBanner) { Text(stringResource(R.string.questions_grill_dismiss), color = colors.needsYou.ink) } },
            )
        }
    }
    state.error?.let { error ->
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = when (error) {
                    GrillError.NotConnected -> stringResource(R.string.questions_grill_not_connected)
                    is GrillError.FromMac -> error.text
                },
                style = MaterialTheme.typography.bodySmall,
                color = colors.danger,
                modifier = Modifier
                    .weight(1f)
                    .semantics { liveRegion = LiveRegionMode.Polite },
            )
            TextButton(onClick = actions::errorSeen) {
                Text(stringResource(R.string.questions_grill_dismiss), color = colors.accent)
            }
        }
    }
}

@Composable
private fun BannerRow(text: String, alert: Boolean, action: (@Composable () -> Unit)?) {
    val tone = SwitchboardTheme.colors.needsYou
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .background(tone.fill)
            .then(if (alert) Modifier.drawBehind { drawRect(tone.ink, size = Size(3.dp.toPx(), size.height)) } else Modifier)
            .padding(start = 14.dp, end = 4.dp, top = 10.dp, bottom = 10.dp)
            .semantics { liveRegion = if (alert) LiveRegionMode.Assertive else LiveRegionMode.Polite },
    ) {
        Text(
            text,
            style = MaterialTheme.typography.labelMedium,
            color = tone.ink,
            modifier = Modifier
                .weight(1f)
                .padding(end = 10.dp),
        )
        action?.invoke()
    }
}

@Composable
private fun QuestionCard(state: GrillSheetState, question: GrillQuestionView, actions: GrillSheetActions) {
    val colors = SwitchboardTheme.colors
    val place = state.place
    Column {
        Text(
            stringResource(R.string.questions_grill_counter, question.number, place + 1, state.questions.size).uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = colors.textFaint,
        )
        Text(
            markdown(question.title),
            style = MaterialTheme.typography.headlineSmall.copy(fontSize = 20.sp, lineHeight = 25.sp, fontWeight = FontWeight.ExtraBold),
            color = colors.textStrong,
            modifier = Modifier.padding(top = 4.dp),
        )
    }
    RevisionNote(question)
    val reasonStyle = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp, lineHeight = 21.sp)
    val choices = question.choices
    if (choices == null) {
        Text(markdown(question.reason), style = reasonStyle, color = colors.text)
    } else {
        ChoicesReason(choices, question.recommendedChoice, state.pickedChoice(place), reasonStyle, actions)
    }
    Column(
        verticalArrangement = Arrangement.spacedBy(3.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .background(colors.running.fill)
            .padding(horizontal = 14.dp, vertical = 12.dp),
    ) {
        Label(stringResource(R.string.questions_claude_recommends), colors.accent)
        Text(markdown(question.recommendation), style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 22.sp), color = colors.textStrong)
    }
    Explanation(question, asking = state.isAsking(place))
    state.answerAt(place)?.let { answer ->
        Text(answerLabel(answer), style = MaterialTheme.typography.labelMedium, color = colors.accent)
    }
}

@Composable
private fun RevisionNote(question: GrillQuestionView) {
    val colors = SwitchboardTheme.colors
    val note = when (question.mark) {
        GrillMark.New -> stringResource(R.string.questions_grill_added)
        GrillMark.Changed -> stringResource(if (question.setAside != null) R.string.questions_grill_changed_since else R.string.questions_grill_changed)
        null -> return
    }
    Column {
        Text(note, style = MaterialTheme.typography.bodySmall.copy(fontWeight = FontWeight.SemiBold), color = colors.needsYou.ink)
        question.setAside?.let { aside ->
            Text(
                stringResource(R.string.questions_grill_set_aside, answerLabel(aside)),
                style = MaterialTheme.typography.bodySmall,
                color = colors.textMuted,
            )
        }
    }
}

/** The reason around its inline choices: the lead, a row per choice to pick, what follows. */
@Composable
private fun ChoicesReason(choices: Choices, recommended: String?, picked: String?, style: TextStyle, actions: GrillSheetActions) {
    val colors = SwitchboardTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        if (choices.lead.isNotBlank()) Text(markdown(choices.lead), style = style, color = colors.text)
        for (choice in choices.list) {
            ChoiceRow(choice, recommended = choice.letter == recommended, picked = choice.letter == picked, onClick = { actions.pick(choice.letter) })
        }
        if (choices.after.isNotBlank()) Text(markdown(choices.after), style = style, color = colors.text)
    }
}

@Composable
private fun ChoiceRow(choice: Choice, recommended: Boolean, picked: Boolean, onClick: () -> Unit) {
    val colors = SwitchboardTheme.colors
    val shape = MaterialTheme.shapes.small
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (picked) colors.running.fill else colors.bgRaised)
            .border(
                width = if (picked) 2.dp else 1.dp,
                color = if (picked || recommended) colors.accent else colors.line,
                shape = shape,
            )
            .selectable(selected = picked, role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = 12.dp, vertical = 8.dp),
    ) {
        Box(
            contentAlignment = Alignment.Center,
            modifier = Modifier
                .size(24.dp)
                .clip(RoundedCornerShape(7.dp))
                .background(if (recommended) colors.accent else colors.line),
        ) {
            Text(
                choice.letter,
                style = MaterialTheme.typography.labelSmall.copy(letterSpacing = 0.sp),
                color = if (recommended) colors.onAccent else colors.textStrong,
            )
        }
        Text(
            markdown("(${choice.letter}) ${choice.text}"),
            style = MaterialTheme.typography.bodyMedium.copy(fontSize = 14.sp),
            color = colors.textStrong,
            modifier = Modifier.weight(1f),
        )
        if (recommended) {
            Text(
                stringResource(R.string.questions_recommended).uppercase(),
                style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.5.sp),
                color = colors.accent,
            )
        }
    }
}

/** What Claude said when asked about the question, or that it is answering. */
@Composable
private fun Explanation(question: GrillQuestionView, asking: Boolean) {
    val colors = SwitchboardTheme.colors
    val explanation = question.explanation
    if (explanation == null && !asking) return
    Column(
        verticalArrangement = Arrangement.spacedBy(3.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .background(colors.bgRaised)
            .border(1.dp, colors.line, MaterialTheme.shapes.small)
            .drawBehind { drawRect(colors.accent, size = Size(3.dp.toPx(), size.height)) }
            .padding(horizontal = 14.dp, vertical = 12.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
    ) {
        if (explanation != null) {
            Label(stringResource(R.string.questions_grill_explanation), colors.textFaint)
            Text(markdown(explanation), style = MaterialTheme.typography.bodyMedium, color = colors.text)
        } else {
            Label(stringResource(R.string.questions_grill_asked), colors.textFaint)
            Text(
                stringResource(R.string.questions_grill_answering),
                style = MaterialTheme.typography.bodyMedium.copy(fontStyle = FontStyle.Italic),
                color = colors.textMuted,
            )
        }
    }
}

@Composable
private fun AnswerButtons(state: GrillSheetState, actions: GrillSheetActions, voice: HoldToTalk?) {
    val colors = SwitchboardTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        PrimaryButton(stringResource(R.string.questions_grill_yes), actions::accept, leadingCheck = false)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SecondaryButton(stringResource(R.string.questions_grill_add_note), Modifier.weight(1f)) { actions.open(GrillFieldKind.Note) }
            SecondaryButton(stringResource(R.string.questions_grill_answer_instead), Modifier.weight(1f)) { actions.open(GrillFieldKind.Instead) }
        }
        state.field?.let { field -> Field(field, actions, voice) }
        Row(
            horizontalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterHorizontally),
            modifier = Modifier.fillMaxWidth(),
        ) {
            TextButton(onClick = { actions.open(GrillFieldKind.Ask) }) {
                Text(stringResource(R.string.questions_grill_ask), style = MaterialTheme.typography.labelMedium, color = colors.accent)
            }
            TextButton(onClick = actions::waitWhat) {
                Text(stringResource(R.string.questions_grill_wait_what), style = MaterialTheme.typography.labelMedium, color = colors.accent)
            }
        }
    }
}

@Composable
private fun ColumnScope.Field(field: GrillField, actions: GrillSheetActions, voice: HoldToTalk?) {
    val placeholder = stringResource(
        when (field.kind) {
            GrillFieldKind.Note -> R.string.questions_grill_note_hint
            GrillFieldKind.Instead -> R.string.questions_grill_instead_hint
            GrillFieldKind.Ask -> R.string.questions_grill_ask_hint
        },
    )
    OwnWordsField(
        text = field.text,
        placeholder = placeholder,
        onChange = actions::type,
        voice = voice,
        shape = MaterialTheme.shapes.small,
    )
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.align(Alignment.End)) {
        TextButton(onClick = actions::closeField) {
            Text(stringResource(R.string.ask_cancel), color = SwitchboardTheme.colors.textMuted)
        }
        SecondaryButton(
            stringResource(if (field.kind == GrillFieldKind.Ask) R.string.questions_grill_ask_go else R.string.questions_grill_next),
            Modifier,
            onClick = actions::commit,
        )
    }
}

@Composable
private fun Review(state: GrillSheetState, actions: GrillSheetActions) {
    val colors = SwitchboardTheme.colors
    Text(
        stringResource(R.string.questions_grill_review_title),
        style = MaterialTheme.typography.headlineSmall.copy(fontSize = 22.sp, fontWeight = FontWeight.ExtraBold),
        color = colors.textStrong,
    )
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        state.questions.forEachIndexed { place, question ->
            ReviewRow(question, state.answerAt(place), onChange = { actions.goTo(place) })
        }
    }
    Label(stringResource(R.string.questions_grill_preview), colors.textFaint, Modifier.padding(top = 8.dp))
    val text = state.reviewText
    Text(
        text = text.ifEmpty { stringResource(R.string.questions_grill_nothing_yet) },
        style = TextStyle(fontFamily = JetBrainsMonoFamily, fontSize = 12.5.sp, lineHeight = 18.sp),
        color = colors.actionText,
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .background(colors.action)
            .padding(horizontal = 14.dp, vertical = 12.dp),
    )
}

@Composable
private fun ReviewRow(question: GrillQuestionView, answer: GrillAnswer?, onChange: () -> Unit) {
    val colors = SwitchboardTheme.colors
    val flag = when (question.mark) {
        GrillMark.New -> stringResource(R.string.questions_grill_flag_new)
        GrillMark.Changed -> stringResource(if (question.setAside != null) R.string.questions_grill_flag_changed_aside else R.string.questions_grill_flag_changed)
        null -> null
    }
    val title = markdown("${question.number} · ${question.title}")
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .background(colors.bgRaised)
            .border(1.dp, colors.line, MaterialTheme.shapes.small)
            .padding(start = 10.dp, top = 8.dp, bottom = 8.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                buildAnnotatedString {
                    append(title)
                    if (flag != null) {
                        append("  ")
                        withStyle(SpanStyle(color = colors.needsYou.ink, fontSize = 12.sp)) { append(flag) }
                    }
                },
                style = MaterialTheme.typography.labelMedium,
                color = colors.textStrong,
            )
            Text(
                answer?.let { answerLabel(it) } ?: stringResource(R.string.questions_grill_not_answered),
                style = MaterialTheme.typography.bodySmall,
                color = colors.textMuted,
            )
        }
        TextButton(onClick = onChange) {
            Text(stringResource(R.string.questions_grill_change), style = MaterialTheme.typography.labelMedium, color = colors.accent)
        }
    }
}

@Composable
private fun GrillFooter(state: GrillSheetState, actions: GrillSheetActions) {
    val colors = SwitchboardTheme.colors
    val sending = state.phase == GrillPhase.Sending
    HorizontalDivider(color = colors.line)
    Column(
        verticalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 10.dp, bottom = 12.dp),
    ) {
        if (!state.onReview) {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                SecondaryButton(stringResource(R.string.questions_back), Modifier.weight(1f), enabled = state.place > 0, onClick = actions::back)
                SecondaryButton(stringResource(R.string.questions_skip), Modifier.weight(1f), onClick = actions::skip)
                SecondaryButton(stringResource(R.string.questions_grill_review), Modifier.weight(1f)) { actions.goTo(state.questions.size) }
            }
        } else {
            when (val bar = state.sendBar) {
                GrillSendBar.Queued -> {
                    Text(
                        stringResource(R.string.questions_grill_queued),
                        style = MaterialTheme.typography.labelMedium,
                        color = colors.ready.ink,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    SecondaryButton(stringResource(R.string.questions_grill_cancel_queue), Modifier.fillMaxWidth(), onClick = actions::cancelQueue)
                }
                is GrillSendBar.ResearchRunning -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SecondaryButton(stringResource(R.string.questions_grill_queue), Modifier.weight(1f), enabled = bar.enabled, onClick = actions::queue)
                    SendButton(
                        text = stringResource(if (sending) R.string.questions_sending else R.string.questions_grill_send_now),
                        enabled = bar.enabled,
                        onClick = actions::send,
                        modifier = Modifier.weight(1f),
                    )
                }
                is GrillSendBar.Ready -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SecondaryButton(stringResource(R.string.questions_back), Modifier.weight(1f), onClick = actions::back)
                    SendButton(
                        text = if (sending) stringResource(R.string.questions_sending) else pluralStringResource(R.plurals.questions_grill_send, bar.count, bar.count),
                        enabled = state.canSend,
                        onClick = actions::send,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
        Text(
            stringResource(R.string.questions_grill_sync),
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 11.5.sp),
            color = colors.textFaint,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun SecondaryButton(text: String, modifier: Modifier, enabled: Boolean = true, onClick: () -> Unit) {
    val colors = SwitchboardTheme.colors
    OutlinedButton(
        onClick = onClick,
        enabled = enabled,
        border = BorderStroke(1.dp, colors.borderStrong),
        colors = ButtonDefaults.outlinedButtonColors(containerColor = colors.bgRaised, contentColor = colors.textStrong),
        modifier = modifier.height(44.dp),
    ) {
        Text(text, style = MaterialTheme.typography.labelMedium.copy(fontSize = 14.sp), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun SendButton(text: String, enabled: Boolean, onClick: () -> Unit, modifier: Modifier) {
    val colors = SwitchboardTheme.colors
    Button(
        onClick = onClick,
        enabled = enabled,
        colors = ButtonDefaults.buttonColors(containerColor = colors.action, contentColor = colors.actionText),
        modifier = modifier.height(44.dp),
    ) {
        Text(text, style = MaterialTheme.typography.labelMedium.copy(fontSize = 14.sp), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun Label(text: String, color: Color, modifier: Modifier = Modifier) {
    Text(text.uppercase(), style = MaterialTheme.typography.labelSmall.copy(fontSize = 11.sp), color = color, modifier = modifier)
}

@Composable
private fun answerLabel(answer: GrillAnswer): String = when (answer) {
    is GrillAnswer.Accepted -> stringResource(R.string.questions_grill_answer_accepted)
    is GrillAnswer.Noted -> stringResource(R.string.questions_grill_answer_noted, answer.note)
    is GrillAnswer.Overridden -> stringResource(R.string.questions_grill_answer_own, answer.text)
}

/** [text]'s inline Markdown (`code`, **bold**) styled, and its web links tappable, in the house style. */
@Composable
private fun markdown(text: String): AnnotatedString {
    val colors = SwitchboardTheme.colors
    return remember(text, colors) {
        inlineMarkdown(
            text,
            code = SpanStyle(fontFamily = JetBrainsMonoFamily, background = colors.line),
            links = TextLinkStyles(style = SpanStyle(color = colors.accent, textDecoration = TextDecoration.Underline)),
        )
    }
}

/** `code` spans and **bold** spans, the marks taken out; web links in what is left made tappable. */
internal fun inlineMarkdown(text: String, code: SpanStyle, links: TextLinkStyles?): AnnotatedString {
    val marked = buildAnnotatedString {
        var at = 0
        for (match in inlineMark.findAll(text)) {
            append(text.substring(at, match.range.first))
            val codeText = match.groups[1]?.value
            if (codeText != null) {
                withStyle(code) { append(codeText) }
            } else {
                withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(match.groups[2]?.value.orEmpty()) }
            }
            at = match.range.last + 1
        }
        append(text.substring(at))
    }
    return AnnotatedString.Builder(marked).apply {
        for (range in webLinksIn(marked.text)) {
            addLink(LinkAnnotation.Url(marked.text.substring(range), links), range.first, range.last + 1)
        }
    }.toAnnotatedString()
}

private val inlineMark = Regex("""`([^`]+)`|\*\*([^*]+)\*\*""")

private val previewActions = object : GrillSheetActions {
    override fun accept() = Unit
    override fun pick(letter: String) = Unit
    override fun open(field: GrillFieldKind) = Unit
    override fun type(text: String) = Unit
    override fun commit() = Unit
    override fun closeField() = Unit
    override fun waitWhat() = Unit
    override fun skip() = Unit
    override fun back() = Unit
    override fun goTo(place: Int) = Unit
    override fun dismissBanner() = Unit
    override fun send() = Unit
    override fun queue() = Unit
    override fun cancelQueue() = Unit
    override fun errorSeen() = Unit
    override fun close() = Unit
}

private fun previewQuestion(number: Int, title: String, answer: GrillAnswer?, mark: GrillMark? = null) = GrillQuestionView(
    number = number,
    title = title,
    reason = "Today archive only hides the row. A separate table would simplify the sidebar query but split the history in two.",
    recommendation = "Keep them in `sessions` with an `archived_at` column, filtered in the query.",
    answer = answer,
    setAside = null,
    mark = mark,
    asked = false,
    explanation = null,
)

private val previewView = GrillView(
    sessionId = "s-1",
    roundId = "b-1",
    revision = 1,
    preamble = "The agents are back.",
    questions = listOf(
        previewQuestion(1, "Where archived sessions live", GrillAnswer.Accepted),
        GrillQuestionView(
            number = 2,
            title = "How long to keep an archived session",
            reason = "Transcripts are Claude's, so only our row and the worktree cost space.",
            recommendation = "(b) 30 days, then drop the row: predictable, and the transcript stays in Claude anyway.",
            choices = Choices(
                lead = "Transcripts are Claude's, so only our row and the worktree cost space.",
                list = listOf(Choice("a", "Forever"), Choice("b", "30 days, then drop the row"), Choice("c", "Until its worktree is removed")),
                after = "",
            ),
            recommendedChoice = "b",
            answer = null,
            setAside = GrillAnswer.Overridden("(c) Until its worktree is removed"),
            mark = GrillMark.Changed,
            asked = true,
            explanation = "Worktrees are often removed by hand, so (c) would keep most rows forever.",
        ),
        previewQuestion(3, "The undo window", GrillAnswer.Noted("unless it's bulk")),
        previewQuestion(7, "Removing the worktree on archive", null, GrillMark.New),
    ),
    dropped = 1,
    agentsRunning = 2,
    send = GrillSendState.Idle,
    asking = null,
)

@Composable
private fun GrillPreviewOf(state: GrillSheetState) {
    SwitchboardTheme {
        Surface(color = SwitchboardTheme.colors.bgPanel, shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)) {
            GrillSheetContent(state, sessionName = "Grill: archive retention", actions = previewActions, voice = null)
        }
    }
}

@Preview(name = "Grill question dark", uiMode = Configuration.UI_MODE_NIGHT_YES, heightDp = 900)
@Preview(name = "Grill question light", uiMode = Configuration.UI_MODE_NIGHT_NO, heightDp = 900)
@Composable
internal fun GrillQuestionPreview() {
    GrillPreviewOf(GrillSheetState(view = previewView, place = 1, seen = setOf(1)))
}

@Preview(name = "Grill review dark", uiMode = Configuration.UI_MODE_NIGHT_YES, heightDp = 900)
@Preview(name = "Grill review light", uiMode = Configuration.UI_MODE_NIGHT_NO, heightDp = 900)
@Composable
internal fun GrillReviewPreview() {
    GrillPreviewOf(GrillSheetState(view = previewView.copy(send = GrillSendState.Unsent), place = previewView.questions.size))
}
