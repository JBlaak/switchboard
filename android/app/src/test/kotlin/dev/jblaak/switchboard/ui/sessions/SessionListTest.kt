package dev.jblaak.switchboard.ui.sessions

import dev.jblaak.switchboard.protocol.ErrandKind
import dev.jblaak.switchboard.protocol.SessionState
import dev.jblaak.switchboard.protocol.TerminalOwner
import dev.jblaak.switchboard.protocol.WaitingReason
import dev.jblaak.switchboard.ui.connected.DEVICE_ID
import dev.jblaak.switchboard.ui.connected.THIS_PHONE
import dev.jblaak.switchboard.ui.connected.pendingQuestions
import dev.jblaak.switchboard.ui.connected.phoneErrand
import dev.jblaak.switchboard.ui.connected.phoneSession
import dev.jblaak.switchboard.ui.connected.question
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class SessionListTest {

    @Test
    fun `sessions fall into needs you, working and ready, each in the Mac's order`() {
        /* Given */
        val sessions = listOf(
            phoneSession("n1", SessionState.NeedsYou),
            phoneSession("r1", SessionState.Idle),
            phoneSession("n2", SessionState.NeedsYou),
            phoneSession("w1", SessionState.Busy),
            phoneSession("r2", SessionState.Idle),
        )

        /* When */
        val list = sessionListOf(sessions, emptyList(), DEVICE_ID)

        /* Then */
        assertEquals(listOf("n1", "n2"), list.needsYou.map { it.id })
        assertEquals(listOf("w1"), list.working.map { it.id })
        assertEquals(listOf("r1", "r2"), list.ready.map { it.id })
    }

    @Test
    fun `errands leave the sections and are listed apart`() {
        /* Given */
        val sessions = listOf(
            phoneSession("mine", SessionState.Busy),
            phoneSession("fixer", SessionState.Busy, errand = phoneErrand()),
            phoneSession("nudger", SessionState.Idle, errand = phoneErrand(kind = ErrandKind.Nudge, doing = "nudging the reviewer")),
        )

        /* When */
        val list = sessionListOf(sessions, emptyList(), DEVICE_ID)

        /* Then */
        assertEquals(emptyList<String>(), list.needsYou.map { it.id })
        assertEquals(listOf("mine"), list.working.map { it.id })
        assertEquals(emptyList<String>(), list.ready.map { it.id })
        assertEquals(listOf("fixer", "nudger"), list.errands.map { it.id })
        assertEquals(0, list.errandsNeedingYou)
    }

    @Test
    fun `a stuck errand also stays in needs you, after the user's own sessions`() {
        /* Given */
        val sessions = listOf(
            phoneSession("stuck", SessionState.Idle, errand = phoneErrand(doing = "stopped: asks", needsYou = true)),
            phoneSession("mine", SessionState.NeedsYou, waiting = WaitingReason.Terminal),
            phoneSession("fixer", SessionState.Busy, errand = phoneErrand(number = 432)),
        )

        /* When */
        val list = sessionListOf(sessions, emptyList(), DEVICE_ID)

        /* Then */
        assertEquals(listOf("mine", "stuck"), list.needsYou.map { it.id })
        assertEquals(SessionStatus.NeedsYou, list.needsYou[1].status)
        assertEquals(Errand(ErrandKind.Fix, 431, "jblaak/switchboard", "stopped: asks", needsYou = true), list.needsYou[1].errand)
        assertEquals(listOf("stuck", "fixer"), list.errands.map { it.id })
        assertEquals(1, list.errandsNeedingYou)
    }

    @Test
    fun `an errand whose session is blocked on the user needs you too`() {
        /* Given */
        val sessions = listOf(phoneSession("asking", SessionState.NeedsYou, waiting = WaitingReason.Questions, errand = phoneErrand()))

        /* When */
        val list = sessionListOf(sessions, emptyList(), DEVICE_ID)

        /* Then */
        assertEquals(listOf("asking"), list.needsYou.map { it.id })
        assertEquals(listOf("asking"), list.errands.map { it.id })
    }

    @Test
    fun `a list of only errands is not empty`() {
        /* Given */
        val sessions = listOf(phoneSession("fixer", SessionState.Busy, errand = phoneErrand()))

        /* When */
        val list = sessionListOf(sessions, emptyList(), DEVICE_ID)

        /* Then */
        assertFalse(list.isEmpty)
    }

    @Test
    fun `the user's own session carries no errand`() {
        /* Given */
        val session = phoneSession("mine")

        /* When */
        val row = sessionRowOf(session, emptyList(), DEVICE_ID)

        /* Then */
        assertNull(row.errand)
    }

    @Test
    fun `a session waiting on questions counts every question it is asked`() {
        /* Given */
        val session = phoneSession("a", SessionState.NeedsYou, waiting = WaitingReason.Questions)
        val pending = listOf(pendingQuestions("a", questions = listOf(question("One?"), question("Two?"), question("Three?"))))

        /* When */
        val row = sessionRowOf(session, pending, DEVICE_ID)

        /* Then */
        assertEquals(Waiting.Questions(3), row.waiting)
    }

    @Test
    fun `a session waiting in the terminal says so`() {
        /* Given */
        val session = phoneSession("a", SessionState.NeedsYou, waiting = WaitingReason.Terminal)

        /* When */
        val row = sessionRowOf(session, emptyList(), DEVICE_ID)

        /* Then */
        assertEquals(Waiting.Terminal, row.waiting)
    }

    @Test
    fun `a session owned by this phone is on this phone`() {
        /* Given */
        val session = phoneSession("a", owner = THIS_PHONE)

        /* When */
        val row = sessionRowOf(session, emptyList(), DEVICE_ID)

        /* Then */
        assertEquals(TerminalPlace.ThisPhone, row.place)
    }

    @Test
    fun `a session owned by another phone names that phone`() {
        /* Given */
        val session = phoneSession("a", owner = TerminalOwner.Device("device-2", "Pixel 8"))

        /* When */
        val row = sessionRowOf(session, emptyList(), DEVICE_ID)

        /* Then */
        assertEquals(TerminalPlace.OtherPhone("Pixel 8"), row.place)
    }

    @Test
    fun `elapsed time reads in minutes, hours and days`() {
        /* Given */
        val minute = 60_000L

        /* When */
        val labels = listOf(30_000L, 2 * minute, 3 * 60 * minute, 2 * 24 * 60 * minute).map { elapsedLabelOrNull(0, it) }

        /* Then */
        assertEquals(listOf(null, "2m", "3h", "2d"), labels)
    }

    @Test
    fun `a change in the future reads as just now`() {
        /* Given */
        val changedAt = 10_000L

        /* When */
        val label = elapsedLabelOrNull(changedAt, now = 0)

        /* Then */
        assertNull(label)
    }
}
