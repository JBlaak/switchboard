/**
 * Cutting the agent link's byte stream into frames, and back.
 *
 * ssh carries a plain byte stream, so each frame says how long it is: a 4-byte
 * big-endian length, then that many bytes of body. The body's first byte says
 * what it is.
 *
 * - `0` then UTF-8 JSON: one message from `protocol.ts`.
 * - `1` then terminal output: a 1-byte session id length, the session id
 *   (ASCII), the 4-byte big-endian sequence number, then the data as UTF-8.
 *
 * Output gets a binary frame of its own because it is nearly all of the
 * traffic, and wrapping every chunk in JSON would escape most of it twice.
 */
import type {TerminalOutput} from './protocol';

/** A body larger than this is not from a well-behaved peer; the link is closed. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const KIND_MESSAGE = 0;
const KIND_OUTPUT = 1;

/** One decoded frame. A message is left as parsed JSON; checking its shape is the reader's job. */
export type Frame = {kind: 'message'; message: unknown} | {kind: 'output'; output: TerminalOutput};

/** One message as a frame. */
export function encodeMessageFrame(message: object): Buffer {
    const json = Buffer.from(JSON.stringify(message), 'utf8');
    const body = Buffer.allocUnsafe(1 + json.length);
    body[0] = KIND_MESSAGE;
    json.copy(body, 1);
    return withLength(body);
}

/** One chunk of output as a frame. */
export function encodeOutputFrame(output: TerminalOutput): Buffer {
    const id = Buffer.from(output.sessionId, 'ascii');
    if (id.length === 0 || id.length > 255) throw new Error(`session id must be 1–255 bytes: ${output.sessionId}`);
    const data = Buffer.from(output.data, 'utf8');
    const body = Buffer.allocUnsafe(1 + 1 + id.length + 4 + data.length);
    let at = 0;
    body[at++] = KIND_OUTPUT;
    body[at++] = id.length;
    id.copy(body, at);
    at += id.length;
    body.writeUInt32BE(output.seq >>> 0, at);
    at += 4;
    data.copy(body, at);
    return withLength(body);
}

function withLength(body: Buffer): Buffer {
    if (body.length > MAX_FRAME_BYTES) throw new Error(`frame too large: ${body.length} bytes`);
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(body.length, 0);
    return Buffer.concat([header, body]);
}

/**
 * Reassembles frames from chunks that may split or join them anywhere.
 *
 * `push` returns the frames completed by that chunk. It throws on a frame it
 * cannot read (too large, unknown kind, bad JSON); the link is then beyond
 * repair and the caller closes it with `protocolError`.
 */
export class FrameDecoder {
    private buffer: Buffer = Buffer.alloc(0);

    public push(chunk: Buffer): Frame[] {
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        const frames: Frame[] = [];
        while (this.buffer.length >= 4) {
            const length = this.buffer.readUInt32BE(0);
            if (length > MAX_FRAME_BYTES) throw new Error(`frame too large: ${length} bytes`);
            if (length === 0) throw new Error('empty frame');
            if (this.buffer.length < 4 + length) break;
            const body = this.buffer.subarray(4, 4 + length);
            this.buffer = this.buffer.subarray(4 + length);
            frames.push(decodeBody(body));
        }
        return frames;
    }
}

function decodeBody(body: Buffer): Frame {
    const kind = body[0];
    if (kind === KIND_MESSAGE) {
        return {kind: 'message', message: JSON.parse(body.subarray(1).toString('utf8')) as unknown};
    }
    if (kind === KIND_OUTPUT) {
        const idLength = body[1];
        if (body.length < 2 + idLength + 4) throw new Error('truncated output frame');
        const sessionId = body.subarray(2, 2 + idLength).toString('ascii');
        const seq = body.readUInt32BE(2 + idLength);
        const data = body.subarray(2 + idLength + 4).toString('utf8');
        return {kind: 'output', output: {sessionId, seq, data}};
    }
    throw new Error(`unknown frame kind: ${kind}`);
}
