/**
 * Which device a session's terminal belongs to (#194).
 *
 * A PTY has one size, and Claude's TUI drawn at a phone's 40 columns is
 * unreadable on the Mac and the other way round. So each running session has
 * exactly one active device, the PTY is sized to it, and every other device
 * shows "Active on other device" with Use here instead of a mangled terminal.
 *
 * The rule that matters most is what does *not* move ownership. Focus,
 * selection, opening a session, attaching from the phone, a size report and a
 * disconnect all leave it where it is, because each of those happens by
 * accident or in passing and a session must never resize behind the user's
 * back. Ownership moves on Use here, on an answer (the user is evidently
 * looking at that device), and on a session started from a phone. A phone
 * that drops off the Wi-Fi keeps its sessions until Use here on the Mac.
 *
 * The state is immutable: `applyOwnership` returns the next one plus what the
 * PTY should do, and the service holds it the way it holds any other value.
 */

/** 'mac', or an enrolled device's id. Device ids are registry UUIDs and never 'mac'. */
export type Device = string;

export const MAC: Device = 'mac';

export interface TerminalSize {
  cols: number;
  rows: number;
}

interface SessionTerminal {
  owner: Device;
  /** The last size each device reported for this session. */
  sizes: Record<Device, TerminalSize>;
  /** The size the PTY was last told to take by these rules; null before the first. */
  pty: TerminalSize | null;
}

export interface OwnershipState {
  /** Only sessions something happened to; any other running session belongs to the Mac. */
  sessions: Record<string, SessionTerminal>;
  /**
   * Each device's most recent size for any session. A session started from a
   * phone needs a size before that session exists to report one for.
   */
  lastSizes: Record<Device, TerminalSize>;
}

export const NO_OWNERSHIP: OwnershipState = { sessions: {}, lastSizes: {} };

export type OwnershipEvent =
  /** A device's terminal size for a session: the Mac's fit, a phone's `size` or `attach`. */
  | { type: 'size'; sessionId: string; device: Device; size: TerminalSize }
  /** Use here. */
  | { type: 'use-here'; sessionId: string; device: Device }
  /** A question answered from a device; the first answer only, the service drops the rest. */
  | { type: 'answered'; sessionId: string; device: Device }
  /** A session launched from a device (Ask Patch on the phone); its PTY starts at that device's size. */
  | { type: 'started'; sessionId: string; device: Device; size?: TerminalSize }
  /** The device's connection closed. Nothing moves; recorded so the call site reads as the rule. */
  | { type: 'device-left'; device: Device }
  /**
   * The device was revoked, or every device was by Reset. It can never press
   * Use here again, so its sessions go back to the Mac rather than showing a
   * placeholder that names a phone that no longer exists.
   */
  | { type: 'device-removed'; device: Device }
  /** A fork or plan accept gave the session a new id. */
  | { type: 'rekeyed'; from: string; to: string }
  | { type: 'ended'; sessionId: string };

export interface OwnershipChange {
  state: OwnershipState;
  /** Sessions whose owner changed, for the `owner` push to every device. */
  ownerChanged: string[];
  /**
   * Sizes the PTYs should take now, by session; absent means leave that PTY
   * alone. After a move this is set whenever the new owner's size is known,
   * even if it equals the PTY's, so the caller can nudge the TUI to repaint
   * for the device that just took over.
   */
  resize: Record<string, TerminalSize>;
}

/** What a device shows for a session. */
export type TerminalView = 'terminal' | 'elsewhere';

export function ownerOf(state: OwnershipState, sessionId: string): Device {
  return state.sessions[sessionId]?.owner ?? MAC;
}

/** Prompt-box text, key bar keys and the Mac's typing: only from the device the terminal is sized for. */
export function acceptsInput(state: OwnershipState, sessionId: string, device: Device): boolean {
  return ownerOf(state, sessionId) === device;
}

export function viewFor(state: OwnershipState, sessionId: string, device: Device): TerminalView {
  return ownerOf(state, sessionId) === device ? 'terminal' : 'elsewhere';
}

