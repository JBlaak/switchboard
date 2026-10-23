package dev.jblaak.switchboard.ui.sessions

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.theme.StatusColors
import dev.jblaak.switchboard.theme.SwitchboardTheme
import dev.jblaak.switchboard.ui.connected.AddIcon
import dev.jblaak.switchboard.ui.connected.LaptopIcon
import dev.jblaak.switchboard.ui.connected.MoreIcon
import dev.jblaak.switchboard.ui.connected.PatchFigure
import dev.jblaak.switchboard.ui.connected.PhoneIcon
import kotlin.time.Duration.Companion.minutes
import kotlinx.coroutines.delay
import nl.jblaak.patch.PatchMood
import nl.jblaak.patch.PatchMove
import nl.jblaak.patch.PatchScene
import nl.jblaak.patch.PatchTime
import nl.jblaak.patch.rememberPatchState

/** How the link stands, for the line under the title. */
enum class LinkStatus { Connected, Reconnecting, Offline }

@Composable
fun SessionsScreen(
    list: SessionList,
    macName: String,
    linkStatus: LinkStatus,
    onSessionClick: (row: SessionRow) -> Unit,
    onAskPatchClick: () -> Unit,
    onMenuClick: () -> Unit,
) {
    val now = rememberMinuteClock()
    Surface(modifier = Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
        Box(Modifier.safeDrawingPadding()) {
            LazyColumn(
                contentPadding = PaddingValues(bottom = 104.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                item(key = "header") { SessionsHeader(macName, linkStatus, onMenuClick) }
                item(key = "counts") { StatusCounts(list) }
                if (list.isEmpty) {
                    item(key = "empty") { EmptySessions() }
                }
                section(SessionStatus.NeedsYou, list.needsYou, now, onSessionClick)
                section(SessionStatus.Working, list.working, now, onSessionClick)
                section(SessionStatus.Ready, list.ready, now, onSessionClick)
            }
            ExtendedFloatingActionButton(
                onClick = onAskPatchClick,
                icon = { Icon(AddIcon, contentDescription = null, modifier = Modifier.size(20.dp)) },
                text = { Text(stringResource(R.string.sessions_ask_patch), style = MaterialTheme.typography.labelLarge) },
                shape = RoundedCornerShape(18.dp),
                containerColor = SwitchboardTheme.colors.accent,
                contentColor = SwitchboardTheme.colors.onAccent,
                modifier = Modifier
                    .align(Alignment.BottomEnd)
                    .padding(end = 16.dp, bottom = 16.dp),
            )
        }
    }
}

@Composable
private fun rememberMinuteClock(): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1.minutes)
            now = System.currentTimeMillis()
        }
    }
    return now
}

@Composable
private fun SessionsHeader(macName: String, linkStatus: LinkStatus, onMenuClick: () -> Unit) {
    val colors = SwitchboardTheme.colors
    val mood = if (linkStatus == LinkStatus.Connected) PatchMood.Calm else PatchMood.Worried
    val scene = PatchScene(PatchMove.Wave, mood, line = "", PatchTime.Day, sky = null)
    val patch = rememberPatchState(scene)
    LaunchedEffect(mood) {
        if (patch.scene != scene) patch.appear(scene)
    }
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.padding(start = 14.dp, end = 8.dp, top = 8.dp, bottom = 12.dp),
    ) {
        PatchFigure(state = patch, size = 60.dp, modifier = Modifier)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(
                text = stringResource(R.string.sessions_title),
                style = MaterialTheme.typography.headlineMedium,
                color = colors.textStrong,
            )
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Dot(
                    color = when (linkStatus) {
                        LinkStatus.Connected -> colors.running.dot
                        LinkStatus.Reconnecting -> colors.pinned.dot
                        LinkStatus.Offline -> colors.textFaint
                    },
                    size = 8,
                )
                Text(
                    text = stringResource(
                        when (linkStatus) {
                            LinkStatus.Connected -> R.string.sessions_link_connected
                            LinkStatus.Reconnecting -> R.string.sessions_link_reconnecting
                            LinkStatus.Offline -> R.string.sessions_link_offline
                        },
                        macName,
                    ),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textMuted,
                )
            }
        }
        IconButton(onClick = onMenuClick, modifier = Modifier.size(48.dp)) {
            Icon(
                MoreIcon,
                contentDescription = stringResource(R.string.sessions_menu),
                tint = colors.textDim,
                modifier = Modifier.size(22.dp),
            )
        }
    }
}

