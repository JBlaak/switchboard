package dev.jblaak.switchboard.protocol

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** Phone to Mac: one JSON text frame each, discriminated by `type`. */
@Serializable
sealed interface ClientMessage {

    /** First message on every connection. */
    @Serializable
    @SerialName("hello")
    data class Hello(val protocol: Int, val appVersion: String) : ClientMessage

    /** Only on a pairing connection. */
    @Serializable
    @SerialName("pair")
    data class Pair(val code: String, val deviceName: String) : ClientMessage

    /** Start streaming a session: replay, then live output, at this device's size. */
    @Serializable
    @SerialName("attach")
    data class Attach(val sessionId: String, val cols: Int, val rows: Int) : ClientMessage

    @Serializable
    @SerialName("detach")
    data class Detach(val sessionId: String) : ClientMessage

    /** This device's terminal size changed; applied only while it owns the session. */
    @Serializable
    @SerialName("size")
    data class Size(val sessionId: String, val cols: Int, val rows: Int) : ClientMessage

    /** Make this device the active one for the session. */
    @Serializable
    @SerialName("use-here")
    data class UseHere(val sessionId: String) : ClientMessage

    /** Bytes for the PTY; dropped unless this device owns the session. */
    @Serializable
    @SerialName("input")
    data class Input(val sessionId: String, val data: String) : ClientMessage

    /** Answering also makes this device the active one. */
    @Serializable
    @SerialName("answer")
    data class Answer(val sessionId: String, val toolUseId: String, val answers: Answers) : ClientMessage

    /**
     * Ask Patch: route [text] to a project. One request per device at a time. [cols] and [rows] are this
     * phone's terminal size, so a session it starts opens at that size; left out when unknown.
     */
    @Serializable
    @SerialName("ask")
    data class Ask(
        val requestId: String,
        val text: String,
        val cols: Int? = null,
        val rows: Int? = null,
    ) : ClientMessage

    @Serializable
    @SerialName("ask-cancel")
    data class AskCancel(val requestId: String) : ClientMessage

    /**
     * Start the session in a picked project; [prompt] is Patch's (unsure) or the typed text (no match). [cols]
     * and [rows] are as on [Ask].
     */
    @Serializable
    @SerialName("ask-start")
    data class AskStart(
        val requestId: String,
        val projectPath: String,
        val prompt: String,
        val cols: Int? = null,
        val rows: Int? = null,
    ) : ClientMessage

    @Serializable
    @SerialName("list-projects")
    data object ListProjects : ClientMessage
}
