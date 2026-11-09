package dev.jblaak.switchboard.ui.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxState
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.theme.SwitchboardTheme
import dev.jblaak.switchboard.ui.connected.ArchiveIcon
import dev.jblaak.switchboard.ui.connected.PinIcon
import dev.jblaak.switchboard.ui.connected.RenameIcon
import kotlinx.coroutines.launch

/** How far a row has to be swiped, as a share of its width, before letting go archives or pins it. */
private const val SWIPE_THRESHOLD = 0.35f

/**
 * A session row that swipes (#381): towards the start archives it, towards the end pins or unpins it, with the action
 * shown behind the row as it moves. Short of [SWIPE_THRESHOLD] it springs back, and so does a pinned row, which
 * stays listed. An archived row stays swiped away until the list drops it, unless nothing could be sent.
 *
 * [content] gets where the row's middle is in the window, for the confetti a long-press's Archive throws.
 */
@Composable
internal fun SwipeableRow(
    row: SessionRow,
    actions: RowActions,
    modifier: Modifier,
    content: @Composable (middle: () -> Offset) -> Unit,
) {
    // Plain remember, not rememberSaveable: a row brought back by an archive the Mac couldn't do must not come
    // back swiped away, which would archive it again.
    val state = remember { SwipeToDismissBoxState(SwipeToDismissBoxValue.Settled) { width -> width * SWIPE_THRESHOLD } }
    val scope = rememberCoroutineScope()
    var middle by remember { mutableStateOf(Offset.Zero) }
    val latestRow by rememberUpdatedState(row)
    val latestActions by rememberUpdatedState(actions)
    // Remembered once: the box reruns its dismiss effect whenever this callback changes, which would act twice.
    val onDismiss: (SwipeToDismissBoxValue) -> Unit = remember(state, scope) {
        { value ->
            val current = latestRow
            when (swipeActionOf(value, current.pinned)) {
                RowAction.Archive -> if (!latestActions.archive(current, middle)) scope.launch { state.reset() }
                RowAction.Pin -> {
                    latestActions.pin(current, true)
                    scope.launch { state.reset() }
                }
                RowAction.Unpin -> {
                    latestActions.pin(current, false)
                    scope.launch { state.reset() }
                }
                null -> Unit
            }
        }
    }
    SwipeToDismissBox(
        state = state,
        backgroundContent = { SwipeBackground(swipeActionOf(state.dismissDirection, row.pinned)) },
        modifier = modifier.onGloballyPositioned { middle = it.boundsInWindow().center },
        onDismiss = onDismiss,
    ) {
        content { middle }
    }
}

/** What is under a row while it is swiped: the action letting go would take, on the side it is uncovered from. */
@Composable
private fun RowScope.SwipeBackground(action: RowAction?) {
    val colors = SwitchboardTheme.colors
    val (fill, ink) = when (action) {
        RowAction.Archive -> colors.accent to colors.onAccent
        RowAction.Pin, RowAction.Unpin -> colors.pinned.fill to colors.pinned.ink
        null -> Color.Transparent to Color.Transparent
    }
    Box(
        contentAlignment = if (action == RowAction.Archive) Alignment.CenterEnd else Alignment.CenterStart,
        modifier = Modifier
            .fillMaxSize()
            .clip(MaterialTheme.shapes.medium)
            .background(fill)
            .padding(horizontal = 24.dp),
    ) {
        if (action != null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Icon(
                    imageVector = if (action == RowAction.Archive) ArchiveIcon else PinIcon,
                    contentDescription = null,
                    tint = ink,
                    modifier = Modifier.size(20.dp),
                )
                Text(rowActionLabel(action), style = MaterialTheme.typography.labelLarge, color = ink)
            }
        }
    }
}

@Composable
private fun rowActionLabel(action: RowAction): String {
    return stringResource(
        when (action) {
            RowAction.Archive -> R.string.session_archive
            RowAction.Pin -> R.string.sessions_pin
            RowAction.Unpin -> R.string.sessions_unpin
        },
    )
}

/** A long-pressed row's actions: archive, pin or unpin, rename. Each closes the sheet. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun RowActionsSheet(
    row: SessionRow,
    onArchive: () -> Unit,
    onPin: () -> Unit,
    onRename: () -> Unit,
    onDismiss: () -> Unit,
) {
    val colors = SwitchboardTheme.colors
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = colors.bgPanel,
    ) {
        Text(
            text = row.name,
            style = MaterialTheme.typography.titleMedium,
            color = colors.textStrong,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.padding(start = 24.dp, end = 24.dp, bottom = 8.dp),
        )
        SheetAction(ArchiveIcon, rowActionLabel(RowAction.Archive), onArchive)
        SheetAction(PinIcon, rowActionLabel(pinActionOf(row.pinned)), onPin)
        SheetAction(RenameIcon, stringResource(R.string.sessions_rename), onRename)
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun SheetAction(icon: ImageVector, label: String, onClick: () -> Unit) {
    val colors = SwitchboardTheme.colors
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 24.dp, vertical = 14.dp),
    ) {
        Icon(icon, contentDescription = null, tint = colors.textDim, modifier = Modifier.size(22.dp))
        Text(label, style = MaterialTheme.typography.bodyLarge, color = colors.text)
    }
}

/** Rename's text box, holding the name the row shows, selected. Save is off until the name is a new one. */
@Composable
internal fun RenameDialog(current: String, onRename: (name: String) -> Unit, onDismiss: () -> Unit) {
    var typed by remember { mutableStateOf(TextFieldValue(current, selection = TextRange(0, current.length))) }
    val name = renamedOrNull(typed.text, current)
    val focus = remember { FocusRequester() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.sessions_rename_title)) },
        text = {
            OutlinedTextField(
                value = typed,
                onValueChange = { if (it.text.length <= MAX_SESSION_NAME) typed = it },
                singleLine = true,
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.Sentences,
                    imeAction = ImeAction.Done,
                ),
                keyboardActions = KeyboardActions(onDone = { name?.let(onRename) }),
                modifier = Modifier
                    .fillMaxWidth()
                    .focusRequester(focus),
            )
            LaunchedEffect(Unit) {
                // The dialog's window may not have the field attached yet; then the keyboard waits for a tap.
                runCatching { focus.requestFocus() }
            }
        },
        confirmButton = {
            TextButton(onClick = { name?.let(onRename) }, enabled = name != null) {
                Text(stringResource(R.string.sessions_rename_save))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.cancel)) }
        },
    )
}
