package dev.jblaak.switchboard.link

import kotlin.time.Duration

/** How long to wait before each reconnect attempt: doubling from [first], never above [cap], [attempts] in all. */
class ReconnectBackoff(
    private val first: Duration,
    private val cap: Duration,
    private val attempts: Int,
) {

    /** Null once the attempts are used up: the Mac is not found. */
    fun delayBeforeOrNull(attempt: Int): Duration? {
        if (attempt !in 0 until attempts) return null
        val doubled = generateSequence(first) { it * 2 }.take(attempt + 1).last()
        return minOf(doubled, cap)
    }
}
