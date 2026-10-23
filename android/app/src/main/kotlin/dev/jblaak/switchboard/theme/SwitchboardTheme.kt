package dev.jblaak.switchboard.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf

private val LocalSwitchboardColors = staticCompositionLocalOf { DarkColors }

/**
 * Material 3 in Switchboard's palette, fonts and corners. Follows the system's dark theme.
 *
 * [darkTheme] is an opt-in override for previews and tests; the app leaves it to the system.
 */
@Composable
fun SwitchboardTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    val colors = if (darkTheme) DarkColors else LightColors
    CompositionLocalProvider(LocalSwitchboardColors provides colors) {
        MaterialTheme(
            colorScheme = colors.toColorScheme(),
            typography = SwitchboardTypography,
            shapes = SwitchboardShapes,
            content = content,
        )
    }
}

/** Switchboard's tokens beyond what [MaterialTheme] carries: the full text ramp and the status colours. */
object SwitchboardTheme {
    val colors: SwitchboardColors
        @Composable
        @ReadOnlyComposable
        get() = LocalSwitchboardColors.current
}
