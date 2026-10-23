package dev.jblaak.switchboard.lock

import kotlin.time.Duration

/**
 * Whether the app needs a biometric unlock: locked when it opens, and again when it comes back after
 * [timeout] or longer in the background. Times are read from one monotonic clock (`elapsedRealtime`).
 */
class AppLock(private val timeout: Duration) {

    var isLocked: Boolean = true
        private set

    private var backgroundedAt: Duration? = null

    fun unlocked() {
        isLocked = false
    }

    fun backgrounded(at: Duration) {
        backgroundedAt = at
    }

    fun foregrounded(at: Duration) {
        val since = backgroundedAt ?: return
        backgroundedAt = null
        if (at - since >= timeout) isLocked = true
    }
}
