package dev.jblaak.switchboard.ui.sessions

import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.ui.geometry.Offset

/** What a session row does besides opening (#381): its swipes, and the sheet a long-press opens. */
enum class RowAction { Archive, Pin, Unpin }

/**
 * What a swipe that reached [value] does to a row: towards the start (left, in a left-to-right layout) archives, as
 * on the Mac; towards the end pins it, or unpins it when [pinned]. Null while it is settled.
 */
fun swipeActionOf(value: SwipeToDismissBoxValue, pinned: Boolean): RowAction? {
    return when (value) {
        SwipeToDismissBoxValue.EndToStart -> RowAction.Archive
        SwipeToDismissBoxValue.StartToEnd -> pinActionOf(pinned)
        SwipeToDismissBoxValue.Settled -> null
    }
}

/** Pin for a row that isn't pinned, unpin for one that is. */
fun pinActionOf(pinned: Boolean): RowAction = if (pinned) RowAction.Unpin else RowAction.Pin

/** The longest name the Mac takes. */
const val MAX_SESSION_NAME = 500

/** The name to send for what was typed in Rename: trimmed; null when empty, unchanged from [current], or too long. */
fun renamedOrNull(typed: String, current: String): String? {
    val name = typed.trim()
    return name.takeIf { it.isNotEmpty() && it != current && it.length <= MAX_SESSION_NAME }
}

/**
 * What a row's swipes and long-press sheet do, for a Mac that takes them ([dev.jblaak.switchboard.protocol.MacFeatures.ROW_ACTIONS]).
 * [archive] gets where the row's confetti starts, in window px, and answers false when nothing could be sent, so the
 * row comes back.
 */
class RowActions(
    val archive: (row: SessionRow, from: Offset) -> Boolean,
    val pin: (row: SessionRow, pinned: Boolean) -> Unit,
    val rename: (row: SessionRow, name: String) -> Unit,
)
