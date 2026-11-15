package dev.jblaak.switchboard.ui.session

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.protocol.LandAction
import dev.jblaak.switchboard.protocol.LandOffer
import dev.jblaak.switchboard.protocol.PhoneLand
import dev.jblaak.switchboard.theme.SwitchboardTheme
import dev.jblaak.switchboard.ui.sessions.Dot

/**
 * Land it under the session's top bar, as the Mac's session header offers it (#436): the session's pull request,
 * then Land it on your own open PR, Land it faded on a draft (a tap says why), or once landed its stage, whose menu
 * has Unland. Only there when the Mac sent a [PhoneLand] for the session.
 */
@Composable
fun LandBar(
    land: PhoneLand,
    landing: LandAction?,
    onLand: () -> Unit,
    onUnland: () -> Unit,
    /** A tap on the faded Land it of a draft, with why it doesn't land. */
    onDraftTapped: (hint: String) -> Unit,
) {
    val colors = SwitchboardTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier
            .fillMaxWidth()
            .background(colors.bgPanel)
            .padding(start = 16.dp, end = 12.dp, bottom = 8.dp),
    ) {
        Text(
            text = stringResource(R.string.session_land_pr, land.number, repositoryName(land.repository)),
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp),
            color = colors.textMuted,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        when (land.offer) {
            LandOffer.Land -> LandItButton(enabled = landing == null, busy = landing == LandAction.Land, onClick = onLand)
            LandOffer.Draft -> LandItButton(enabled = false, busy = false, onClick = { onDraftTapped(land.label) })
            LandOffer.Landed -> LandedPill(land.label, unlanding = landing == LandAction.Unland, onUnland = onUnland)
        }
    }
}

/** "Land it" in the accent, faded while it can't be pressed; a faded one still takes the tap, to say why. */
@Composable
private fun LandItButton(enabled: Boolean, busy: Boolean, onClick: () -> Unit) {
    val colors = SwitchboardTheme.colors
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .height(30.dp)
            .clip(RoundedCornerShape(15.dp))
            .background(if (enabled) colors.accent else colors.line)
            .clickable(enabled = !busy, onClick = onClick)
            .padding(horizontal = 14.dp),
    ) {
        Text(
            text = stringResource(if (busy) R.string.session_landing else R.string.session_land_it),
            style = MaterialTheme.typography.labelMedium.copy(fontSize = 13.sp),
            color = if (enabled) colors.onAccent else colors.textFaint,
        )
    }
}

/** "● Landed · 2nd in switchboard ▾": a tap opens its menu, with Unland. */
@Composable
private fun LandedPill(label: String, unlanding: Boolean, onUnland: () -> Unit) {
    val colors = SwitchboardTheme.colors
    var open by remember { mutableStateOf(false) }
    Box {
        Row(
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            modifier = Modifier
                .height(30.dp)
                .clip(RoundedCornerShape(15.dp))
                .border(1.dp, colors.line, RoundedCornerShape(15.dp))
                .clickable(enabled = !unlanding) { open = true }
                .padding(horizontal = 12.dp),
        ) {
            Dot(colors.merged, size = 7)
            Text(
                text = if (unlanding) stringResource(R.string.session_unlanding) else "$label ▾",
                style = MaterialTheme.typography.labelMedium.copy(fontSize = 13.sp),
                color = colors.text,
                maxLines = 1,
            )
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.session_unland)) },
                onClick = {
                    open = false
                    onUnland()
                },
            )
        }
    }
}

/** `switchboard` for `jblaak/switchboard`. */
internal fun repositoryName(repository: String): String = repository.substringAfter('/')

@Preview(name = "Land it dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Land it light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun LandBarPreview() {
    SwitchboardTheme {
        LandBar(PhoneLand("jblaak/switchboard", 432, LandOffer.Land, "Land it"), null, {}, {}, {})
    }
}

@Preview(name = "Landed dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Composable
internal fun LandBarLandedPreview() {
    SwitchboardTheme {
        LandBar(PhoneLand("jblaak/switchboard", 432, LandOffer.Landed, "Landed · 2nd in switchboard"), null, {}, {}, {})
    }
}
