package dev.jblaak.switchboard.ui.ask

import android.content.res.Configuration
import androidx.compose.animation.AnimatedContent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.protocol.AskCandidate
import dev.jblaak.switchboard.protocol.PhoneProject
import dev.jblaak.switchboard.theme.SwitchboardTheme
import dev.jblaak.switchboard.ui.connected.BackIcon
import dev.jblaak.switchboard.ui.connected.CloseIcon
import dev.jblaak.switchboard.ui.connected.MicIcon
import dev.jblaak.switchboard.ui.connected.PatchSays
import dev.jblaak.switchboard.ui.connected.ScreenTopBar
import dev.jblaak.switchboard.ui.connected.SearchIcon
import dev.jblaak.switchboard.ui.connected.SendIcon
import nl.jblaak.patch.PatchMood

/** What the Ask Patch screens can be asked to do. */
interface AskActions {
    fun type(text: String)
    fun ask()
    fun dictate()
    fun pickProjectMyself()
    fun anotherProject()
    fun filter(text: String)
    fun start(projectPath: String)
    fun back()
}

@Composable
fun AskScreen(step: AskStep, actions: AskActions) {
    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        AnimatedContent(
            targetState = step,
            contentKey = { it::class },
            label = "ask step",
            modifier = Modifier.safeDrawingPadding(),
        ) { current ->
            when (current) {
                is AskStep.Compose -> ComposeStep(current, actions)
                is AskStep.Pick -> PickStep(current, actions)
                is AskStep.Projects -> ProjectsStep(current, actions)
            }
        }
    }
}

@Composable
private fun AskTopBar(title: String, closes: Boolean, onBack: () -> Unit) {
    ScreenTopBar(
        title = title,
        navigationIcon = if (closes) CloseIcon else BackIcon,
        navigationLabel = stringResource(if (closes) R.string.ask_close else R.string.ask_back),
        onNavigate = onBack,
        background = MaterialTheme.colorScheme.background,
        subtitle = null,
        trailing = {},
    )
}

@Composable
private fun ComposeStep(step: AskStep.Compose, actions: AskActions) {
    val colors = SwitchboardTheme.colors
    Column(Modifier.fillMaxSize()) {
        AskTopBar(stringResource(R.string.ask_title), closes = !step.thinking, onBack = actions::back)
        Column(
            verticalArrangement = Arrangement.spacedBy(22.dp),
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, top = 28.dp),
        ) {
            PatchSays(stringResource(R.string.ask_question), avatarSize = 56.dp, mood = PatchMood.Calm)
            AskBox(step, actions)
            step.problem?.let { ProblemText(it) }
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(
                    stringResource(R.string.ask_starts_on_mac).uppercase(),
                    style = MaterialTheme.typography.labelSmall,
                    color = colors.textMuted,
                    modifier = Modifier.padding(horizontal = 4.dp),
                )
                Column(
                    verticalArrangement = Arrangement.spacedBy(6.dp),
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(MaterialTheme.shapes.medium)
                        .background(colors.bgPanel)
                        .padding(horizontal = 16.dp, vertical = 14.dp),
                ) {
                    Text(stringResource(R.string.ask_starts_local), style = MaterialTheme.typography.bodyMedium, color = colors.textDim)
                    Text(stringResource(R.string.ask_starts_here), style = MaterialTheme.typography.bodyMedium, color = colors.textDim)
                }
            }
        }
        Box(Modifier.fillMaxWidth().padding(bottom = 16.dp), contentAlignment = Alignment.Center) {
            val canPick = step.text.isNotBlank() && !step.thinking
            TextButton(onClick = actions::pickProjectMyself, enabled = canPick) {
                Text(
                    stringResource(R.string.ask_pick_myself),
                    style = MaterialTheme.typography.titleSmall,
                    color = if (canPick) colors.accent else colors.textFaint,
                )
            }
        }
    }
}

