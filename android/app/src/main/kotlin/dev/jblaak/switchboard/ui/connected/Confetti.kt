package dev.jblaak.switchboard.ui.connected

import android.provider.Settings
import androidx.compose.foundation.Canvas
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInWindow
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.drawText
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.sin
import kotlin.random.Random

/*
 * A burst of confetti when a session is archived, as the Mac throws one (`lib/motion/celebrate.ts`): pieces with a
 * launch velocity, gravity, air drag, a little flutter and spin. Every fifth burst is a bigger one, with stars.
 * Skipped when the system's animations are off.
 */

private val COLORS = listOf(0xFF8FD8BF, 0xFF1C6E56, 0xFF9CC5E8, 0xFFC8B8E8, 0xFFEEAB94, 0xFFF5C86B).map { Color(it) }
private val SHAPES = listOf("", "", "", "★", "✦")

/** In dp/s²; the Mac's 1500 px/s². */
private const val GRAVITY = 1500f

/** Pieces in the [burst]th burst (counted from 1): every fifth one is a bigger one. */
fun confettiPieces(burst: Int): Int = if (burst % 5 == 0) 70 else 28

/** Where the bursts come from: [ConfettiLayer] draws them. One per connected app, so the count runs across screens. */
class Confetti {
    internal val pieces = mutableStateListOf<ConfettiPiece>()
    private var bursts = 0

    /** A burst from [at], in window coordinates and px; [density] turns the Mac's px into dp. */
    fun burst(at: Offset, density: Float, random: Random = Random.Default) {
        val count = confettiPieces(++bursts)
        val big = count > 28
        repeat(count) { i ->
            // Mostly upwards, fanning out; air drag slows them and gravity takes over.
            val angle = -PI / 2 + (random.nextDouble() - 0.5) * PI * (if (big) 1.5 else 1.1)
            val speed = ((if (big) 420 else 300) + random.nextDouble() * (if (big) 520 else 320)) * density
            val shape = SHAPES[random.nextInt(SHAPES.size)]
            pieces += ConfettiPiece(
                shape = shape,
                color = COLORS[i % COLORS.size],
                width = (if (shape.isEmpty()) 5 + random.nextFloat() * 5 else 10 + random.nextFloat() * 8) * density,
                height = (8 + random.nextFloat() * 6) * density,
                round = random.nextFloat() < 0.4f,
                x = at.x,
                y = at.y,
                vx = (cos(angle) * speed).toFloat(),
                vy = (sin(angle) * speed).toFloat(),
                spin = (random.nextFloat() - 0.5f) * 900f,
                life = 1.4f + random.nextFloat() * 0.8f,
                phase = random.nextFloat() * 6f,
                drag = 2.2f + random.nextFloat() * 1.5f,
                density = density,
            )
        }
    }

    /** Moves every piece on by [dt] seconds and drops the ones whose life is over. */
    internal fun step(dt: Float) {
        pieces.forEach { it.step(dt) }
        pieces.removeAll { it.t > it.life }
    }
}

internal class ConfettiPiece(
    /** Empty for a paper piece, else the character drawn. */
    val shape: String,
    val color: Color,
    /** For a character, its font size in px. */
    val width: Float,
    val height: Float,
    val round: Boolean,
    var x: Float,
    var y: Float,
    var vx: Float,
    var vy: Float,
    val spin: Float,
    val life: Float,
    val phase: Float,
    val drag: Float,
    val density: Float,
) {
    var rotation = 0f
    var t = 0f

    val alpha: Float get() = ((life - t) / 0.35f).coerceIn(0f, 1f)

    /** The flip of a piece turning over as it falls. */
    val flip: Float get() = cos(t * 7 + phase)

    fun step(dt: Float) {
        t += dt
        vy += GRAVITY * density * dt
        val d = exp(-drag * dt)
        vx *= d
        vy *= d
        x += (vx + sin(t * 9 + phase) * 40 * density) * dt
        y += vy * dt
        rotation += spin * dt
    }
}

/** Draws [confetti] over everything under it; put it last in a full-size box. Takes no touches. */
@Composable
fun ConfettiLayer(confetti: Confetti, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val animationsOff = remember {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
    }
    if (animationsOff) {
        confetti.pieces.clear()
        return
    }
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    val origin = remember { mutableStateOf(Offset.Zero) }
    val frame = remember { mutableLongStateOf(0L) }
    val running = confetti.pieces.isNotEmpty()

    LaunchedEffect(running) {
        if (!running) return@LaunchedEffect
        var last = withFrameNanos { it }
        while (confetti.pieces.isNotEmpty()) {
            withFrameNanos { now ->
                // A dropped frame moves pieces on by at most 1/20 s, so nothing jumps across the screen.
                confetti.step(((now - last) / 1e9f).coerceAtMost(0.05f))
                frame.longValue = now
                last = now
            }
        }
    }

    Canvas(
        modifier.onGloballyPositioned { origin.value = it.positionInWindow() },
    ) {
        frame.longValue // Redrawn every frame the pieces move.
        for (piece in confetti.pieces) {
            val center = Offset(piece.x, piece.y) - origin.value
            rotate(piece.rotation, pivot = center) {
                scale(scaleX = piece.flip, scaleY = 1f, pivot = center) {
                    if (piece.shape.isEmpty()) {
                        val size = Size(piece.width, piece.height)
                        drawRoundRect(
                            color = piece.color,
                            topLeft = center - Offset(size.width / 2, size.height / 2),
                            size = size,
                            cornerRadius = CornerRadius(if (piece.round) size.minDimension / 2 else 2 * piece.density),
                            alpha = piece.alpha,
                        )
                    } else {
                        val layout = measurer.measure(
                            piece.shape,
                            TextStyle(
                                color = piece.color,
                                fontSize = with(density) { piece.width.toSp() },
                                fontWeight = FontWeight.Black,
                            ),
                        )
                        drawText(
                            layout,
                            topLeft = center - Offset(layout.size.width / 2f, layout.size.height / 2f),
                            alpha = piece.alpha,
                        )
                    }
                }
            }
        }
    }
}
