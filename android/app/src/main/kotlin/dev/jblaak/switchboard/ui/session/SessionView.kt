package dev.jblaak.switchboard.ui.session

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** How a session is shown: its terminal, or its transcript as a chat. */
enum class SessionView {
    Terminal,
    Chat,
}

/** Where the last choice of [SessionView] is kept, for every session. */
interface SessionViewStore {
    /** Null before the first choice. */
    fun loadOrNull(): SessionView?

    fun save(view: SessionView)
}

/**
 * The view sessions open in: the last one picked, for every session, kept across launches. The terminal until the
 * first pick, as it was before the chat view existed.
 */
class SessionViewChoice(private val store: SessionViewStore) {

    private val mutableView = MutableStateFlow(store.loadOrNull() ?: SessionView.Terminal)
    val view: StateFlow<SessionView> = mutableView.asStateFlow()

    /** The header's switch: the other view, from now on. */
    fun toggle() {
        val next = when (mutableView.value) {
            SessionView.Terminal -> SessionView.Chat
            SessionView.Chat -> SessionView.Terminal
        }
        mutableView.value = next
        store.save(next)
    }
}

/** Keeps the choice in the app's private preferences. */
class SharedPreferencesSessionViewStore(private val preferences: SharedPreferences) : SessionViewStore {

    override fun loadOrNull(): SessionView? {
        val name = preferences.getString(VIEW, null) ?: return null
        return SessionView.entries.firstOrNull { it.name == name }
    }

    override fun save(view: SessionView) {
        preferences.edit().putString(VIEW, view.name).apply()
    }

    private companion object {
        const val VIEW = "view"
    }
}

@Composable
fun rememberSessionViewChoice(): SessionViewChoice {
    val context = LocalContext.current
    return remember {
        SessionViewChoice(SharedPreferencesSessionViewStore(context.getSharedPreferences("session_view", Context.MODE_PRIVATE)))
    }
}
