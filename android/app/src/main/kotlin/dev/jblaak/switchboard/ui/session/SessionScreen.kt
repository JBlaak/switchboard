package dev.jblaak.switchboard.ui.session

import android.content.res.Configuration
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.protocol.PendingQuestions
import dev.jblaak.switchboard.protocol.Question
import dev.jblaak.switchboard.protocol.QuestionsSource
import dev.jblaak.switchboard.theme.SwitchboardTheme
import dev.jblaak.switchboard.theme.TerminalTextStyle
import dev.jblaak.switchboard.ui.connected.ArchiveIcon
import dev.jblaak.switchboard.ui.connected.BackIcon
import dev.jblaak.switchboard.ui.connected.DownIcon
import dev.jblaak.switchboard.ui.connected.EnterIcon
import dev.jblaak.switchboard.ui.connected.LaptopTerminalIcon
import dev.jblaak.switchboard.ui.connected.PhoneIcon
import dev.jblaak.switchboard.ui.connected.ScreenTopBar
import dev.jblaak.switchboard.ui.connected.SendIcon
import dev.jblaak.switchboard.ui.connected.UpIcon
import dev.jblaak.switchboard.ui.connected.typingBoxMaxHeight
import dev.jblaak.switchboard.ui.sessions.Dot
import dev.jblaak.switchboard.ui.sessions.SessionStatus
import dev.jblaak.switchboard.ui.sessions.TerminalPlace
import dev.jblaak.switchboard.ui.sessions.placeIconOf
import dev.jblaak.switchboard.ui.sessions.statusColorsOf
import dev.jblaak.switchboard.ui.voice.HoldToTalk
import dev.jblaak.switchboard.ui.voice.HoldToTalkMic
import dev.jblaak.switchboard.ui.voice.VoiceState
import dev.jblaak.switchboard.ui.voice.VoiceStrip
import dev.jblaak.switchboard.ui.voice.isBusy
import dev.jblaak.switchboard.ui.voice.previewHoldToTalk

/**
 * A session: its terminal with the key bar and prompt box while this phone is the active device, "Active on
 * other device" with Use here otherwise. The terminal stays laid out under the placeholder, so its size is the
 * one the PTY takes when this phone becomes active.
 */
