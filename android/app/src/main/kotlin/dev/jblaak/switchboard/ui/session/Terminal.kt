package dev.jblaak.switchboard.ui.session

/** A terminal's size in character cells, as xterm's fit addon works it out for the WebView. */
data class TerminalSize(val cols: Int, val rows: Int)

/** The key bar's keys and the bytes each sends to the PTY. */
enum class TerminalKey(val bytes: String) {
    Escape("\u001b"),
    Tab("\t"),
    ShiftTab("\u001b[Z"),
    Up("\u001b[A"),
    Down("\u001b[B"),
    CtrlC("\u0003"),
    Enter("\r"),
}

/** What the terminal view is told to do, in order. */
sealed interface TerminalWrite {
    /** Clear the screen and scrollback: a replay follows. */
    data object Reset : TerminalWrite

    data class Output(val text: String) : TerminalWrite
}

/**
 * The bytes a prompt is pasted as: a bracketed paste, as the Mac's own prompter writes it, so a multi-line
 * prompt arrives as one block instead of every newline pressing Enter. Escapes and other control characters
 * would end the paste early, so only text, tabs and newlines go inside.
 */
fun pasteOf(prompt: String): String {
    val text = prompt
        .replace(Regex("\r\n?"), "\n")
        .replace(Regex("[\\x00-\\x08\\x0b-\\x1f\\x7f]"), "")
    return "\u001b[200~$text\u001b[201~"
}
