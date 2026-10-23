package dev.jblaak.switchboard.ui.ask

import dev.jblaak.switchboard.link.SendOutcome
import dev.jblaak.switchboard.protocol.AskCandidate
import dev.jblaak.switchboard.protocol.ClientMessage
import dev.jblaak.switchboard.protocol.PhoneAskResult
import dev.jblaak.switchboard.protocol.PhoneProject
import dev.jblaak.switchboard.protocol.ServerMessage
import dev.jblaak.switchboard.ui.connected.PhoneLink
import dev.jblaak.switchboard.ui.connected.SessionBoard
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Ask Patch from the phone: what the user typed goes to the Mac's router, which starts the session when it is
 * confident, offers up to three projects when it is unsure, and leaves the pick to the user when nothing matches
 * or the call fails. Either way the new session opens on this phone, sized to its terminal.
 */
class AskModel(
    private val link: PhoneLink,
    private val board: SessionBoard,
    private val events: Events,
    private val newRequestId: () -> String,
    scope: CoroutineScope,
) {

    private val mutableState = MutableStateFlow<AskStep>(AskStep.Compose(text = "", thinking = false, problem = null))
    val state: StateFlow<AskStep> = mutableState.asStateFlow()

    /** The request whose answer is awaited; anything for another one is stale. */
    private var requestId: String? = null
    private var projects: List<PhoneProject>? = null

    init {
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
            link.messages.collect { receive(it) }
        }
    }

    fun type(text: String) {
        mutableState.update { if (it is AskStep.Compose && !it.thinking) it.copy(text = text, problem = null) else it }
    }

    fun ask() {
        val compose = mutableState.value as? AskStep.Compose ?: return
        if (compose.text.isBlank() || compose.thinking) return
        val id = newRequestId()
        val size = board.terminalSize.value
        val outcome = link.send(ClientMessage.Ask(id, compose.text.trim(), size?.cols, size?.rows))
        if (outcome == SendOutcome.NotConnected) {
            mutableState.value = compose.copy(problem = AskProblem.NotConnected)
            return
        }
        requestId = id
        mutableState.value = compose.copy(thinking = true, problem = null)
    }

    /** "Pick the project myself": skip routing; the text goes in as typed. */
    fun pickProjectMyself() {
        val compose = mutableState.value as? AskStep.Compose ?: return
        if (compose.text.isBlank() || compose.thinking) return
        showProjects(compose.text.trim(), compose.text.trim(), ProjectsReason.OwnPick)
    }

    /** "Another project…" under Patch's guesses: the prompt Patch wrote goes with it. */
    fun anotherProject() {
        val pick = mutableState.value as? AskStep.Pick ?: return
        if (pick.starting != null) return
        showProjects(pick.text, pick.prompt, ProjectsReason.Another)
    }

    fun filter(text: String) {
        mutableState.update { if (it is AskStep.Projects) it.copy(filter = text) else it }
    }

    fun start(projectPath: String) {
        val (prompt, starting) = when (val step = mutableState.value) {
            is AskStep.Pick -> step.prompt to step.starting
            is AskStep.Projects -> step.prompt to step.starting
            is AskStep.Compose -> return
        }
        if (starting != null) return
        val id = newRequestId()
        val size = board.terminalSize.value
        val outcome = link.send(ClientMessage.AskStart(id, projectPath, prompt, size?.cols, size?.rows))
        if (outcome == SendOutcome.NotConnected) return showProblem(AskProblem.NotConnected)
        requestId = id
        mutableState.update {
            when (it) {
                is AskStep.Pick -> it.copy(starting = projectPath, problem = null)
                is AskStep.Projects -> it.copy(starting = projectPath, problem = null)
                is AskStep.Compose -> it
            }
        }
    }

    /** Back: cancels Patch while it thinks, steps back from a list, and closes Ask Patch from the start. */
    fun back() {
        when (val step = mutableState.value) {
            is AskStep.Compose -> if (step.thinking) cancel(step) else events.askClosed()
            is AskStep.Pick -> if (step.starting == null) {
                backTo(AskStep.Compose(step.text, thinking = false, problem = null))
            }
            is AskStep.Projects -> if (step.starting == null) when (val from = step.from) {
                null -> backTo(AskStep.Compose(step.text, thinking = false, problem = null))
                else -> backTo(from)
            }
        }
    }

    /** Ask Patch is going away: a routing call still running is killed, not left on the user's quota. */
    fun close() {
        val step = mutableState.value
        if (step is AskStep.Compose && step.thinking) cancel(step)
    }

    private fun cancel(step: AskStep.Compose) {
        requestId?.let { link.send(ClientMessage.AskCancel(it)) }
        requestId = null
        mutableState.value = step.copy(thinking = false)
    }

    private fun backTo(step: AskStep) {
        requestId = null
        mutableState.value = step
    }

    private fun receive(message: ServerMessage) {
        when (message) {
            is ServerMessage.AskResult -> if (message.requestId == requestId) routed(message.result)
            is ServerMessage.AskStarted -> if (message.requestId == requestId) started(message.sessionId)
            is ServerMessage.AskError -> if (message.requestId == requestId) {
                requestId = null
                showProblem(AskProblem.Mac(message.error))
            }
            is ServerMessage.Projects -> {
                projects = message.projects
                mutableState.update { if (it is AskStep.Projects) it.copy(projects = message.projects) else it }
            }
            else -> Unit
        }
    }

    private fun routed(result: PhoneAskResult) {
        val compose = mutableState.value as? AskStep.Compose ?: return
        val text = compose.text.trim()
        requestId = null
        when (result) {
            is PhoneAskResult.Confident -> events.askSessionStarted(result.sessionId, result.project)
            is PhoneAskResult.Unsure -> mutableState.value = AskStep.Pick(
                text = text,
                candidates = result.candidates,
                prompt = result.prompt,
                starting = null,
                problem = null,
            )
            is PhoneAskResult.NoMatch -> showProjects(text, text, ProjectsReason.NoMatch(result.reason))
            is PhoneAskResult.Failed -> showProjects(text, text, ProjectsReason.Failed(result.reason))
            PhoneAskResult.Cancelled -> mutableState.value = compose.copy(thinking = false)
        }
    }

    private fun started(sessionId: String) {
        val path = when (val step = mutableState.value) {
            is AskStep.Pick -> step.starting
            is AskStep.Projects -> step.starting
            is AskStep.Compose -> null
        } ?: return
        requestId = null
        events.askSessionStarted(sessionId, folderOf(path))
    }

    private fun showProjects(text: String, prompt: String, reason: ProjectsReason) {
        val from = mutableState.value as? AskStep.Pick
        mutableState.value = AskStep.Projects(
            text = text,
            prompt = prompt,
            reason = reason,
            projects = projects,
            filter = "",
            starting = null,
            problem = null,
            from = from,
        )
        link.send(ClientMessage.ListProjects)
    }

    private fun showProblem(problem: AskProblem) {
        mutableState.update {
            when (it) {
                is AskStep.Compose -> it.copy(thinking = false, problem = problem)
                is AskStep.Pick -> it.copy(starting = null, problem = problem)
                is AskStep.Projects -> it.copy(starting = null, problem = problem)
            }
        }
    }

    interface Events {
        /** A session started, active on this phone, in [project] (its folder name). */
        fun askSessionStarted(sessionId: String, project: String)

        fun askClosed()
    }
}