@Composable
fun SessionScreen(
    state: SessionScreenState,
    prompt: String,
    onPromptChange: (String) -> Unit,
    onSend: () -> Unit,
    onKey: (TerminalKey) -> Unit,
    /** The prompt box's mic; left out when null. */
    voice: HoldToTalk?,
    onUseHere: () -> Unit,
    onAnswer: () -> Unit,
    onStartedNoteDismissed: () -> Unit,
    /** With the middle of the Archive button, in window coordinates, for the confetti. */
    onArchive: (from: Offset) -> Unit,
    onBack: () -> Unit,
    terminal: @Composable (Modifier) -> Unit,
) {
    val colors = SwitchboardTheme.colors
    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Column(Modifier.safeDrawingPadding()) {
            SessionTopBar(state, onArchive, onBack)
            Box(Modifier.weight(1f)) {
                Column(Modifier.fillMaxSize()) {
                    Box(Modifier.weight(1f)) {
                        terminal(Modifier.fillMaxSize())
                        Column(
                            verticalArrangement = Arrangement.spacedBy(8.dp),
                            modifier = Modifier
                                .align(Alignment.BottomCenter)
                                .padding(12.dp),
                        ) {
                            AnimatedVisibility(state.access == TerminalAccess.Here && state.pendingQuestions != null, enter = fadeIn(), exit = fadeOut()) {
                                QuestionsBanner(state.pendingQuestions, onAnswer)
                            }
                            AnimatedVisibility(state.startedIn != null && state.access == TerminalAccess.Here, enter = fadeIn(), exit = fadeOut()) {
                                StartedNote(state.startedIn.orEmpty(), onStartedNoteDismissed)
                            }
                        }
                    }
                    SessionFooter(prompt, onPromptChange, onSend, onKey, voice)
                }
                Crossfade(targetState = state.access, label = "terminal access") { access ->
                    when (access) {
                        TerminalAccess.Here -> Unit
                        TerminalAccess.Unknown -> Cover { CircularProgressIndicator(color = colors.accent) }
                        TerminalAccess.Ended -> Cover { SessionEnded(onBack) }
                        is TerminalAccess.Elsewhere -> Cover {
                            ActiveElsewhere(access.place, state, onUseHere, onAnswer)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SessionTopBar(state: SessionScreenState, onArchive: (from: Offset) -> Unit, onBack: () -> Unit) {
    val colors = SwitchboardTheme.colors
    ScreenTopBar(
        title = state.name ?: stringResource(R.string.session_new),
        navigationIcon = BackIcon,
        navigationLabel = stringResource(R.string.session_back),
        onNavigate = onBack,
        background = colors.bgPanel,
        subtitle = {
            val status = state.status
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (status != null) Dot(statusColorsOf(status).dot, size = 7)
                Text(
                    text = listOfNotNull(state.project, status?.let { statusText(it) }).joinToString(" · "),
                    style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp),
                    color = colors.textMuted,
                    maxLines = 1,
                )
            }
        },
        trailing = {
            AccessChip(state.access)
            ArchiveButton(onArchive)
        },
    )
}

@Composable
private fun ArchiveButton(onArchive: (from: Offset) -> Unit) {
    var middle by remember { mutableStateOf(Offset.Zero) }
    IconButton(
        onClick = { onArchive(middle) },
        modifier = Modifier
            .size(48.dp)
            .onGloballyPositioned { middle = it.boundsInWindow().center },
    ) {
        Icon(
            ArchiveIcon,
            contentDescription = stringResource(R.string.session_archive),
            tint = SwitchboardTheme.colors.textDim,
            modifier = Modifier.size(22.dp),
        )
    }
}

@Composable
private fun statusText(status: SessionStatus): String {
    return stringResource(
        when (status) {
            SessionStatus.NeedsYou -> R.string.sessions_section_needs_you
            SessionStatus.Working -> R.string.sessions_section_working
            SessionStatus.Ready -> R.string.sessions_section_ready
        },
    )
}

@Composable
private fun AccessChip(access: TerminalAccess) {
    val colors = SwitchboardTheme.colors
    val (icon, label, here) = when (access) {
        TerminalAccess.Here -> Triple(PhoneIcon, stringResource(R.string.session_chip_here), true)
        is TerminalAccess.Elsewhere -> when (val place = access.place) {
            TerminalPlace.Mac -> Triple(placeIconOf(place), stringResource(R.string.session_chip_mac), false)
            TerminalPlace.ThisPhone -> Triple(placeIconOf(place), stringResource(R.string.session_chip_here), true)
            is TerminalPlace.OtherPhone -> Triple(placeIconOf(place), place.name, false)
        }
        TerminalAccess.Unknown, TerminalAccess.Ended -> return
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        modifier = Modifier
            .padding(end = 4.dp)
            .height(28.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(if (here) colors.running.fill else colors.line)
            .padding(horizontal = 10.dp),
    ) {
        Icon(icon, contentDescription = null, tint = if (here) colors.accent else colors.textDim, modifier = Modifier.size(14.dp))
        Text(label, style = MaterialTheme.typography.labelMedium.copy(fontSize = 12.sp), color = if (here) colors.accent else colors.textDim)
    }
}

/** Over the terminal while this phone is not the active device; takes the touches the terminal would get. */
@Composable
private fun Cover(content: @Composable () -> Unit) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, onClick = {}),
    ) {
        content()
    }
}

@Composable
private fun ActiveElsewhere(place: TerminalPlace, state: SessionScreenState, onUseHere: () -> Unit, onAnswer: () -> Unit) {
    val colors = SwitchboardTheme.colors
    Column(Modifier.fillMaxSize()) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(28.dp, Alignment.CenterVertically),
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(horizontal = 36.dp),
        ) {
            DevicePicture(place)
            Column(verticalArrangement = Arrangement.spacedBy(10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    text = stringResource(R.string.session_elsewhere_title),
                    style = MaterialTheme.typography.headlineSmall,
                    color = colors.textStrong,
                    textAlign = TextAlign.Center,
                )
                Text(
                    text = when (place) {
                        is TerminalPlace.OtherPhone -> stringResource(R.string.session_elsewhere_other_phone, place.name)
                        else -> stringResource(R.string.session_elsewhere_mac)
                    },
                    style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 22.sp),
                    color = colors.textMuted,
                    textAlign = TextAlign.Center,
                )
            }
            Button(
                onClick = onUseHere,
                colors = ButtonDefaults.buttonColors(containerColor = colors.accent, contentColor = colors.onAccent),
                modifier = Modifier.height(52.dp),
            ) {
                Icon(PhoneIcon, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.size(10.dp))
                Text(stringResource(R.string.session_use_here), style = MaterialTheme.typography.labelLarge.copy(fontSize = 16.sp))
            }
        }
        when {
            state.pendingQuestions != null -> Box(Modifier.padding(start = 12.dp, end = 12.dp, bottom = 16.dp)) {
                QuestionsBanner(state.pendingQuestions, onAnswer)
            }
            state.waitingInTerminal -> WaitingBanner(
                text = stringResource(R.string.session_waiting_terminal),
                action = null,
                onAction = {},
                modifier = Modifier.padding(start = 12.dp, end = 12.dp, bottom = 16.dp),
            )
        }
    }
}