@Composable
private fun AskBox(step: AskStep.Compose, actions: AskActions) {
    val colors = SwitchboardTheme.colors
    val shape = MaterialTheme.shapes.large
    Column(
        verticalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(colors.bgPanel)
            .border(1.5.dp, colors.accent, shape)
            .padding(18.dp),
    ) {
        BasicTextField(
            value = step.text,
            onValueChange = actions::type,
            enabled = !step.thinking,
            textStyle = MaterialTheme.typography.bodyLarge.copy(fontSize = 17.sp, lineHeight = 25.sp, color = colors.textStrong),
            cursorBrush = SolidColor(colors.accent),
            minLines = 5,
            modifier = Modifier.fillMaxWidth(),
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(
                text = stringResource(if (step.thinking) R.string.ask_thinking else R.string.ask_box_hint),
                style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp),
                color = colors.textFaint,
                modifier = Modifier.weight(1f),
            )
            if (step.thinking) {
                CircularProgressIndicator(color = colors.accent, strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
                TextButton(onClick = actions::back) {
                    Text(stringResource(R.string.ask_cancel), style = MaterialTheme.typography.labelLarge, color = colors.accent)
                }
            } else {
                FilledIconButton(
                    onClick = actions::dictate,
                    colors = IconButtonDefaults.filledIconButtonColors(containerColor = colors.line, contentColor = colors.textStrong),
                    modifier = Modifier.size(44.dp),
                ) {
                    Icon(MicIcon, contentDescription = stringResource(R.string.ask_dictate), modifier = Modifier.size(20.dp))
                }
                FilledIconButton(
                    onClick = actions::ask,
                    enabled = step.text.isNotBlank(),
                    colors = IconButtonDefaults.filledIconButtonColors(
                        containerColor = colors.accent,
                        contentColor = colors.onAccent,
                        disabledContainerColor = colors.line,
                        disabledContentColor = colors.textFaint,
                    ),
                    modifier = Modifier.size(44.dp),
                ) {
                    Icon(SendIcon, contentDescription = stringResource(R.string.ask_send), modifier = Modifier.size(20.dp))
                }
            }
        }
    }
}

@Composable
private fun ProblemText(problem: AskProblem) {
    Text(
        text = when (problem) {
            AskProblem.NotConnected -> stringResource(R.string.ask_not_connected)
            is AskProblem.Mac -> problem.error
        },
        style = MaterialTheme.typography.bodyMedium,
        color = SwitchboardTheme.colors.danger,
    )
}

@Composable
private fun PickStep(step: AskStep.Pick, actions: AskActions) {
    val colors = SwitchboardTheme.colors
    var promptShown by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxSize()) {
        AskTopBar(stringResource(R.string.ask_title), closes = false, onBack = actions::back)
        Column(
            verticalArrangement = Arrangement.spacedBy(18.dp),
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(start = 20.dp, end = 20.dp, top = 20.dp),
        ) {
            YourRequest(step.text)
            PatchSays(stringResource(R.string.ask_unsure), avatarSize = 44.dp, mood = PatchMood.Calm)
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                step.candidates.forEachIndexed { index, candidate ->
                    CandidateRow(candidate, best = index == 0, starting = step.starting, onStart = { actions.start(candidate.path) })
                }
            }
            step.problem?.let { ProblemText(it) }
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .clip(MaterialTheme.shapes.medium)
                    .background(colors.bgPanel)
                    .clickable { promptShown = !promptShown }
                    .padding(horizontal = 16.dp, vertical = 14.dp),
            ) {
                Text(stringResource(R.string.ask_first_prompt), style = MaterialTheme.typography.titleSmall.copy(fontSize = 14.sp), color = colors.textDim)
                if (promptShown) {
                    Text(
                        step.prompt,
                        style = MaterialTheme.typography.bodyMedium,
                        color = colors.textMuted,
                        modifier = Modifier.padding(top = 10.dp),
                    )
                }
            }
        }
        Box(Modifier.fillMaxWidth().padding(bottom = 16.dp), contentAlignment = Alignment.Center) {
            TextButton(onClick = actions::anotherProject, enabled = step.starting == null) {
                Text(stringResource(R.string.ask_another_project), style = MaterialTheme.typography.titleSmall, color = colors.accent)
            }
        }
    }
}

