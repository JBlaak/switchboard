package dev.jblaak.switchboard.ui.questions

import androidx.compose.animation.core.Animatable
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/** How far a sideways swipe goes before it moves to another question; a shorter one springs back. */
private val SwipeDistance = 72.dp

/** The content follows the finger this much, so it shows the swipe without sliding off the sheet. */
private const val FOLLOW = 0.4f

/** Which way a sideways swipe on the question sheet goes: the twin of the Back and Next (or Skip) buttons. */
enum class QuestionSwipe { Previous, Next }

/** A sideways drag of [dx]: past [threshold] to the right is the previous question, to the left the next one. */
fun questionSwipeOf(dx: Float, threshold: Float): QuestionSwipe? = when {
    dx >= threshold -> QuestionSwipe.Previous
    dx <= -threshold -> QuestionSwipe.Next
    else -> null
}

/**
 * Sideways swipes between questions, while [enabled]. The content follows the finger a little and springs back,
 * so a swipe that stops short never moves. Only sideways drags are taken: the options still scroll, and the
 * sheet still drags down to close.
 */
@Composable
fun Modifier.swipeBetweenQuestions(enabled: Boolean, onSwipe: (QuestionSwipe) -> Unit): Modifier {
    val offset = remember { Animatable(0f) }
    val scope = rememberCoroutineScope()
    val currentOnSwipe by rememberUpdatedState(onSwipe)
    return this
        .pointerInput(enabled) {
            if (!enabled) return@pointerInput
            val threshold = SwipeDistance.toPx()
            var dragged = 0f
            detectHorizontalDragGestures(
                onDragStart = { dragged = 0f },
                onDragEnd = {
                    questionSwipeOf(dragged, threshold)?.let { currentOnSwipe(it) }
                    scope.launch { offset.animateTo(0f) }
                },
                onDragCancel = { scope.launch { offset.animateTo(0f) } },
            ) { change, dragAmount ->
                change.consume()
                dragged += dragAmount
                scope.launch { offset.snapTo(dragged * FOLLOW) }
            }
        }
        .graphicsLayer { translationX = offset.value }
}
