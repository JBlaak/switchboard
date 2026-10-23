package dev.jblaak.switchboard.protocol

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement

internal fun fixture(path: String): String {
    val resource = requireNotNull(Fixtures::class.java.getResource("/protocol/$path.json")) { "No fixture $path" }
    return resource.readText()
}

internal fun jsonOf(text: String): JsonElement = Json.parseToJsonElement(text)

private object Fixtures

internal val clientFixtures: List<Pair<String, ClientMessage>> = listOf(
    "hello" to ClientMessage.Hello(protocol = 1, appVersion = "0.1.0"),
    "pair" to ClientMessage.Pair(code = "482913", deviceName = "Pixel 9"),
    "attach" to ClientMessage.Attach(sessionId = "s-1", cols = 48, rows = 30),
    "detach" to ClientMessage.Detach(sessionId = "s-1"),
    "size" to ClientMessage.Size(sessionId = "s-1", cols = 80, rows = 24),
    "use-here" to ClientMessage.UseHere(sessionId = "s-1"),
    "input" to ClientMessage.Input(sessionId = "s-1", data = "yes\r"),
    "answer" to ClientMessage.Answer(
        sessionId = "s-1",
        toolUseId = "toolu_01",
        answers = mapOf(
            "Which transport?" to "WebSocket (Recommended)",
            "Which screens?" to "Sessions, Terminal",
        ),
    ),
    "ask" to ClientMessage.Ask(requestId = "r-1", text = "Bump the release notes for v2.8.2", cols = null, rows = null),
    "ask-sized" to ClientMessage.Ask(requestId = "r-1", text = "Bump the release notes for v2.8.2", cols = 48, rows = 30),
    "ask-cancel" to ClientMessage.AskCancel(requestId = "r-1"),
    "ask-start" to ClientMessage.AskStart(
        requestId = "r-1",
        projectPath = "/Users/joris/Development/switchboard",
        prompt = "Bump the release notes",
        cols = null,
        rows = null,
    ),
    "ask-start-sized" to ClientMessage.AskStart(
        requestId = "r-1",
        projectPath = "/Users/joris/Development/switchboard",
        prompt = "Bump the release notes",
        cols = 48,
        rows = 30,
    ),
    "list-projects" to ClientMessage.ListProjects,
    "archive" to ClientMessage.Archive(sessionId = "s-1"),
)

private const val SWITCHBOARD_PATH = "/Users/joris/Development/switchboard"
private val pixel = TerminalOwner.Device(deviceId = "d-7", name = "Pixel 9")

