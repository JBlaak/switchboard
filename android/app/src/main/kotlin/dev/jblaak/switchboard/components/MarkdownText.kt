package dev.jblaak.switchboard.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.isSpecified
import dev.jblaak.switchboard.theme.JetBrainsMonoFamily
import dev.jblaak.switchboard.theme.SwitchboardTheme

/** The house [InlineStyles]: code in JetBrains Mono on a tint, links in the accent colour, underlined. */
@Composable
fun rememberInlineStyles(): InlineStyles {
    val colors = SwitchboardTheme.colors
    return remember(colors) {
        InlineStyles(
            code = SpanStyle(fontFamily = JetBrainsMonoFamily, fontSize = 0.92.em, background = colors.line),
            links = TextLinkStyles(style = SpanStyle(color = colors.accent, textDecoration = TextDecoration.Underline)),
        )
    }
}

/** One line of [text]'s inline Markdown, in the house style. */
@Composable
fun rememberInlineMarkdown(text: String): AnnotatedString {
    val styles = rememberInlineStyles()
    return remember(text, styles) { inlineMarkdown(text, styles) }
}

/**
 * Claude's prose drawn as prose: paragraphs with room between them, lists with their markers hanging, code in a
 * panel of its own that scrolls sideways rather than wrapping, headings in bold and quotes behind a bar.
 */
@Composable
fun MarkdownText(text: String, style: TextStyle, color: Color, modifier: Modifier = Modifier) {
    val blocks = remember(text) { markdownBlocks(text) }
    val styles = rememberInlineStyles()
    Column(verticalArrangement = Arrangement.spacedBy(10.dp), modifier = modifier) {
        for (block in blocks) {
            when (block) {
                is MarkdownBlock.Paragraph -> Text(inline(block.lines.joinToString("\n"), styles), style = style, color = color)
                is MarkdownBlock.Heading -> Text(
                    inline(block.text, styles),
                    style = style.copy(fontWeight = FontWeight.ExtraBold),
                    color = SwitchboardTheme.colors.textStrong,
                )
                is MarkdownBlock.Bullets -> ListBlock(block, style, color, styles)
                is MarkdownBlock.Code -> CodeBlock(block.text, style)
                is MarkdownBlock.Quote -> QuoteBlock(block, style, styles)
            }
        }
    }
}

@Composable
private fun inline(text: String, styles: InlineStyles): AnnotatedString = remember(text, styles) { inlineMarkdown(text, styles) }

@Composable
private fun ListBlock(block: MarkdownBlock.Bullets, style: TextStyle, color: Color, styles: InlineStyles) {
    val markerWidth = if (block.items.any { it.marker.length > 2 }) 28.dp else if (block.ordered) 22.dp else 16.dp
    Column(verticalArrangement = Arrangement.spacedBy(5.dp)) {
        for (item in block.items) {
            Row(Modifier.padding(start = 16.dp * item.depth)) {
                Text(
                    item.marker,
                    style = style.copy(fontWeight = FontWeight.Bold),
                    color = SwitchboardTheme.colors.textMuted,
                    modifier = Modifier.width(markerWidth),
                )
                Text(inline(item.text, styles), style = style, color = color, modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun CodeBlock(code: String, style: TextStyle) {
    val colors = SwitchboardTheme.colors
    val shape = MaterialTheme.shapes.small
    Text(
        code,
        style = style.copy(
            fontFamily = JetBrainsMonoFamily,
            fontSize = if (style.fontSize.isSpecified) style.fontSize * 0.88f else style.fontSize,
            lineHeight = if (style.lineHeight.isSpecified) style.lineHeight * 0.92f else style.lineHeight,
        ),
        color = colors.textStrong,
        softWrap = false,
        modifier = Modifier
            .fillMaxWidth()
            .clip(shape)
            .background(colors.bgRaised)
            .border(1.dp, colors.line, shape)
            .horizontalScroll(rememberScrollState())
            .padding(horizontal = 12.dp, vertical = 10.dp),
    )
}

@Composable
private fun QuoteBlock(block: MarkdownBlock.Quote, style: TextStyle, styles: InlineStyles) {
    val colors = SwitchboardTheme.colors
    Text(
        inline(block.lines.joinToString("\n"), styles),
        style = style,
        color = colors.textMuted,
        modifier = Modifier
            .drawBehind { drawRect(colors.line, size = Size(3.dp.toPx(), size.height)) }
            .padding(start = 13.dp),
    )
}