@Composable
private fun DevicePicture(place: TerminalPlace) {
    val colors = SwitchboardTheme.colors
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(132.dp)
            .clip(CircleShape)
            .background(colors.bgPanel),
    ) {
        Icon(
            imageVector = if (place == TerminalPlace.Mac) LaptopTerminalIcon else PhoneIcon,
            contentDescription = null,
            tint = colors.textMuted,
            modifier = Modifier.size(64.dp),
        )
    }
}

@Composable
private fun QuestionsBanner(set: PendingQuestions?, onAnswer: () -> Unit) {
    val count = set?.questions?.size ?: 1
    WaitingBanner(
        text = if (set?.source == QuestionsSource.Grill) {
            pluralStringResource(R.plurals.session_grill_waiting, count, count)
        } else {
            pluralStringResource(R.plurals.sessions_questions_waiting, count, count).replaceFirstChar { it.uppercase() }
        },
        action = stringResource(R.string.sessions_answer),
        onAction = onAnswer,
        modifier = Modifier,
    )
}

@Composable
private fun WaitingBanner(text: String, action: String?, onAction: () -> Unit, modifier: Modifier) {
    val colors = SwitchboardTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        modifier = modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .background(colors.needsYou.fill)
            .padding(start = 16.dp, end = 8.dp, top = 6.dp, bottom = 6.dp)
            .heightIn(min = 40.dp),
    ) {
        Dot(colors.needsYou.dot, size = 10)
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = colors.textStrong,
            modifier = Modifier.weight(1f),
        )
        if (action != null) {
            TextButton(onClick = onAction) {
                Text(action, style = MaterialTheme.typography.labelLarge, color = colors.needsYou.ink)
            }
        }
    }
}

@Composable
private fun StartedNote(project: String, onDismiss: () -> Unit) {
    val colors = SwitchboardTheme.colors
    val full = stringResource(R.string.session_started_in, project)
    val start = full.indexOf(project)
    val text = buildAnnotatedString {
        append(full)
        if (start >= 0) addStyle(SpanStyle(fontWeight = FontWeight.Bold), start, start + project.length)
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.small)
            .background(colors.action)
            .padding(start = 16.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
    ) {
        Text(text, style = MaterialTheme.typography.bodyMedium, color = colors.actionText, modifier = Modifier.weight(1f))
        TextButton(onClick = onDismiss) {
            Text(stringResource(R.string.session_started_ok), style = MaterialTheme.typography.labelLarge, color = colors.accentDim)
        }
    }
}

@Composable
private fun SessionEnded(onBack: () -> Unit) {
    val colors = SwitchboardTheme.colors
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp),
        modifier = Modifier.padding(horizontal = 36.dp),
    ) {
        Text(stringResource(R.string.session_ended_title), style = MaterialTheme.typography.headlineSmall, color = colors.textStrong)
        Text(
            stringResource(R.string.session_ended_body),
            style = MaterialTheme.typography.bodyMedium,
            color = colors.textMuted,
            textAlign = TextAlign.Center,
        )
        TextButton(onClick = onBack) {
            Text(stringResource(R.string.session_ended_back), style = MaterialTheme.typography.labelLarge, color = colors.accent)
        }
    }
}

