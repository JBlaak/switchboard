package dev.jblaak.switchboard.ui.voice

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.theme.SwitchboardTheme
import dev.jblaak.switchboard.ui.connected.MicIcon

/** How far the finger slides off the mic before letting go cancels, like a voice note in a chat app. */
private val CancelDistance = 96.dp

/**
 * The mic: press and hold to record, let go to transcribe, slide away and let go to cancel. Lit up with a ring
 * that swells with the voice while recording, red once letting go would cancel, and a spinner while transcribing.
 */
@Composable
fun HoldToTalkMic(voice: HoldToTalk, size: Dp, idleContainer: Color, idleContent: Color, modifier: Modifier = Modifier) {
    val colors = SwitchboardTheme.colors
    val shown = voice.shown()
    val recording = shown is VoiceState.Recording
    val cancelling = recording && voice.cancelling
    val container by animateColorAsState(
        when {
            cancelling -> colors.danger
            recording -> colors.accent
            else -> idleContainer
        },
        label = "mic container",
    )
    val content by animateColorAsState(
        when {
            cancelling -> colors.bgBase
            recording -> colors.onAccent
            else -> idleContent
        },
        label = "mic content",
    )
    val level by animateFloatAsState((shown as? VoiceState.Recording)?.level ?: 0f, label = "mic level")
    val scale by animateFloatAsState(if (recording) 1.12f else 1f, label = "mic scale")
    val ring = colors.accent.copy(alpha = 0.25f)
    val description = stringResource(R.string.voice_hold_to_talk)
    Box(
        contentAlignment = Alignment.Center,
        modifier = modifier
            .size(size)
            .graphicsLayer {
                scaleX = scale
                scaleY = scale
            }
            .drawBehind {
                if (recording && !cancelling) drawCircle(ring, radius = this.size.minDimension / 2 * (1f + 0.6f * level))
            }
            .clip(CircleShape)
            .background(container)
            .semantics {
                contentDescription = description
                role = Role.Button
            }
            .holdToTalk(voice),
    ) {
        if (shown is VoiceState.Transcribing) {
            CircularProgressIndicator(color = colors.accent, strokeWidth = 2.dp, modifier = Modifier.size(18.dp))
        } else {
            Icon(MicIcon, contentDescription = null, tint = content, modifier = Modifier.size(20.dp))
        }
    }
}

/** The press, slide and release of [voice]'s mic; the touches are its own, so a sheet under it doesn't drag. */
private fun Modifier.holdToTalk(voice: HoldToTalk): Modifier = pointerInput(voice) {
    val threshold = CancelDistance.toPx()
    awaitEachGesture {
        val down = awaitFirstDown()
        down.consume()
        if (!voice.press()) {
            waitForUpOrCancellation()?.consume()
            return@awaitEachGesture
        }
        var released = false
        try {
            while (true) {
                val change = awaitPointerEvent().changes.firstOrNull { it.id == down.id } ?: break
                change.consume()
                if (!change.pressed) {
                    voice.release()
                    released = true
                    break
                }
                val moved = change.position - down.position
                voice.slide(moved.x, moved.y, threshold)
            }
        } finally {
            if (!released) voice.abandon()
        }
    }
}
