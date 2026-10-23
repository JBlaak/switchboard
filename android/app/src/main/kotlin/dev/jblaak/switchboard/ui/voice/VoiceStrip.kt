package dev.jblaak.switchboard.ui.voice

import android.content.res.Configuration
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.theme.SwitchboardTheme
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

private const val MeterBars = 14

/** [voice]'s mic is recording, transcribing or has a problem to tell: this strip shows it, in place of something else. */
@Composable
fun HoldToTalk.isBusy(): Boolean = shown() !is VoiceState.Idle

/**
 * What [voice]'s mic is doing, in words: the time and a meter while held, with how to cancel; then transcribing;
 * or a problem's note, which a tap dismisses. Empty while idle.
 */
@Composable
fun VoiceStrip(voice: HoldToTalk, modifier: Modifier = Modifier, initialLevels: List<Float> = emptyList()) {
    val shown = voice.shown()
    var levels by remember { mutableStateOf(initialLevels) }
    LaunchedEffect(shown) {
        levels = if (shown is VoiceState.Recording) withLevel(levels, shown.level, MeterBars) else emptyList()
    }
    AnimatedContent(
        targetState = shown,
        contentKey = { it::class },
        transitionSpec = { fadeIn() togetherWith fadeOut() },
        contentAlignment = Alignment.CenterStart,
        label = "voice strip",
        modifier = modifier.heightIn(min = 36.dp),
    ) { state ->
        Box(contentAlignment = Alignment.CenterStart, modifier = Modifier.heightIn(min = 36.dp)) {
            when (state) {
                VoiceState.Idle -> Unit
                is VoiceState.Recording -> Recording(state.elapsedMillis, levels, voice.cancelling)
                VoiceState.Transcribing -> Transcribing()
                is VoiceState.Problem -> Note(noteOf(state.problem), onDismiss = voice::dismiss)
            }
        }
    }
}

@Composable
private fun Recording(elapsedMillis: Long, levels: List<Float>, cancelling: Boolean) {
    val colors = SwitchboardTheme.colors
    val blink by rememberInfiniteTransition(label = "recording dot").animateFloat(
        initialValue = 1f,
        targetValue = 0.3f,
        animationSpec = infiniteRepeatable(tween(700), RepeatMode.Reverse),
        label = "recording dot alpha",
    )
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(
            Modifier
                .size(8.dp)
                .alpha(if (cancelling) 1f else blink)
                .clip(CircleShape)
                .background(colors.danger),
        )
        Text(
            elapsedOf(elapsedMillis),
            style = MaterialTheme.typography.labelLarge.copy(fontFeatureSettings = "tnum"),
            color = colors.textStrong,
        )
        LevelMeter(levels, if (cancelling) colors.textFaint else colors.accent)
        Text(
            stringResource(if (cancelling) R.string.voice_release_to_cancel else R.string.voice_slide_to_cancel),
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp),
            color = if (cancelling) colors.danger else colors.textMuted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
    }
}

/** The recent [levels], oldest on the left, as bars from the middle. */
@Composable
private fun LevelMeter(levels: List<Float>, color: Color) {
    val padded = List(MeterBars - levels.size) { 0f } + levels
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp), modifier = Modifier.height(20.dp)) {
        for (level in padded) {
            Box(
                Modifier
                    .width(3.dp)
                    .height(3.dp + 17.dp * level)
                    .clip(RoundedCornerShape(1.5.dp))
                    .background(color),
            )
        }
    }
}

@Composable
private fun Transcribing() {
    val colors = SwitchboardTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        CircularProgressIndicator(color = colors.accent, strokeWidth = 2.dp, modifier = Modifier.size(14.dp))
        Text(stringResource(R.string.voice_transcribing), style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp), color = colors.textMuted)
    }
}

@Composable
private fun Note(note: VoiceNote, onDismiss: () -> Unit) {
    val colors = SwitchboardTheme.colors
    Text(
        text = stringResource(note.text, *note.args.toTypedArray()),
        style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp),
        color = if (note.wrong) colors.danger else colors.textMuted,
        modifier = Modifier
            .clickable(onClick = onDismiss)
            .padding(vertical = 4.dp),
    )
}

/** A voice that stays in [state], for previews. */
private class PreviewVoiceControls(state: VoiceState) : VoiceControls {
    override val state: StateFlow<VoiceState> = MutableStateFlow(state)
    override fun start(sessionId: String?, onText: (String) -> Unit) = Unit
    override fun stop() = Unit
    override fun cancel() = Unit
    override fun dismissProblem() = Unit
}

/** A mic showing [state], as if it had been pressed, for the previews of the screens it is on. */
internal fun previewHoldToTalk(state: VoiceState, cancelling: Boolean = false): HoldToTalk {
    return HoldToTalk(PreviewVoiceControls(state), sessionId = { null }, onText = {}, hasPermission = { true }, haptics = null).apply {
        owns = true
        this.cancelling = cancelling
    }
}

private val previewLevels = listOf(0.1f, 0.2f, 0.5f, 0.8f, 0.6f, 0.3f, 0.4f, 0.9f, 0.7f, 0.4f, 0.2f, 0.5f, 0.6f, 0.3f)

@Composable
private fun VoicePreviewOf(voice: HoldToTalk) {
    SwitchboardTheme {
        val colors = SwitchboardTheme.colors
        Surface(color = colors.bgPanel) {
            Column(Modifier.padding(16.dp)) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    VoiceStrip(voice, Modifier.weight(1f), initialLevels = previewLevels)
                    HoldToTalkMic(voice, size = 48.dp, idleContainer = colors.line, idleContent = colors.textStrong)
                }
            }
        }
    }
}

@Preview(name = "Recording dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Recording light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun VoiceRecordingPreview() {
    VoicePreviewOf(previewHoldToTalk(VoiceState.Recording(level = 0.6f, elapsedMillis = 7_400)))
}

@Preview(name = "Cancelling dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Cancelling light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun VoiceCancellingPreview() {
    VoicePreviewOf(previewHoldToTalk(VoiceState.Recording(level = 0.3f, elapsedMillis = 12_000), cancelling = true))
}

@Preview(name = "Transcribing dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Transcribing light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun VoiceTranscribingPreview() {
    VoicePreviewOf(previewHoldToTalk(VoiceState.Transcribing))
}

@Preview(name = "Problem dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Problem light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun VoiceProblemPreview() {
    VoicePreviewOf(previewHoldToTalk(VoiceState.Problem(VoiceProblem.NoWhisper)))
}

@Preview(name = "Preparing dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Preparing light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun VoicePreparingPreview() {
    VoicePreviewOf(previewHoldToTalk(VoiceState.Problem(VoiceProblem.Preparing(0.43))))
}
