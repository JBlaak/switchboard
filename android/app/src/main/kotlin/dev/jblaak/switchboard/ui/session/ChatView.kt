package dev.jblaak.switchboard.ui.session

import android.content.res.Configuration
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.jblaak.switchboard.R
import dev.jblaak.switchboard.components.rememberLinkified
import dev.jblaak.switchboard.protocol.ChatMessage
import dev.jblaak.switchboard.protocol.ChatRole
import dev.jblaak.switchboard.theme.SwitchboardTheme
import dev.jblaak.switchboard.theme.TerminalTextStyle

/**
 * A session as the messages of its transcript, newest at the bottom: the user's prompts on the right, Claude's
 * replies across, and each tool call as one quiet line. While the newest message is in view, a new one scrolls in;
 * scrolled up, the list stays where it is. [listState] is the caller's, so the chat keeps its place while the
 * terminal is shown.
 */
@Composable
fun ChatView(state: ChatState, listState: LazyListState, modifier: Modifier = Modifier) {
    val colors = SwitchboardTheme.colors
    Box(modifier.background(MaterialTheme.colorScheme.background)) {
        when (state) {
            ChatState.Loading -> CircularProgressIndicator(color = colors.accent, modifier = Modifier.align(Alignment.Center))
            ChatState.MacTooOld -> ChatNote(stringResource(R.string.session_chat_mac_too_old))
            ChatState.Unavailable -> ChatNote(stringResource(R.string.session_chat_unavailable))
            is ChatState.Shown -> if (state.messages.isEmpty()) {
                ChatNote(stringResource(R.string.session_chat_empty))
            } else {
                ChatList(state.messages, listState)
            }
        }
    }
}

@Composable
private fun ChatList(messages: List<ChatMessage>, listState: LazyListState) {
    val newest = messages.last().id
    LaunchedEffect(newest) {
        // Reversed, so item 0 is the newest: follow it only while it (or the one before) is in view.
        if (listState.firstVisibleItemIndex <= 1) listState.animateScrollToItem(0)
    }
    LazyColumn(
        state = listState,
        reverseLayout = true,
        contentPadding = PaddingValues(horizontal = 14.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp),
        modifier = Modifier.fillMaxSize(),
    ) {
        items(messages.asReversed(), key = { it.id }) { message ->
            when (message.role) {
                ChatRole.User -> UserMessage(message.text)
                ChatRole.Assistant -> AssistantMessage(message.text)
                ChatRole.Tool -> ToolLine(message.text)
            }
        }
    }
}

@Composable
private fun UserMessage(text: String) {
    val colors = SwitchboardTheme.colors
    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.CenterEnd) {
        SelectionContainer {
            Text(
                text = rememberLinkified(text),
                style = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp, lineHeight = 21.sp),
                color = colors.textStrong,
                modifier = Modifier
                    .widthIn(max = 320.dp)
                    .clip(RoundedCornerShape(18.dp, 18.dp, 4.dp, 18.dp))
                    .background(colors.bgRaised)
                    .padding(horizontal = 14.dp, vertical = 10.dp),
            )
        }
    }
}

@Composable
private fun AssistantMessage(text: String) {
    SelectionContainer {
        Text(
            text = rememberLinkified(text),
            style = MaterialTheme.typography.bodyLarge.copy(fontSize = 15.sp, lineHeight = 22.sp),
            color = SwitchboardTheme.colors.textStrong,
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 2.dp),
        )
    }
}

@Composable
private fun ToolLine(text: String) {
    Text(
        text = text,
        style = TerminalTextStyle.copy(fontSize = 12.sp),
        color = SwitchboardTheme.colors.textMuted,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 2.dp),
    )
}

@Composable
private fun ChatNote(text: String) {
    Box(Modifier.fillMaxSize().padding(horizontal = 36.dp), contentAlignment = Alignment.Center) {
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp, lineHeight = 22.sp),
            color = SwitchboardTheme.colors.textMuted,
            textAlign = TextAlign.Center,
        )
    }
}

/** A short conversation, for the previews. */
@Composable
internal fun ChatViewPreviewContent(modifier: Modifier) {
    ChatView(
        state = ChatState.Shown(
            listOf(
                ChatMessage("u1:0", ChatRole.User, "Write the release notes for v2.8.2, and keep them short."),
                ChatMessage("a1:0", ChatRole.Tool, "Ran: git log --oneline v2.8.1..HEAD"),
                ChatMessage("a2:0", ChatRole.Tool, "Read: …/docs/CHANGELOG.md"),
                ChatMessage("a3:0", ChatRole.Assistant, "Three changes since v2.8.1:\n• Snooze keeps its row in place\n• Faster startup"),
            ),
        ),
        listState = rememberLazyListState(),
        modifier = modifier,
    )
}

@Preview(name = "Chat dark", uiMode = Configuration.UI_MODE_NIGHT_YES)
@Preview(name = "Chat light", uiMode = Configuration.UI_MODE_NIGHT_NO)
@Composable
internal fun ChatViewPreview() {
    SwitchboardTheme {
        ChatViewPreviewContent(Modifier.fillMaxSize())
    }
}
