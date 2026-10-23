package dev.jblaak.switchboard.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color

/**
 * Switchboard's palette, token for token from `src/renderer/styles/_tokens.scss`: graphite surfaces in the
 * dark, cool off-whites in the light, a mint accent, and status drawn as a pastel fill with its own ink.
 *
 * The text ramp stops at [textMuted]: [textFaint] and [textDimmest] are for icons, hints and placeholders,
 * which need not meet 4.5:1, never for text someone has to read.
 */
@Immutable
data class SwitchboardColors(
    val bgBase: Color,
    val bgPanel: Color,
    val bgRaised: Color,
    val line: Color,
    val borderStrong: Color,
    val action: Color,
    val actionText: Color,
    val accent: Color,
    val accentDim: Color,
    val onAccent: Color,
    val textStrong: Color,
    val text: Color,
    val textDim: Color,
    val textMuted: Color,
    val textFaint: Color,
    val textDimmest: Color,
    val danger: Color,
    val merged: Color,
    val running: StatusColors,
    val needsYou: StatusColors,
    val ready: StatusColors,
    val pinned: StatusColors,
    val remote: StatusColors,
    val isDark: Boolean,
)

/** A status as a pastel [fill], the [ink] drawn on it (and on any surface), and the [dot] that marks it in a row. */
@Immutable
data class StatusColors(
    val fill: Color,
    val ink: Color,
    val dot: Color,
)

internal val DarkColors = SwitchboardColors(
    bgBase = Color(0xFF141517),
    bgPanel = Color(0xFF1C1D20),
    bgRaised = Color(0xFF212226),
    line = Color(0xFF2E2F33),
    borderStrong = Color(0xFF3D3E43),
    action = Color(0xFFECEBE8),
    actionText = Color(0xFF141517),
    accent = Color(0xFF8FD8BF),
    accentDim = Color(0xFF5E9E88),
    onAccent = Color(0xFF141517),
    textStrong = Color(0xFFECEBE8),
    text = Color(0xFFD9D7D2),
    textDim = Color(0xFFC2C0BB),
    textMuted = Color(0xFFA09E99),
    textFaint = Color(0xFF85837F),
    textDimmest = Color(0xFF6E6D69),
    danger = Color(0xFFEE8B8B),
    merged = Color(0xFFB79CF0),
    running = StatusColors(fill = Color(0xFF1A2A25), ink = Color(0xFF6CC4A1), dot = Color(0xFF6CC4A1)),
    needsYou = StatusColors(fill = Color(0xFF2D211D), ink = Color(0xFFEEAB94), dot = Color(0xFFEEAB94)),
    ready = StatusColors(fill = Color(0xFF1B2530), ink = Color(0xFF9CC5E8), dot = Color(0xFF9CC5E8)),
    pinned = StatusColors(fill = Color(0xFF2A2518), ink = Color(0xFFF0CF7E), dot = Color(0xFFF0CF7E)),
    remote = StatusColors(fill = Color(0xFF241F2D), ink = Color(0xFFC8B8E8), dot = Color(0xFFC8B8E8)),
    isDark = true,
)

internal val LightColors = SwitchboardColors(
    bgBase = Color(0xFFFAFBFD),
    bgPanel = Color(0xFFF0F3F8),
    bgRaised = Color(0xFFFFFFFF),
    line = Color(0xFFE3E8EF),
    borderStrong = Color(0xFFCFD6DF),
    action = Color(0xFF16181D),
    actionText = Color(0xFFFFFFFF),
    accent = Color(0xFF1C6E56),
    accentDim = Color(0xFF6FB39C),
    onAccent = Color(0xFFFFFFFF),
    textStrong = Color(0xFF16181D),
    text = Color(0xFF262A31),
    textDim = Color(0xFF3D434C),
    textMuted = Color(0xFF626B78),
    textFaint = Color(0xFF7B8491),
    textDimmest = Color(0xFF98A1AD),
    danger = Color(0xFFC0392B),
    merged = Color(0xFF7444C4),
    running = StatusColors(fill = Color(0xFFE3F7EF), ink = Color(0xFF1C6E56), dot = Color(0xFF2E8A68)),
    needsYou = StatusColors(fill = Color(0xFFFDEEE8), ink = Color(0xFF9A3C22), dot = Color(0xFFD9774F)),
    ready = StatusColors(fill = Color(0xFFE6F1FB), ink = Color(0xFF255F8C), dot = Color(0xFF4F8FC4)),
    pinned = StatusColors(fill = Color(0xFFFBF3DC), ink = Color(0xFF7A5A0C), dot = Color(0xFF7A5A0C)),
    remote = StatusColors(fill = Color(0xFFEFE8FA), ink = Color(0xFF553489), dot = Color(0xFF553489)),
    isDark = false,
)
