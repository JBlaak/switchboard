package dev.jblaak.switchboard.components

import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import dev.jblaak.switchboard.components.MarkdownBlock.Bullets
import dev.jblaak.switchboard.components.MarkdownBlock.Code
import dev.jblaak.switchboard.components.MarkdownBlock.Heading
import dev.jblaak.switchboard.components.MarkdownBlock.Paragraph
import dev.jblaak.switchboard.components.MarkdownBlock.Quote
import org.junit.Assert.assertEquals
import org.junit.Test

class MarkdownTest {

    private val code = SpanStyle(background = androidx.compose.ui.graphics.Color.Gray)
    private val styles = InlineStyles(code = code, links = null)

    private fun AnnotatedString.styled(style: SpanStyle): List<String> =
        spanStyles.filter { it.item == style }.map { text.substring(it.start, it.end) }

    private fun AnnotatedString.links(): List<Pair<String, String>> =
        getLinkAnnotations(0, length).map { text.substring(it.start, it.end) to (it.item as LinkAnnotation.Url).url }

    @Test
    fun `blank lines split prose into paragraphs that keep their own line breaks`() {
        /* Given */
        val text = "Today archive only hides the row.\nThe history stays whole.\n\n\nA second thought."

        /* When */
        val blocks = markdownBlocks(text)

        /* Then */
        assertEquals(
            listOf(
                Paragraph(listOf("Today archive only hides the row.", "The history stays whole.")),
                Paragraph(listOf("A second thought.")),
            ),
            blocks,
        )
    }

    @Test
    fun `a list straight after a lead line is its own block`() {
        /* Given */
        val text = "Two ways to go:\n- keep the row\n* drop it\n• or archive it\nThat's all."

        /* When */
        val blocks = markdownBlocks(text)

        /* Then */
        assertEquals(
            listOf(
                Paragraph(listOf("Two ways to go:")),
                Bullets(ordered = false, items = listOf(ListItem("•", 0, "keep the row"), ListItem("•", 0, "drop it"), ListItem("•", 0, "or archive it"))),
                Paragraph(listOf("That's all.")),
            ),
            blocks,
        )
    }

    @Test
    fun `numbered items keep their numbers, nest by indent, and carry on over indented lines`() {
        /* Given */
        val text = "1. First step\n   which wraps here\n2) Second step\n  - a detail under it"

        /* When */
        val blocks = markdownBlocks(text)

        /* Then */
        assertEquals(
            listOf(
                Bullets(
                    ordered = true,
                    items = listOf(
                        ListItem("1.", 0, "First step which wraps here"),
                        ListItem("2.", 0, "Second step"),
                        ListItem("•", 1, "a detail under it"),
                    ),
                ),
            ),
            blocks,
        )
    }

    @Test
    fun `a fenced block stays verbatim, blank lines and markers included`() {
        /* Given */
        val text = "Run this:\n```bash\n  npm ci\n\n  - not a list\n```\nThen restart."

        /* When */
        val blocks = markdownBlocks(text)

        /* Then */
        assertEquals(
            listOf(Paragraph(listOf("Run this:")), Code("npm ci\n\n- not a list"), Paragraph(listOf("Then restart."))),
            blocks,
        )
    }

    @Test
    fun `an unclosed fence runs to the end`() {
        /* Given */
        val text = "```\nval a = 1"

        /* When */
        val blocks = markdownBlocks(text)

        /* Then */
        assertEquals(listOf(Code("val a = 1")), blocks)
    }

    @Test
    fun `headings and quotes are blocks, and rules only separate`() {
        /* Given */
        val text = "## The plan\n> what you said\n> earlier\n---\nNext."

        /* When */
        val blocks = markdownBlocks(text)

        /* Then */
        assertEquals(
            listOf(Heading("The plan"), Quote(listOf("what you said", "earlier")), Paragraph(listOf("Next."))),
            blocks,
        )
    }

    @Test
    fun `inline marks are styled and taken out of the text`() {
        /* Given */
        val text = "Keep **the `sessions` table** and *only* add _one_ `archived_at` column, __not__ two."

        /* When */
        val styled = inlineMarkdown(text, styles)

        /* Then */
        assertEquals("Keep the sessions table and only add one archived_at column, not two.", styled.text)
        assertEquals(listOf("the sessions table", "not"), styled.styled(SpanStyle(fontWeight = FontWeight.Bold)))
        assertEquals(listOf("only", "one"), styled.styled(SpanStyle(fontStyle = FontStyle.Italic)))
        assertEquals(listOf("sessions", "archived_at"), styled.styled(code))
    }

    @Test
    fun `underscores inside words and lone asterisks stay as they are`() {
        /* Given */
        val text = "Set snake_case_name and 2 * 3 * 4 in archived_at"

        /* When */
        val styled = inlineMarkdown(text, styles)

        /* Then */
        assertEquals(text, styled.text)
        assertEquals(emptyList<String>(), styled.styled(SpanStyle(fontStyle = FontStyle.Italic)))
    }

    @Test
    fun `written links and bare links open, other schemes do not`() {
        /* Given */
        val text = "See [the PR](https://github.com/JBlaak/switchboard/pull/336), https://example.com/a and [this](intent://x)."

        /* When */
        val styled = inlineMarkdown(text, styles)

        /* Then */
        assertEquals("See the PR, https://example.com/a and this.", styled.text)
        assertEquals(
            listOf("the PR" to "https://github.com/JBlaak/switchboard/pull/336", "https://example.com/a" to "https://example.com/a"),
            styled.links(),
        )
    }
}