sealed interface AskStep {

    /** "What are we working on?"; [thinking] while Patch routes it. */
    data class Compose(val text: String, val thinking: Boolean, val problem: AskProblem?) : AskStep

    /** Patch is unsure: its guesses, and the first prompt it wrote for whichever is picked. */
    data class Pick(
        val text: String,
        val candidates: List<AskCandidate>,
        val prompt: String,
        /** The project being started, while the Mac starts it. */
        val starting: String?,
        val problem: AskProblem?,
    ) : AskStep

    /** The local projects to pick from; null [projects] until the Mac sends them. */
    data class Projects(
        val text: String,
        /** What the session is told first. */
        val prompt: String,
        val reason: ProjectsReason,
        val projects: List<PhoneProject>?,
        val filter: String,
        val starting: String?,
        val problem: AskProblem?,
        /** Patch's guesses this list was opened from, to go back to. */
        val from: Pick?,
    ) : AskStep {
        val shown: List<PhoneProject>
            get() = projects.orEmpty().filter {
                filter.isBlank() || it.folder.contains(filter.trim(), ignoreCase = true) ||
                    it.path.contains(filter.trim(), ignoreCase = true)
            }
    }
}

/** Why the project list is up, which sets what Patch says above it. */
sealed interface ProjectsReason {
    data object OwnPick : ProjectsReason
    data object Another : ProjectsReason

    /** Patch's one line on why nothing matched. */
    data class NoMatch(val reason: String) : ProjectsReason

    data class Failed(val reason: String) : ProjectsReason
}

sealed interface AskProblem {
    data object NotConnected : AskProblem
    data class Mac(val error: String) : AskProblem
}

fun folderOf(path: String): String = path.trimEnd('/').substringAfterLast('/')

/** "/Users/joris/Development/JBlaak/switchboard" → "~/Development/JBlaak". */
fun parentLabelOf(path: String): String {
    val parent = path.trimEnd('/').substringBeforeLast('/', missingDelimiterValue = "")
    return parent.replaceFirst(Regex("^/Users/[^/]+"), "~")
}
