package dev.jblaak.switchboard.ui.session

import java.util.Base64

/** What the terminal page says, from `assets/terminal/terminal.js`. */
sealed interface TerminalEvent {
    /** The page loaded and fitted itself: a fresh, empty terminal. */
    data class Ready(val size: TerminalSize) : TerminalEvent

    data class Resized(val size: TerminalSize) : TerminalEvent

    /** Bytes for the PTY the page made itself: a scroll on the alternate screen. */
    data class Input(val data: String) : TerminalEvent
}

/** "ready 48 30", "size 48 30" or "input <base64 of UTF-8 bytes>"; null for anything else. */
fun terminalEventOrNull(message: String): TerminalEvent? {
    val parts = message.trim().split(' ')
    if (parts.size == 2 && parts[0] == "input") return inputOrNull(parts[1])
    if (parts.size != 3) return null
    val cols = parts[1].toIntOrNull()?.takeIf { it > 0 } ?: return null
    val rows = parts[2].toIntOrNull()?.takeIf { it > 0 } ?: return null
    return when (parts[0]) {
        "ready" -> TerminalEvent.Ready(TerminalSize(cols, rows))
        "size" -> TerminalEvent.Resized(TerminalSize(cols, rows))
        else -> null
    }
}

private fun inputOrNull(base64: String): TerminalEvent.Input? {
    val bytes = runCatching { Base64.getDecoder().decode(base64) }.getOrNull() ?: return null
    return bytes.takeIf { it.isNotEmpty() }?.let { TerminalEvent.Input(String(it, Charsets.UTF_8)) }
}

/**
 * One script for a frame's worth of [writes]: consecutive output joined into a single `sb.write`. The output
 * goes as base64 of its UTF-8 bytes, whose alphabet (A–Z, a–z, 0–9, +, /, =) needs no escaping inside a
 * single-quoted JavaScript string, whatever bytes the terminal sends.
 */
fun terminalScriptOf(writes: List<TerminalWrite>): String {
    val script = StringBuilder()
    val output = StringBuilder()
    fun flushOutput() {
        if (output.isEmpty()) return
        val encoded = Base64.getEncoder().encodeToString(output.toString().toByteArray(Charsets.UTF_8))
        script.append("sb.write('").append(encoded).append("');")
        output.clear()
    }
    for (write in writes) {
        when (write) {
            TerminalWrite.Reset -> {
                output.clear()
                script.clear()
                script.append("sb.reset();")
            }
            is TerminalWrite.Output -> output.append(write.text)
        }
    }
    flushOutput()
    return script.toString()
}