@Composable
private fun SessionFooter(prompt: String, onPromptChange: (String) -> Unit, onSend: () -> Unit, onKey: (TerminalKey) -> Unit, voice: HoldToTalk?) {
    val colors = SwitchboardTheme.colors
    Column(
        verticalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier
            .background(colors.bgPanel)
            .padding(start = 12.dp, end = 12.dp, top = 10.dp, bottom = 12.dp),
    ) {
        // While the mic is busy its strip stands in for the key bar, so the terminal keeps its size.
        Crossfade(targetState = voice != null && voice.isBusy(), label = "key bar or voice") { busy ->
            if (busy && voice != null) {
                VoiceStrip(voice, Modifier.fillMaxWidth().padding(horizontal = 4.dp))
            } else {
                KeyBar(onKey)
            }
        }
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            PromptBox(prompt, onPromptChange, Modifier.weight(1f))
            if (voice != null) HoldToTalkMic(voice, size = 48.dp, idleContainer = colors.line, idleContent = colors.textStrong)
            FilledIconButton(
                onClick = onSend,
                enabled = prompt.isNotBlank(),
                colors = IconButtonDefaults.filledIconButtonColors(
                    containerColor = colors.accent,
                    contentColor = colors.onAccent,
                    disabledContainerColor = colors.line,
                    disabledContentColor = colors.textFaint,
                ),
                modifier = Modifier.size(48.dp),
            ) {
                Icon(SendIcon, contentDescription = stringResource(R.string.session_send), modifier = Modifier.size(20.dp))
            }
        }
    }
}

@Composable
private fun KeyBar(onKey: (TerminalKey) -> Unit) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.fillMaxWidth()) {
        for (key in TerminalKey.entries) {
            KeyButton(key, onClick = { onKey(key) }, modifier = Modifier.weight(1f))
        }
    }
}

@Composable
private fun KeyButton(key: TerminalKey, onClick: () -> Unit, modifier: Modifier) {
    val colors = SwitchboardTheme.colors
    val danger = key == TerminalKey.CtrlC
    val icon: ImageVector? = when (key) {
        TerminalKey.Up -> UpIcon
        TerminalKey.Down -> DownIcon
        TerminalKey.Enter -> EnterIcon
        else -> null
    }
    val label = stringResource(
        when (key) {
            TerminalKey.Escape -> R.string.session_key_escape
            TerminalKey.Tab -> R.string.session_key_tab
            TerminalKey.ShiftTab -> R.string.session_key_shift_tab
            TerminalKey.Up -> R.string.session_key_up
            TerminalKey.Down -> R.string.session_key_down
            TerminalKey.CtrlC -> R.string.session_key_ctrl_c
            TerminalKey.Enter -> R.string.session_key_enter
        },
    )
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .defaultMinSize(minHeight = 36.dp)
            .clip(MaterialTheme.shapes.extraSmall)
            .background(if (danger) colors.needsYou.fill else colors.line)
            .clickable(onClick = onClick, onClickLabel = label),
    ) {
        if (icon != null) {
            Icon(icon, contentDescription = label, tint = colors.textStrong, modifier = Modifier.size(16.dp))
        } else {
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = if (danger) colors.needsYou.ink else colors.textStrong,
                maxLines = 1,
            )
        }
    }
}

@Composable
private fun PromptBox(prompt: String, onPromptChange: (String) -> Unit, modifier: Modifier) {
    val colors = SwitchboardTheme.colors
    BasicTextField(
        value = prompt,
        onValueChange = onPromptChange,
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.textStrong),
        cursorBrush = SolidColor(colors.accent),
        modifier = modifier.heightIn(max = typingBoxMaxHeight()),
        decorationBox = { field ->
            Box(
                contentAlignment = Alignment.CenterStart,
                modifier = Modifier
                    .heightIn(min = 48.dp)
                    .clip(RoundedCornerShape(24.dp))
                    .background(colors.bgRaised)
                    .border(1.dp, colors.borderStrong, RoundedCornerShape(24.dp))
                    .padding(horizontal = 18.dp, vertical = 12.dp),
            ) {
                if (prompt.isEmpty()) {
                    Text(stringResource(R.string.session_prompt_placeholder), style = MaterialTheme.typography.bodyLarge, color = colors.textFaint)
                }
                field()
            }
        },
    )
}

