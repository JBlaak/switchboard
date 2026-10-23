package dev.jblaak.switchboard.theme

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.Parameterized
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

@RunWith(Parameterized::class)
class PaletteContrastTest(
    private val name: String,
    private val pair: ContrastPair,
) {

    @Test
    fun `text meets 4·5 to 1 on its surface`() {
        /* Given */
        val required = 4.5

        /* When */
        val ratio = contrast(pair.foreground, pair.background)

        /* Then */
        assertTrue("$name is ${"%.2f".format(ratio)}:1", ratio >= required)
    }

    companion object {
        @JvmStatic
        @Parameterized.Parameters(name = "{0}")
        fun pairs(): List<Array<Any>> {
            return listOf(DarkColors, LightColors)
                .flatMap { colors -> textOnSurfaces(colors) + inksOnFills(colors) + onFilledControls(colors) }
                .map { (name, foreground, background) -> arrayOf(name, ContrastPair(foreground, background)) }
        }

        private fun textOnSurfaces(colors: SwitchboardColors): List<Triple<String, Color, Color>> {
            val texts = mapOf(
                "textStrong" to colors.textStrong,
                "text" to colors.text,
                "textDim" to colors.textDim,
                "textMuted" to colors.textMuted,
                "accent" to colors.accent,
                "danger" to colors.danger,
                "running" to colors.running.ink,
                "needsYou" to colors.needsYou.ink,
                "ready" to colors.ready.ink,
                "pinned" to colors.pinned.ink,
                "remote" to colors.remote.ink,
            )
            val surfaces = mapOf("bgBase" to colors.bgBase, "bgPanel" to colors.bgPanel, "bgRaised" to colors.bgRaised)
            return texts.flatMap { (textName, text) ->
                surfaces.map { (surfaceName, surface) -> Triple("${colors.label} $textName on $surfaceName", text, surface) }
            }
        }

        private fun inksOnFills(colors: SwitchboardColors): List<Triple<String, Color, Color>> {
            return mapOf(
                "running" to colors.running,
                "needsYou" to colors.needsYou,
                "ready" to colors.ready,
                "pinned" to colors.pinned,
                "remote" to colors.remote,
            ).map { (statusName, status) -> Triple("${colors.label} $statusName ink on its fill", status.ink, status.fill) }
        }

        private fun onFilledControls(colors: SwitchboardColors): List<Triple<String, Color, Color>> {
            return listOf(
                Triple("${colors.label} onAccent on accent", colors.onAccent, colors.accent),
                Triple("${colors.label} actionText on action", colors.actionText, colors.action),
            )
        }

        private val SwitchboardColors.label: String get() = if (isDark) "dark" else "light"

        private fun contrast(first: Color, second: Color): Double {
            val lighter = max(luminance(first), luminance(second))
            val darker = min(luminance(first), luminance(second))
            return (lighter + 0.05) / (darker + 0.05)
        }

        private fun luminance(color: Color): Double {
            fun channel(value: Float): Double {
                val srgb = value.toDouble()
                return if (srgb <= 0.04045) srgb / 12.92 else ((srgb + 0.055) / 1.055).pow(2.4)
            }
            return 0.2126 * channel(color.red) + 0.7152 * channel(color.green) + 0.0722 * channel(color.blue)
        }
    }
}

data class ContrastPair(val foreground: Color, val background: Color)
