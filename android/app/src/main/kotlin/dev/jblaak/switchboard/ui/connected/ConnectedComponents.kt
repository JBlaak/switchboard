package dev.jblaak.switchboard.ui.connected

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.TransformOrigin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jblaak.switchboard.theme.SwitchboardTheme
import nl.jblaak.patch.Patch
import nl.jblaak.patch.PatchAvatar
import nl.jblaak.patch.PatchColors
import nl.jblaak.patch.PatchMood
import nl.jblaak.patch.PatchState
import nl.jblaak.patch.PatchStyle

/** A screen's top bar: back (or close), a title with an optional line under it, and anything at the end. */
@Composable
fun ScreenTopBar(
    title: String,
    navigationIcon: ImageVector,
    navigationLabel: String,
    onNavigate: () -> Unit,
    background: Color,
    subtitle: (@Composable () -> Unit)?,
    trailing: @Composable RowScope.() -> Unit,
) {
    val colors = SwitchboardTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        modifier = Modifier
            .background(background)
            .padding(start = 4.dp, end = 4.dp, top = 8.dp, bottom = 8.dp),
    ) {
        IconButton(onClick = onNavigate, modifier = Modifier.size(48.dp)) {
            Icon(navigationIcon, contentDescription = navigationLabel, tint = colors.textDim, modifier = Modifier.size(22.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium.copy(fontSize = 17.sp),
                color = colors.textStrong,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            subtitle?.invoke()
        }
        trailing()
    }
}

/** What Patch says, in a bubble beside Patch itself, wearing [mood]'s face. */
@Composable
fun PatchSays(text: String, avatarSize: Dp, mood: PatchMood, modifier: Modifier = Modifier) {
    Row(
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        modifier = modifier,
    ) {
        PatchAvatar(
            mood = mood,
            modifier = Modifier.size(avatarSize),
            colors = PatchColors.of(PatchStyle.Patch, dark = SwitchboardTheme.colors.isDark),
        )
        Text(
            text = text,
            style = MaterialTheme.typography.titleMedium,
            color = SwitchboardTheme.colors.textStrong,
            modifier = Modifier
                .widthIn(max = 300.dp)
                .clip(RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp, bottomEnd = 18.dp, bottomStart = 6.dp))
                .background(SwitchboardTheme.colors.bgRaised)
                .padding(horizontal = 16.dp, vertical = 12.dp),
        )
    }
}

/** The width and height of Patch's art in the library (Art.kt), which Patch is drawn in. */
private const val ART_WIDTH = 220f
private const val ART_HEIGHT = 200f

/** How much of the art's top is cut off: the bubble's tail reaches this far into it, Patch's body at rest does not. */
private const val ART_TOP = 24f

/**
 * Patch at [size] wide, without its own speech bubble, as James stands in the James app's header. Patch always draws
 * its bubble above the art, so this lays Patch out at full size, scales it down around the art's bottom centre and
 * clips away what sits above the art, and the [ART_TOP] the bubble's tail still reaches.
 */
@Composable
fun PatchFigure(state: PatchState, size: Dp, modifier: Modifier) {
    val scale = size.value / ART_WIDTH
    Patch(
        state = state,
        onPoke = null,
        onGrab = null,
        onDrop = null,
        colors = PatchColors.of(PatchStyle.Patch, dark = SwitchboardTheme.colors.isDark),
        modifier = modifier
            .clipToBounds()
            .layout { measurable, _ ->
                val placeable = measurable.measure(Constraints())
                val width = (ART_WIDTH * scale).dp.roundToPx()
                val height = ((ART_HEIGHT - ART_TOP) * scale).dp.roundToPx()
                layout(width, height) {
                    placeable.placeWithLayer((width - placeable.width) / 2, height - placeable.height) {
                        scaleX = scale
                        scaleY = scale
                        transformOrigin = TransformOrigin(0.5f, 1f)
                    }
                }
            },
    )
}

/** The tallest a box being typed in grows before it scrolls inside: 40% of the window, so what is around it stays in sight. */
@Composable
fun typingBoxMaxHeight(): Dp {
    val window = LocalWindowInfo.current.containerSize
    return with(LocalDensity.current) { (window.height * 0.4f).toDp() }
}