@Composable
private fun PreviewTerminal(modifier: Modifier) {
    Column(
        verticalArrangement = Arrangement.Bottom,
        modifier = modifier
            .background(TerminalBackground)
            .padding(horizontal = 10.dp, vertical = 12.dp),
    ) {
        Text("⏺ Three changes since v2.8.1:", style = TerminalTextStyle, color = Color(0xFFD9D7D2))
        Text("  • Snooze keeps its row in place", style = TerminalTextStyle, color = Color(0xFFD9D7D2))
        Text("✻ Writing release notes… (41s · esc to interrupt)", style = TerminalTextStyle, color = Color(0xFFEEAB94))
        Text("╭──────────────────────────────────────╮", style = TerminalTextStyle, color = Color(0xFF6E6D69))
        Text("│ >                                    │", style = TerminalTextStyle, color = Color(0xFF6E6D69))
        Text("╰──────────────────────────────────────╯", style = TerminalTextStyle, color = Color(0xFF6E6D69))
    }
}

private fun previewState(access: TerminalAccess, startedIn: String?, questions: Boolean, waitingInTerminal: Boolean): SessionScreenState {
    return SessionScreenState(
        sessionId = "s-1",
        name = "Release notes for v2.8.2",
        project = "switchboard",
        status = if (questions || waitingInTerminal) SessionStatus.NeedsYou else SessionStatus.Working,
        access = access,
        pendingQuestions = if (questions) {
            PendingQuestions(
                sessionId = "s-1",
                toolUseId = "toolu_1",
                source = QuestionsSource.Ask,
                questions = listOf(Question("How long should a code stay valid?", "Pairing", emptyList(), false, null)),
                askedAt = 0,
                deadline = null,
            )
        } else {
            null
        },
        waitingInTerminal = waitingInTerminal,
        startedIn = startedIn,
    )
}

@Composable
private fun SessionScreenPreviewOf(state: SessionScreenState, prompt: String = "", voice: HoldToTalk? = null) {
    SwitchboardTheme {
        SessionScreen(
            state = state,
            prompt = prompt,
            onPromptChange = {},
            onSend = {},
            onKey = {},
            voice = voice,
            onUseHere = {},
            onAnswer = {},
            onStartedNoteDismissed = {},
            onArchive = {},
            onBack = {},
            terminal = { PreviewTerminal(it) },
        )
    }
}

@Preview(name = "Here dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Here light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun SessionScreenHerePreview() {
    SessionScreenPreviewOf(previewState(TerminalAccess.Here, startedIn = null, questions = false, waitingInTerminal = false))
}

@Preview(name = "Recording dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Recording light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun SessionScreenRecordingPreview() {
    SessionScreenPreviewOf(
        previewState(TerminalAccess.Here, startedIn = null, questions = false, waitingInTerminal = false),
        prompt = "Write the release notes for v2.8.2, and keep them short.",
        voice = previewHoldToTalk(VoiceState.Recording(level = 0.7f, elapsedMillis = 63_000)),
    )
}

@Preview(name = "Started dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Started light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun SessionScreenStartedPreview() {
    SessionScreenPreviewOf(previewState(TerminalAccess.Here, startedIn = "switchboard", questions = false, waitingInTerminal = false))
}

@Preview(name = "Other device dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Other device light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun SessionScreenElsewherePreview() {
    SessionScreenPreviewOf(previewState(TerminalAccess.Elsewhere(TerminalPlace.Mac), startedIn = null, questions = false, waitingInTerminal = true))
}

@Preview(name = "Other device, questions dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Other device, questions light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun SessionScreenElsewhereQuestionsPreview() {
    SessionScreenPreviewOf(
        previewState(TerminalAccess.Elsewhere(TerminalPlace.OtherPhone("Pixel 8")), startedIn = null, questions = true, waitingInTerminal = false),
    )
}

@Preview(name = "Ended dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Ended light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun SessionScreenEndedPreview() {
    SessionScreenPreviewOf(previewState(TerminalAccess.Ended, startedIn = null, questions = false, waitingInTerminal = false))
}
