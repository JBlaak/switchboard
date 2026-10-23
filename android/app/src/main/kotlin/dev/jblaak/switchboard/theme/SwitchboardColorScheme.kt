package dev.jblaak.switchboard.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color

internal fun SwitchboardColors.toColorScheme(): ColorScheme {
    val scheme = if (isDark) darkColorScheme() else lightColorScheme()
    return scheme.copy(
        primary = accent,
        onPrimary = onAccent,
        primaryContainer = running.fill,
        onPrimaryContainer = running.ink,
        inversePrimary = accentDim,
        secondary = ready.ink,
        onSecondary = bgBase,
        secondaryContainer = ready.fill,
        onSecondaryContainer = ready.ink,
        tertiary = needsYou.ink,
        onTertiary = bgBase,
        tertiaryContainer = needsYou.fill,
        onTertiaryContainer = needsYou.ink,
        background = bgBase,
        onBackground = text,
        surface = bgBase,
        onSurface = text,
        surfaceVariant = bgPanel,
        onSurfaceVariant = textMuted,
        surfaceTint = Color.Transparent,
        inverseSurface = action,
        inverseOnSurface = actionText,
        error = danger,
        onError = bgBase,
        errorContainer = needsYou.fill,
        onErrorContainer = needsYou.ink,
        outline = borderStrong,
        outlineVariant = line,
        scrim = Color.Black,
        surfaceBright = bgRaised,
        surfaceDim = bgBase,
        surfaceContainerLowest = bgBase,
        surfaceContainerLow = bgPanel,
        surfaceContainer = bgPanel,
        surfaceContainerHigh = bgRaised,
        surfaceContainerHighest = bgRaised,
    )
}
