package dev.jblaak.switchboard.components

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.theme.StatusColors
import dev.jblaak.switchboard.theme.SwitchboardTheme

/**
 * The layout every "it can't go on" screen shares: a round badge, a title and a line of explanation in the middle,
 * optional [details] under them, and the [actions] at the bottom.
 */
@Composable
fun MessageScreen(
    badge: @Composable () -> Unit,
    title: String,
    description: String,
    details: (@Composable ColumnScope.() -> Unit)?,
    actions: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .background(SwitchboardTheme.colors.bgBase)
            .safeDrawingPadding()
            .padding(start = 28.dp, end = 28.dp, bottom = 32.dp),
    ) {
        Column(
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(28.dp, Alignment.CenterVertically),
        ) {
            Box(modifier = Modifier.align(Alignment.CenterHorizontally)) { badge() }
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(
                    text = title,
                    modifier = Modifier.fillMaxWidth(),
                    style = MaterialTheme.typography.headlineMedium,
                    color = SwitchboardTheme.colors.textStrong,
                    textAlign = TextAlign.Center,
                )
                Text(
                    text = description,
                    modifier = Modifier.fillMaxWidth(),
                    style = MaterialTheme.typography.bodyLarge,
                    color = SwitchboardTheme.colors.textMuted,
                    textAlign = TextAlign.Center,
                )
            }
            details?.invoke(this)
        }
        Column(verticalArrangement = Arrangement.spacedBy(10.dp), content = actions)
    }
}

/** A 112 dp disc in a status [colors] fill with its [icon] drawn in the status ink. */
@Composable
fun StatusBadge(@DrawableRes icon: Int, colors: StatusColors) {
    IconBadge(icon = icon, fill = colors.fill, ink = colors.ink)
}

@Composable
fun IconBadge(@DrawableRes icon: Int, fill: Color, ink: Color) {
    Box(
        modifier = Modifier
            .size(112.dp)
            .background(fill, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        Icon(painter = painterResource(icon), contentDescription = null, modifier = Modifier.size(52.dp), tint = ink)
    }
}

/** The panel-coloured card that holds a screen's checks or versions. */
@Composable
fun DetailsCard(content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .background(SwitchboardTheme.colors.bgPanel, MaterialTheme.shapes.medium)
            .padding(horizontal = 20.dp, vertical = 18.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp),
        content = content,
    )
}

@Preview(name = "Dark", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Light", uiMode = android.content.res.Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun MessageScreenPreview() {
    SwitchboardTheme {
        MessageScreen(
            badge = { StatusBadge(icon = R.drawable.ic_alert, colors = SwitchboardTheme.colors.needsYou) },
            title = "Something stopped",
            description = "A line about what happened and what to do next.",
            details = null,
            actions = { PrimaryButton(text = "Try again", onClick = {}) },
        )
    }
}
