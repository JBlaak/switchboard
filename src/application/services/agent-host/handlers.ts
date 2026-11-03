/**
 * The agent's parts, as the router on the agent sees them (#276).
 *
 * The router (`agent-host.ts`) does the handshake and hands every later
 * message to the one part that owns its type. Each part may talk back to the
 * client it was handed, and is told when a client comes and goes so it can
 * stop sending to it, or (the hook forwarder) release what that client held.
 */
import type {ClientLink} from '../../ports/agent-link';
import type {
    ArchiveReplyMessage,
    AskReplyMessage,
    AttachMessage,
    CheckToolsMessage,
    CopyConfigMessage,
    GetHostSettingsMessage,
    HostSettings,
    InputMessage,
    ListSessionsMessage,
    OpenSessionMessage,
    ResizeMessage,
    SetHostSettingsMessage,
    SignalMessage,
} from '../../../domain/agent/protocol';
import type {SessionTools} from '../../../domain/launch/claude-command';

interface ClientAware {
    /** A client finished its handshake. */
    clientConnected(client: ClientLink): void;
    /** A client's link closed. */
    clientGone(client: ClientLink): void;
}

export type SessionHostMessage =
    OpenSessionMessage | AttachMessage | InputMessage | ResizeMessage | SignalMessage | ListSessionsMessage;

/** The agent's sessions: their PTYs, commands and scrollback. */
export interface SessionHostPart extends ClientAware {
    handle(client: ClientLink, message: SessionHostMessage): void;
    /** Stop every session, for an orderly shutdown. */
    terminateAll(): void;
}

export type HookForwarderMessage = AskReplyMessage | ArchiveReplyMessage;

/**
 * The agent's question hook and archive tool, forwarding to the Mac.
 *
 * It is also what a launch asks for the hook settings and MCP tools of a
 * session, pointed at the agent's own hook server on 127.0.0.1.
 */
export interface HookForwarderPart extends ClientAware {
    handle(client: ClientLink, message: HookForwarderMessage): void;
    /** The `--settings` JSON installing the hooks for `launchId`; null while the server is not listening. */
    settingsFor(launchId: string): string | null;
    /** The archive tool's MCP config for `launchId`; null while the server is not listening. */
    toolsFor(launchId: string): SessionTools | null;
}

export type HostConfigMessage = GetHostSettingsMessage | SetHostSettingsMessage | CheckToolsMessage | CopyConfigMessage;

/** The host's settings, its tool checks and the config copy's writer. */
export interface HostConfigPart extends ClientAware {
    handle(client: ClientLink, message: HostConfigMessage): void;
    /** The settings now, as a launch reads them. */
    current(): HostSettings;
}