internal val serverFixtures: List<Pair<String, ServerMessage>> = listOf(
    "welcome" to ServerMessage.Welcome(protocol = 1, macName = "Joris MacBook Pro", deviceId = "d-7"),
    "pairing" to ServerMessage.Pairing(protocol = 1, macName = "Joris MacBook Pro"),
    "pair-pending" to ServerMessage.PairPending,
    "pair-accepted" to ServerMessage.PairAccepted(deviceId = "d-7"),
    "pair-rejected" to ServerMessage.PairRejected(reason = PairRejection.WrongCode),
    "update-required" to ServerMessage.UpdateRequired(protocol = 2, macVersion = "2.9.0"),
    "sessions" to ServerMessage.Sessions(
        sessions = listOf(
            PhoneSession(
                id = "s-1",
                name = "Phone access pairing flow",
                project = "switchboard",
                projectPath = SWITCHBOARD_PATH,
                remote = null,
                state = SessionState.NeedsYou,
                waiting = WaitingReason.Questions,
                owner = TerminalOwner.Mac,
                changedAt = 1792756800000,
            ),
            PhoneSession(
                id = "s-2",
                name = "Runner disk cleanup",
                project = "ci-mini",
                projectPath = "/home/ci/runner",
                remote = "ci@ci-mini",
                state = SessionState.Busy,
                waiting = null,
                owner = pixel,
                changedAt = 1792756860000,
            ),
            PhoneSession(
                id = "s-3",
                name = "Grill follow-ups",
                project = "switchboard",
                projectPath = SWITCHBOARD_PATH,
                remote = null,
                state = SessionState.Idle,
                waiting = null,
                owner = TerminalOwner.Mac,
                changedAt = 1792756920000,
            ),
        ),
    ),
    "session-rekeyed" to ServerMessage.SessionRekeyed(from = "s-1", to = "s-9"),
    "attached" to ServerMessage.Attached(sessionId = "s-1", owner = pixel),
    "owner" to ServerMessage.Owner(sessionId = "s-1", owner = TerminalOwner.Mac),
    "exited" to ServerMessage.Exited(sessionId = "s-1", exitCode = 0),
    "questions" to ServerMessage.Questions(
        pending = listOf(
            PendingQuestions(
                sessionId = "s-1",
                toolUseId = "toolu_01",
                source = QuestionsSource.Ask,
                questions = listOf(
                    Question(
                        question = "Which transport?",
                        header = "Transport",
                        options = listOf(
                            QuestionOption(label = "WebSocket (Recommended)", description = "One socket per phone", preview = "ws://"),
                            QuestionOption(label = "HTTP polling", description = "", preview = null),
                        ),
                        multiSelect = false,
                        detail = null,
                    ),
                ),
                askedAt = 1792756800000,
                deadline = 1792757400000,
            ),
            PendingQuestions(
                sessionId = "s-2",
                toolUseId = "grill-3",
                source = QuestionsSource.Grill,
                questions = listOf(
                    Question(
                        question = "Which screens first?",
                        header = "",
                        options = listOf(
                            QuestionOption(label = "Sessions", description = "The list", preview = null),
                            QuestionOption(label = "Terminal", description = "One session", preview = null),
                        ),
                        multiSelect = true,
                        detail = "The rest can wait.",
                    ),
                ),
                askedAt = 1792756900000,
                deadline = null,
            ),
        ),
    ),
    "questions-settled" to ServerMessage.QuestionsSettled(
        sessionId = "s-1",
        toolUseId = "toolu_01",
        outcome = QuestionsOutcome.Answered,
        answeredOn = AnsweredOn.Phone,
    ),
    "questions-settled-withdrawn" to ServerMessage.QuestionsSettled(
        sessionId = "s-1",
        toolUseId = "toolu_01",
        outcome = QuestionsOutcome.Withdrawn,
        answeredOn = null,
    ),
    "answer-result" to ServerMessage.AnswerResult(sessionId = "s-1", toolUseId = "toolu_01", ok = true, error = null),
    "answer-result-error" to ServerMessage.AnswerResult(
        sessionId = "s-1",
        toolUseId = "toolu_01",
        ok = false,
        error = "The questions were already answered",
    ),
    "archive-result" to ServerMessage.ArchiveResult(sessionId = "s-1", ok = true, error = null),
    "archive-result-error" to ServerMessage.ArchiveResult(sessionId = "s-1", ok = false, error = "Could not stop the session"),
    "ask-result-confident" to ServerMessage.AskResult(
        requestId = "r-1",
        result = PhoneAskResult.Confident(sessionId = "s-4", project = "switchboard"),
    ),
    "ask-result-unsure" to ServerMessage.AskResult(
        requestId = "r-1",
        result = PhoneAskResult.Unsure(
            candidates = listOf(
                AskCandidate(path = SWITCHBOARD_PATH, folder = "switchboard", recentTitle = "Release notes for v2.8.1"),
                AskCandidate(path = "/Users/joris/Development/james", folder = "james", recentTitle = null),
            ),
            prompt = "Bump the release notes",
        ),
    ),
    "ask-result-no-match" to ServerMessage.AskResult(
        requestId = "r-1",
        result = PhoneAskResult.NoMatch(reason = "None of your projects mention release notes."),
    ),
    "ask-result-failed" to ServerMessage.AskResult(
        requestId = "r-1",
        result = PhoneAskResult.Failed(reason = "Claude is not signed in."),
    ),
    "ask-result-cancelled" to ServerMessage.AskResult(requestId = "r-1", result = PhoneAskResult.Cancelled),
    "ask-started" to ServerMessage.AskStarted(requestId = "r-1", sessionId = "s-4"),
    "ask-error" to ServerMessage.AskError(requestId = "r-1", error = "Another request is still running."),
    "projects" to ServerMessage.Projects(
        projects = listOf(
            PhoneProject(path = SWITCHBOARD_PATH, folder = "switchboard", running = 2),
            PhoneProject(path = "/Users/joris/Development/james", folder = "james", running = 0),
        ),
    ),
    "revoked" to ServerMessage.Revoked,
)
