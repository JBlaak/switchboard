package dev.jblaak.switchboard.ui.session

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TerminalScriptTest {

    private fun base64(text: String) = Base64.getEncoder().encodeToString(text.toByteArray(Charsets.UTF_8))

    @Test
    fun `a frame's output goes in one write`() {
        /* Given */
        val writes = listOf(TerminalWrite.Output("⏺ one "), TerminalWrite.Output("two\r\n"))

        /* When */
        val script = terminalScriptOf(writes)

        /* Then */
        assertEquals("sb.write('${base64("⏺ one two\r\n")}');", script)
    }

    @Test
    fun `quotes, backslashes and escapes cannot break out of the script`() {
        /* Given */
        val nasty = "'); alert(1); //\\ \u001b[31m </script> "

        /* When */
        val script = terminalScriptOf(listOf(TerminalWrite.Output(nasty)))

        /* Then */
        val payload = script.removePrefix("sb.write('").removeSuffix("');")
        assertEquals(nasty, String(Base64.getDecoder().decode(payload), Charsets.UTF_8))
        assertEquals(true, payload.all { it.isLetterOrDigit() || it == '+' || it == '/' || it == '=' })
    }

    @Test
    fun `a reset drops the output before it`() {
        /* Given */
        val writes = listOf(TerminalWrite.Output("old"), TerminalWrite.Reset, TerminalWrite.Output("new"))

        /* When */
        val script = terminalScriptOf(writes)

        /* Then */
        assertEquals("sb.reset();sb.write('${base64("new")}');", script)
    }

    @Test
    fun `the page's ready and size messages are read`() {
        /* Given */
        val messages = listOf("ready 48 30", "size 48 18")

        /* When */
        val events = messages.map(::terminalEventOrNull)

        /* Then */
        assertEquals(listOf(TerminalEvent.Ready(TerminalSize(48, 30)), TerminalEvent.Resized(TerminalSize(48, 18))), events)
    }

    @Test
    fun `the page's input is read as the bytes it carries`() {
        /* Given */
        val message = "input ${base64("\u001b[<65;20;10M\u001b[<65;20;10M")}"

        /* When */
        val event = terminalEventOrNull(message)

        /* Then */
        assertEquals(TerminalEvent.Input("\u001b[<65;20;10M\u001b[<65;20;10M"), event)
    }

    @Test
    fun `input that is not base64 is ignored`() {
        /* Given */
        val message = "input not*base64"

        /* When */
        val event = terminalEventOrNull(message)

        /* Then */
        assertNull(event)
    }

    @Test
    fun `anything else from the page is ignored`() {
        /* Given */
        val message = "size 0 30"

        /* When */
        val event = terminalEventOrNull(message)

        /* Then */
        assertNull(event)
    }

    @Test
    fun `control characters inside a pasted prompt are dropped`() {
        /* Given */
        val prompt = "line one\r\nline \u001b[31mtwo\u0003"

        /* When */
        val paste = pasteOf(prompt)

        /* Then */
        assertEquals("\u001b[200~line one\nline [31mtwo\u001b[201~", paste)
    }
}
