package dev.jblaak.switchboard.components

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle

/**
 * The Markdown Claude writes its prose in, read into blocks the phone draws as its own elements: paragraphs split
 * by blank lines, bullet and numbered lists (nested by indent), fenced code, headings and quotes. Anything else
 * stays as the text it is. Inline marks inside a block are read by [inlineMarkdown].
 */
sealed interface MarkdownBlock {
    /** Lines that run together; each line keeps its own line, as Claude broke them. */
    data class Paragraph(val lines: List<String>) : MarkdownBlock

    data class Heading(val text: String) : MarkdownBlock

    data class Bullets(val ordered: Boolean, val items: List<ListItem>) : MarkdownBlock

    /** A fenced block, verbatim but for the indent every line shares. */
    data class Code(val text: String) : MarkdownBlock

    data class Quote(val lines: List<String>) : MarkdownBlock
}

/** One list item: its [marker] as drawn ("•", "1."), how deep it is nested, and its text. */
data class ListItem(val marker: String, val depth: Int, val text: String)

private val FENCE = Regex("""^\s*(```|~~~)""")
private val HEADING = Regex("""^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$""")
private val RULE = Regex("""^\s*(?:-{3,}|\*{3,}|_{3,})\s*$""")
private val BULLET = Regex("""^(\s*)[-*•+]\s+(.*)$""")
private val NUMBERED = Regex("""^(\s*)(\d{1,3})[.)]\s+(.*)$""")
private val QUOTE = Regex("""^\s*>\s?(.*)$""")
private const val MAX_DEPTH = 3

/** [text] as blocks, top to bottom. */
fun markdownBlocks(text: String): List<MarkdownBlock> {
    val blocks = mutableListOf<MarkdownBlock>()
    val lines = text.replace("\r\n", "\n").split('\n')
    var paragraph = mutableListOf<String>()
    var quote = mutableListOf<String>()
    var items = mutableListOf<ListItem>()
    var ordered = false

    fun flush() {
        if (paragraph.isNotEmpty()) blocks += MarkdownBlock.Paragraph(paragraph)
        if (quote.isNotEmpty()) blocks += MarkdownBlock.Quote(quote)
        if (items.isNotEmpty()) blocks += MarkdownBlock.Bullets(ordered, items)
        paragraph = mutableListOf()
        quote = mutableListOf()
        items = mutableListOf()
    }

    fun item(isOrdered: Boolean, indent: String, marker: String, body: String) {
        if (items.isNotEmpty() && ordered != isOrdered && indent.isEmpty()) flush()
        if (items.isEmpty()) {
            flush()
            ordered = isOrdered
        }
        items += ListItem(marker, depthOf(indent), body.trim())
    }

    var at = 0
    while (at < lines.size) {
        val line = lines[at]
        val fence = FENCE.find(line)
        val bullet = BULLET.find(line)
        val numbered = NUMBERED.find(line)
        val quoted = QUOTE.find(line)
        when {
            fence != null -> {
                flush()
                val code = mutableListOf<String>()
                at++
                while (at < lines.size && !lines[at].trimStart().startsWith(fence.groupValues[1])) code += lines[at++]
                blocks += MarkdownBlock.Code(code.joinToString("\n").trimIndent().trimEnd())
            }
            line.isBlank() || RULE.matches(line) -> flush()
            HEADING.matches(line) -> {
                flush()
                blocks += MarkdownBlock.Heading(HEADING.find(line)!!.groupValues[1])
            }
            numbered != null -> item(true, numbered.groupValues[1], "${numbered.groupValues[2]}.", numbered.groupValues[3])
            bullet != null -> item(false, bullet.groupValues[1], "•", bullet.groupValues[2])
            quoted != null -> {
                if (quote.isEmpty()) flush()
                quote += quoted.groupValues[1].trim()
            }
            items.isNotEmpty() && line.first().isWhitespace() -> {
                // An indented line under a list item carries on that item.
                val last = items.removeAt(items.lastIndex)
                items += last.copy(text = "${last.text} ${line.trim()}")
            }
            else -> {
                if (paragraph.isEmpty()) flush()
                paragraph += line.trim()
            }
        }
        at++
    }
    flush()
    return blocks
}

private fun depthOf(indent: String): Int {
    val columns = indent.sumOf { if (it == '\t') 4 else 1 }
    return (columns / 2).coerceAtMost(MAX_DEPTH)
}

/** How [inlineMarkdown] draws its marks. */
data class InlineStyles(val code: SpanStyle, val links: TextLinkStyles?)

private val INLINE = Regex(
    listOf(
        """`([^`]+)`""",
        """\*\*(.+?)\*\*""",
        """__(.+?)__""",
        """\*([^*\s](?:[^*]*[^*\s])?)\*""",
        """(?<![\w])_([^_\s](?:[^_]*[^_\s])?)_(?![\w])""",
        """\[([^\]]+)\]\(([^)\s]+)\)""",
    ).joinToString("|"),
)

private val BOLD = SpanStyle(fontWeight = FontWeight.Bold)
private val ITALIC = SpanStyle(fontStyle = FontStyle.Italic)

/**
 * [text]'s inline Markdown styled, its marks taken out: `code`, **bold** and __bold__, *italic* and _italic_, and
 * [links](https://…). Web links written out bare are made tappable too; only http and https ever open.
 */
fun inlineMarkdown(text: String, styles: InlineStyles): AnnotatedString {
    val builder = AnnotatedString.Builder()
    val linked = mutableListOf<IntRange>()
    appendInline(builder, text, styles, linked)
    val plain = builder.toAnnotatedString().text
    for (range in webLinksIn(plain)) {
        if (linked.none { it.first <= range.last && range.first <= it.last }) {
            builder.addLink(LinkAnnotation.Url(plain.substring(range), styles.links), range.first, range.last + 1)
        }
    }
    return builder.toAnnotatedString()
}

private fun appendInline(builder: AnnotatedString.Builder, text: String, styles: InlineStyles, linked: MutableList<IntRange>) {
    var at = 0
    for (match in INLINE.findAll(text)) {
        builder.append(text.substring(at, match.range.first))
        val groups = match.groups
        when {
            groups[1] != null -> builder.withStyle(styles.code) { append(groups[1]!!.value) }
            groups[2] != null || groups[3] != null ->
                builder.withStyle(BOLD) { appendInline(this, (groups[2] ?: groups[3])!!.value, styles, linked) }
            groups[4] != null || groups[5] != null ->
                builder.withStyle(ITALIC) { appendInline(this, (groups[4] ?: groups[5])!!.value, styles, linked) }
            else -> {
                val label = groups[6]!!.value
                val href = groups[7]!!.value
                if (href.startsWith("https://", ignoreCase = true) || href.startsWith("http://", ignoreCase = true)) {
                    val start = builder.length
                    builder.withLink(LinkAnnotation.Url(href, styles.links)) { append(label) }
                    linked += start until builder.length
                } else {
                    builder.append(label)
                }
            }
        }
        at = match.range.last + 1
    }
    builder.append(text.substring(at))
}
