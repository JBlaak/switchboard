package dev.jblaak.switchboard.ui.connected

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.theme.StatusColors
import dev.jblaak.switchboard.theme.SwitchboardTheme

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

/** Patch, as the small rounded tile that speaks in the Ask Patch flow. */
@Composable
fun PatchAvatar(size: Dp, tone: StatusColors) {
    val label = stringResource(R.string.ask_patch_name)
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(size)
            .clip(RoundedCornerShape(size * 0.36f))
            .background(tone.fill)
            .border(1.dp, tone.ink.copy(alpha = 0.35f), RoundedCornerShape(size * 0.36f))
            .semantics { contentDescription = label },
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall.copy(fontSize = (size.value / 5).sp, letterSpacing = 0.sp),
            color = tone.ink,
        )
    }
}

/** What Patch says, in a bubble beside its avatar. */
@Composable
fun PatchSays(text: String, avatarSize: Dp, tone: StatusColors, modifier: Modifier = Modifier) {
    Row(
        verticalAlignment = Alignment.Bottom,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        modifier = modifier,
    ) {
        PatchAvatar(avatarSize, tone)
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