@Composable
private fun YourRequest(text: String) {
    val colors = SwitchboardTheme.colors
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 21.sp),
            color = colors.textStrong,
            modifier = Modifier
                .widthIn(max = 280.dp)
                .clip(RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomEnd = 6.dp, bottomStart = 18.dp))
                .background(colors.running.fill)
                .padding(horizontal = 16.dp, vertical = 12.dp),
        )
    }
}

@Composable
private fun CandidateRow(candidate: AskCandidate, best: Boolean, starting: String?, onStart: () -> Unit) {
    val colors = SwitchboardTheme.colors
    val shape = MaterialTheme.shapes.medium
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(if (best) colors.bgRaised else colors.bgPanel)
            .border(if (best) 1.5.dp else 0.dp, if (best) colors.accent else colors.bgPanel, shape)
            .clickable(enabled = starting == null, onClick = onStart)
            .padding(16.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(candidate.folder, style = MaterialTheme.typography.titleMedium.copy(fontWeight = androidx.compose.ui.text.font.FontWeight.ExtraBold), color = colors.textStrong)
            candidate.recentTitle?.let {
                Text(
                    stringResource(R.string.ask_recent, it),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (starting == candidate.path) {
            CircularProgressIndicator(color = colors.accent, strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
        } else {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .height(36.dp)
                    .clip(RoundedCornerShape(18.dp))
                    .background(if (best) colors.accent else colors.bgPanel)
                    .border(if (best) 0.dp else 1.dp, if (best) colors.accent else colors.borderStrong, RoundedCornerShape(18.dp))
                    .padding(horizontal = 16.dp),
            ) {
                Text(
                    stringResource(R.string.ask_start),
                    style = MaterialTheme.typography.labelLarge.copy(fontSize = 14.sp),
                    color = if (best) colors.onAccent else colors.textStrong,
                )
            }
        }
    }
}

@Composable
private fun ProjectsStep(step: AskStep.Projects, actions: AskActions) {
    val colors = SwitchboardTheme.colors
    val failed = step.reason is ProjectsReason.NoMatch || step.reason is ProjectsReason.Failed
    Column(Modifier.fillMaxSize()) {
        AskTopBar(stringResource(R.string.ask_pick_title), closes = false, onBack = actions::back)
        PatchSays(
            text = when (val reason = step.reason) {
                ProjectsReason.OwnPick -> stringResource(R.string.ask_projects_own)
                ProjectsReason.Another -> stringResource(R.string.ask_projects_another)
                is ProjectsReason.NoMatch -> reason.reason
                is ProjectsReason.Failed -> stringResource(R.string.ask_projects_failed, reason.reason)
            },
            avatarSize = 44.dp,
            mood = if (failed) PatchMood.Worried else PatchMood.Calm,
            modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 18.dp),
        )
        FilterField(step.filter, actions::filter)
        step.problem?.let { Box(Modifier.padding(horizontal = 20.dp, vertical = 8.dp)) { ProblemText(it) } }
        Box(Modifier.weight(1f)) {
            if (step.projects == null) {
                CircularProgressIndicator(color = colors.accent, modifier = Modifier.align(Alignment.Center))
            } else {
                LazyColumn(Modifier.fillMaxSize().padding(horizontal = 8.dp)) {
                    items(step.shown, key = { it.path }) { project ->
                        ProjectRow(project, step.starting, onStart = { actions.start(project.path) }, modifier = Modifier.animateItem())
                    }
                }
            }
        }
        Text(
            text = stringResource(if (step.reason == ProjectsReason.Another) R.string.ask_projects_patch_prompt else R.string.ask_projects_word_for_word),
            style = MaterialTheme.typography.bodySmall,
            color = colors.textFaint,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 24.dp, vertical = 12.dp),
        )
    }
}

