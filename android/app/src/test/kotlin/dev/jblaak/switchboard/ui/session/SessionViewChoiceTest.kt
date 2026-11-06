package dev.jblaak.switchboard.ui.session

import org.junit.Assert.assertEquals
import org.junit.Test

class SessionViewChoiceTest {

    private class MemoryStore(var saved: SessionView? = null) : SessionViewStore {
        override fun loadOrNull(): SessionView? = saved

        override fun save(view: SessionView) {
            saved = view
        }
    }

    @Test
    fun `sessions open on the terminal until a view is picked`() {
        /* When */
        val choice = SessionViewChoice(MemoryStore())

        /* Then */
        assertEquals(SessionView.Terminal, choice.view.value)
    }

    @Test
    fun `the switch flips to the other view and keeps it`() {
        /* Given */
        val store = MemoryStore()
        val choice = SessionViewChoice(store)

        /* When */
        choice.toggle()

        /* Then */
        assertEquals(SessionView.Chat, choice.view.value)
        assertEquals(SessionView.Chat, store.saved)
    }

    @Test
    fun `the last pick holds for the next session opened`() {
        /* Given */
        val store = MemoryStore()
        SessionViewChoice(store).toggle()

        /* When */
        val next = SessionViewChoice(store)

        /* Then */
        assertEquals(SessionView.Chat, next.view.value)
    }
}