@Composable
private fun StatusCounts(list: SessionList) {
    val colors = SwitchboardTheme.colors
    Row(
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 4.dp, bottom = 16.dp),
    ) {
        if (list.needsYou.isNotEmpty()) {
            CountChip(pluralStringResource(R.plurals.sessions_count_needs_you, list.needsYou.size, list.needsYou.size), colors.needsYou)
        }
        if (list.working.isNotEmpty()) {
            CountChip(pluralStringResource(R.plurals.sessions_count_working, list.working.size, list.working.size), colors.running)
        }
        if (list.ready.isNotEmpty()) {
            CountChip(pluralStringResource(R.plurals.sessions_count_ready, list.ready.size, list.ready.size), colors.ready)
        }
    }
}

@Composable
private fun CountChip(text: String, status: StatusColors) {
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .height(32.dp)
            .clip(RoundedCornerShape(16.dp))
            .background(status.fill)
            .padding(horizontal = 14.dp),
    ) {
        Text(text, style = MaterialTheme.typography.labelMedium, color = status.ink)
    }
}

@Composable
private fun EmptySessions() {
    Text(
        text = stringResource(R.string.sessions_empty),
        style = MaterialTheme.typography.bodyMedium,
        color = SwitchboardTheme.colors.textMuted,
        modifier = Modifier.padding(horizontal = 20.dp, vertical = 24.dp),
    )
}

private fun LazyListScope.section(
    status: SessionStatus,
    rows: List<SessionRow>,
    now: Long,
    onSessionClick: (SessionRow) -> Unit,
) {
    if (rows.isEmpty()) return
    item(key = "section-$status") {
        SectionTitle(status, Modifier.animateItem())
    }
    items(rows, key = { it.id }) { row ->
        val modifier = Modifier
            .animateItem()
            .padding(horizontal = 12.dp, vertical = 4.dp)
        if (row.status == SessionStatus.NeedsYou) {
            NeedsYouRow(row, now, onClick = { onSessionClick(row) }, modifier = modifier)
        } else {
            CompactRow(row, onClick = { onSessionClick(row) }, modifier = modifier)
        }
    }
    item(key = "gap-$status") { Spacer(Modifier.height(16.dp)) }
}

@Composable
private fun SectionTitle(status: SessionStatus, modifier: Modifier) {
    Text(
        text = stringResource(
            when (status) {
                SessionStatus.NeedsYou -> R.string.sessions_section_needs_you
                SessionStatus.Working -> R.string.sessions_section_working
                SessionStatus.Ready -> R.string.sessions_section_ready
            },
        ).uppercase(),
        style = MaterialTheme.typography.labelSmall,
        color = statusColorsOf(status).ink,
        modifier = modifier.padding(start = 20.dp, end = 20.dp, bottom = 4.dp),
    )
}

@Composable
private fun NeedsYouRow(row: SessionRow, now: Long, onClick: () -> Unit, modifier: Modifier) {
    val colors = SwitchboardTheme.colors
    Row(
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        modifier = modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .background(colors.bgRaised)
            .clickable(onClick = onClick)
            .padding(16.dp),
    ) {
        Dot(colors.needsYou.dot, size = 10, modifier = Modifier.padding(top = 7.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            RowTitle(row, MaterialTheme.typography.titleMedium)
            Text(
                text = "${row.project} · ${waitingText(row.waiting)}",
                style = MaterialTheme.typography.bodySmall,
                color = colors.textMuted,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.padding(top = 8.dp),
            ) {
                if (row.waiting is Waiting.Questions) {
                    Box(
                        contentAlignment = Alignment.Center,
                        modifier = Modifier
                            .height(26.dp)
                            .clip(RoundedCornerShape(13.dp))
                            .background(colors.needsYou.fill)
                            .padding(horizontal = 10.dp),
                    ) {
                        Text(
                            stringResource(R.string.sessions_answer),
                            style = MaterialTheme.typography.labelMedium.copy(fontSize = 12.sp),
                            color = colors.needsYou.ink,
                        )
                    }
                }
                PlaceLabel(row.place)
            }
        }
        Text(
            text = elapsedLabelOrNull(row.changedAt, now) ?: stringResource(R.string.sessions_elapsed_now),
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp),
            color = colors.textFaint,
        )
    }
}

@Composable
private fun CompactRow(row: SessionRow, onClick: () -> Unit, modifier: Modifier) {
    val colors = SwitchboardTheme.colors
    val status = statusColorsOf(row.status)
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        modifier = modifier
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .background(colors.bgPanel)
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
    ) {
        if (row.status == SessionStatus.Working) {
            Box(contentAlignment = Alignment.Center, modifier = Modifier.size(18.dp)) {
                Dot(status.dot.copy(alpha = 0.18f), size = 18)
                Dot(status.dot, size = 10)
            }
        } else {
            Box(contentAlignment = Alignment.Center, modifier = Modifier.size(18.dp)) { Dot(status.dot, size = 10) }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            RowTitle(row, MaterialTheme.typography.titleSmall)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(
                    text = "${row.remote ?: row.project} ·",
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.textMuted,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                PlaceLabel(row.place)
            }
        }
    }
}