@Composable
private fun FilterField(filter: String, onFilter: (String) -> Unit) {
    val colors = SwitchboardTheme.colors
    BasicTextField(
        value = filter,
        onValueChange = onFilter,
        singleLine = true,
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = colors.textStrong),
        cursorBrush = SolidColor(colors.accent),
        decorationBox = { field ->
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                modifier = Modifier
                    .fillMaxWidth()
                    .height(48.dp)
                    .clip(RoundedCornerShape(24.dp))
                    .background(colors.bgRaised)
                    .padding(horizontal = 16.dp),
            ) {
                Icon(SearchIcon, contentDescription = null, tint = colors.textFaint, modifier = Modifier.size(18.dp))
                Box(Modifier.weight(1f)) {
                    if (filter.isEmpty()) Text(stringResource(R.string.ask_filter), style = MaterialTheme.typography.bodyLarge, color = colors.textFaint)
                    field()
                }
            }
        },
        modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp),
    )
}

@Composable
private fun ProjectRow(project: PhoneProject, starting: String?, onStart: () -> Unit, modifier: Modifier) {
    val colors = SwitchboardTheme.colors
    val parent = parentLabelOf(project.path)
    val running = if (project.running > 0) pluralStringResource(R.plurals.ask_running, project.running, project.running) else null
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 60.dp)
            .clip(MaterialTheme.shapes.small)
            .clickable(enabled = starting == null, onClick = onStart)
            .padding(horizontal = 16.dp, vertical = 8.dp),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(project.folder, style = MaterialTheme.typography.titleMedium, color = colors.textStrong)
            Text(
                listOfNotNull(parent.ifEmpty { null }, running).joinToString(" · "),
                style = MaterialTheme.typography.bodySmall,
                color = colors.textMuted,
            )
        }
        if (starting == project.path) {
            CircularProgressIndicator(color = colors.accent, strokeWidth = 2.dp, modifier = Modifier.size(24.dp))
        }
    }
}

private val previewActions = object : AskActions {
    override fun type(text: String) = Unit
    override fun ask() = Unit
    override fun dictate() = Unit
    override fun pickProjectMyself() = Unit
    override fun anotherProject() = Unit
    override fun filter(text: String) = Unit
    override fun start(projectPath: String) = Unit
    override fun back() = Unit
}

private const val PREVIEW_TEXT = "The key bar in the phone session view should wrap onto two rows on narrow screens"

@Composable
private fun AskPreviewOf(step: AskStep) {
    SwitchboardTheme { AskScreen(step, previewActions) }
}

@Preview(name = "Ask dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Ask light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun AskComposePreview() {
    AskPreviewOf(AskStep.Compose(PREVIEW_TEXT, thinking = false, problem = null))
}

@Preview(name = "Thinking dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Thinking light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun AskThinkingPreview() {
    AskPreviewOf(AskStep.Compose(PREVIEW_TEXT, thinking = true, problem = null))
}

@Preview(name = "Pick dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Pick light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun AskPickPreview() {
    AskPreviewOf(
        AskStep.Pick(
            text = PREVIEW_TEXT,
            candidates = listOf(
                AskCandidate("/Users/joris/Development/JBlaak/switchboard", "switchboard", "Phone access pairing flow"),
                AskCandidate("/Users/joris/Development/JBlaak/patch", "patch", "Halloween costume for Patch"),
                AskCandidate("/Users/joris/Development/JBlaak/blaaktasks", "blaaktasks", null),
            ),
            prompt = "In the Android app's session screen, make the key bar wrap onto a second row when the keys don't fit.",
            starting = null,
            problem = null,
        ),
    )
}

@Preview(name = "Projects dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Projects light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun AskProjectsPreview() {
    AskPreviewOf(
        AskStep.Projects(
            text = PREVIEW_TEXT,
            prompt = PREVIEW_TEXT,
            reason = ProjectsReason.NoMatch("That doesn't sound like any of your projects. Which one is it?"),
            projects = listOf(
                PhoneProject("/Users/joris/Development/JBlaak/switchboard", "switchboard", 3),
                PhoneProject("/Users/joris/Development/MoveLab/kmm-sessionmanager", "kmm-sessionmanager", 1),
                PhoneProject("/Users/joris/Development/JBlaak/blaaktasks", "blaaktasks", 0),
            ),
            filter = "",
            starting = null,
            problem = null,
            from = null,
        ),
    )
}