/** The size a device last reported for any session; what a session started from it is spawned at. */
export function lastSizeOf(state: OwnershipState, device: Device): TerminalSize | null {
  return state.lastSizes[device] ?? null;
}

export function applyOwnership(state: OwnershipState, event: OwnershipEvent): OwnershipChange {
  switch (event.type) {
    case 'size': {
      const current = session(state, event.sessionId);
      const sizes = { ...current.sizes, [event.device]: event.size };
      const lastSizes = { ...state.lastSizes, [event.device]: event.size };
      // A size from a device that isn't active is remembered for when it
      // takes over, and otherwise ignored.
      const applies = current.owner === event.device && !sameSize(current.pty, event.size);
      const next: SessionTerminal = { ...current, sizes, pty: applies ? event.size : current.pty };
      return {
        state: { sessions: { ...state.sessions, [event.sessionId]: next }, lastSizes },
        ownerChanged: [],
        resize: applies ? { [event.sessionId]: event.size } : {},
      };
    }

    case 'use-here':
    case 'answered':
      return moveTo(state, event.sessionId, event.device, null);

    case 'started': {
      const size = event.size ?? lastSizeOf(state, event.device);
      const lastSizes = event.size ? { ...state.lastSizes, [event.device]: event.size } : state.lastSizes;
      return moveTo({ ...state, lastSizes }, event.sessionId, event.device, size);
    }

    case 'device-left':
      return unchanged(state);

    case 'device-removed': {
      const sessions: Record<string, SessionTerminal> = {};
      const ownerChanged: string[] = [];
      const resize: Record<string, TerminalSize> = {};
      for (const [id, terminal] of Object.entries(state.sessions)) {
        const sizes = { ...terminal.sizes };
        delete sizes[event.device];
        if (terminal.owner !== event.device) {
          sessions[id] = { ...terminal, sizes };
          continue;
        }
        const macSize = terminal.sizes[MAC] ?? null;
        sessions[id] = { owner: MAC, sizes, pty: macSize ?? terminal.pty };
        ownerChanged.push(id);
        if (macSize) resize[id] = macSize;
      }
      const lastSizes = { ...state.lastSizes };
      delete lastSizes[event.device];
      return { state: { sessions, lastSizes }, ownerChanged, resize };
    }

    case 'rekeyed': {
      const terminal = state.sessions[event.from];
      if (!terminal || event.from === event.to) return unchanged(state);
      const sessions = { ...state.sessions, [event.to]: terminal };
      delete sessions[event.from];
      return unchanged({ ...state, sessions });
    }

    case 'ended': {
      if (!state.sessions[event.sessionId]) return unchanged(state);
      const sessions = { ...state.sessions };
      delete sessions[event.sessionId];
      return unchanged({ ...state, sessions });
    }
  }
}

/**
 * Make `device` the owner. `spawnSize` is for a new session, whose PTY takes
 * the starting device's size even though it never reported one for it. Moving
 * to the device that already owns the session changes nothing.
 */
function moveTo(state: OwnershipState, sessionId: string, device: Device, spawnSize: TerminalSize | null): OwnershipChange {
  const current = session(state, sessionId);
  if (current.owner === device && !spawnSize) return unchanged(state);

  const sizes = spawnSize ? { ...current.sizes, [device]: spawnSize } : current.sizes;
  const size = sizes[device] ?? null;
  const next: SessionTerminal = { owner: device, sizes, pty: size ?? current.pty };
  return {
    state: { ...state, sessions: { ...state.sessions, [sessionId]: next } },
    ownerChanged: current.owner === device ? [] : [sessionId],
    resize: size ? { [sessionId]: size } : {},
  };
}

function session(state: OwnershipState, sessionId: string): SessionTerminal {
  return state.sessions[sessionId] ?? { owner: MAC, sizes: {}, pty: null };
}

function unchanged(state: OwnershipState): OwnershipChange {
  return { state, ownerChanged: [], resize: {} };
}

function sameSize(a: TerminalSize | null, b: TerminalSize): boolean {
  return a !== null && a.cols === b.cols && a.rows === b.rows;
}