@Composable
private fun RowTitle(row: SessionRow, style: androidx.compose.ui.text.TextStyle) {
    val colors = SwitchboardTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(
            text = row.name,
            style = style,
            color = colors.textStrong,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        if (row.remote != null) {
            Box(
                contentAlignment = Alignment.Center,
                modifier = Modifier
                    .height(20.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(colors.remote.fill)
                    .padding(horizontal = 7.dp),
            ) {
                Text(
                    stringResource(R.string.sessions_ssh),
                    style = MaterialTheme.typography.labelSmall.copy(fontSize = 10.sp, letterSpacing = 0.5.sp),
                    color = colors.remote.ink,
                )
            }
        }
    }
}

@Composable
private fun PlaceLabel(place: TerminalPlace) {
    val colors = SwitchboardTheme.colors
    val here = place == TerminalPlace.ThisPhone
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(5.dp)) {
        Icon(
            imageVector = placeIconOf(place),
            contentDescription = null,
            tint = if (here) colors.accent else colors.textFaint,
            modifier = Modifier.size(13.dp),
        )
        Text(
            text = placeText(place),
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp),
            color = if (here) colors.accent else colors.textFaint,
            maxLines = 1,
        )
    }
}

fun placeIconOf(place: TerminalPlace): ImageVector = if (place == TerminalPlace.Mac) LaptopIcon else PhoneIcon

@Composable
fun placeText(place: TerminalPlace): String {
    return when (place) {
        TerminalPlace.Mac -> stringResource(R.string.sessions_place_mac)
        TerminalPlace.ThisPhone -> stringResource(R.string.sessions_place_this_phone)
        is TerminalPlace.OtherPhone -> stringResource(R.string.sessions_place_other_phone, place.name)
    }
}

@Composable
private fun waitingText(waiting: Waiting?): String {
    return when (waiting) {
        is Waiting.Questions -> pluralStringResource(R.plurals.sessions_questions_waiting, waiting.count, waiting.count)
        Waiting.Terminal -> stringResource(R.string.sessions_waiting_terminal)
        null -> stringResource(R.string.sessions_section_needs_you)
    }
}

@Composable
fun statusColorsOf(status: SessionStatus): StatusColors {
    val colors = SwitchboardTheme.colors
    return when (status) {
        SessionStatus.NeedsYou -> colors.needsYou
        SessionStatus.Working -> colors.running
        SessionStatus.Ready -> colors.ready
    }
}

@Composable
fun Dot(color: Color, size: Int, modifier: Modifier = Modifier) {
    Box(
        modifier
            .size(size.dp)
            .clip(CircleShape)
            .background(color),
    )
}

@Preview(name = "Dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun SessionsScreenPreview() {
    val now = System.currentTimeMillis()
    SwitchboardTheme {
        SessionsScreen(
            list = SessionList(
                needsYou = listOf(
                    previewRow("1", "Phone access pairing flow", "switchboard", SessionStatus.NeedsYou, Waiting.Questions(3), TerminalPlace.Mac, now - 2.minutes.inWholeMilliseconds),
                    previewRow("2", "Citius reconnect after sleep", "kmm-sessionmanager", SessionStatus.NeedsYou, Waiting.Terminal, TerminalPlace.Mac, now - 9.minutes.inWholeMilliseconds),
                ),
                working = listOf(
                    previewRow("3", "Release notes for v2.8.2", "switchboard", SessionStatus.Working, null, TerminalPlace.ThisPhone, now),
                    previewRow("4", "Runner disk cleanup", "ci-runner-bootstrap", SessionStatus.Working, null, TerminalPlace.Mac, now).copy(remote = "ci-mini"),
                ),
                ready = listOf(
                    previewRow("5", "Grill follow-ups from #192", "switchboard", SessionStatus.Ready, null, TerminalPlace.OtherPhone("Pixel 8"), now),
                ),
            ),
            macName = "joris-mbp.local",
            linkStatus = LinkStatus.Connected,
            onSessionClick = {},
            onAskPatchClick = {},
            onMenuClick = {},
        )
    }
}

@Preview(name = "Empty dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Empty light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun SessionsScreenEmptyPreview() {
    SwitchboardTheme {
        SessionsScreen(
            list = SessionList(emptyList(), emptyList(), emptyList()),
            macName = "joris-mbp.local",
            linkStatus = LinkStatus.Reconnecting,
            onSessionClick = {},
            onAskPatchClick = {},
            onMenuClick = {},
        )
    }
}

private fun previewRow(
    id: String,
    name: String,
    project: String,
    status: SessionStatus,
    waiting: Waiting?,
    place: TerminalPlace,
    changedAt: Long,
): SessionRow {
    return SessionRow(id, name, project, remote = null, status, waiting, place, changedAt)
}
