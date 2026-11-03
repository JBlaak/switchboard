/**
 * A minimal ustar writer, for the agent bundle the installer uploads (#276).
 *
 * The bundle is a dozen small files, and writing the archive here rather than
 * running the Mac's `tar` keeps it free of what bsdtar adds on macOS:
 * AppleDouble `._` files and `LIBARCHIVE.xattr` headers that GNU tar on the VM
 * warns about. It's also the same bytes on every machine that builds it, and
 * needs no dependency. Plain ustar (no compression) so the VM needs only `tar`
 * to unpack it; the bundle is small enough that gzip would buy little.
 */

/** One archive member. Folders are created by `tar` as needed, so only files are listed. */
export interface TarFile {
    /** Relative, `/`-separated, without `..`. */
    path: string;
    data: Uint8Array;
    /** Permission bits, e.g. 0o644. */
    mode: number;
    /** Modification time, epoch seconds. */
    mtime: number;
}

const BLOCK = 512;

/** The archive's bytes: one header and the padded data per file, then two zero blocks. */
export function tarArchive(files: readonly TarFile[]): Uint8Array {
    const parts: Uint8Array[] = [];
    let size = 0;
    for (const file of files) {
        const header = tarHeader(file);
        const padded = new Uint8Array(Math.ceil(file.data.length / BLOCK) * BLOCK);
        padded.set(file.data);
        parts.push(header, padded);
        size += header.length + padded.length;
    }
    const out = new Uint8Array(size + 2 * BLOCK);
    let offset = 0;
    for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
    }
    return out;
}

function tarHeader(file: TarFile): Uint8Array {
    if (file.path.startsWith('/') || file.path.split('/').includes('..')) {
        throw new Error(`Not a relative path: ${file.path}`);
    }
    const {name, prefix} = splitName(file.path);
    const h = new Uint8Array(BLOCK);
    writeString(h, 0, 100, name);
    writeOctal(h, 100, 8, file.mode & 0o7777);
    writeOctal(h, 108, 8, 0); // uid: the VM user owns whatever they unpack
    writeOctal(h, 116, 8, 0); // gid
    writeOctal(h, 124, 12, file.data.length);
    writeOctal(h, 136, 12, Math.max(0, Math.floor(file.mtime)));
    h.fill(0x20, 148, 156); // the checksum is computed with its own field as spaces
    h[156] = 0x30; // '0': a regular file
    writeString(h, 257, 6, 'ustar');
    writeString(h, 263, 2, '00');
    writeString(h, 345, 155, prefix);
    let sum = 0;
    for (const byte of h) sum += byte;
    writeString(h, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
    return h;
}

/** ustar keeps up to 100 bytes of name and 155 of prefix, split at a `/`. */
function splitName(path: string): {name: string; prefix: string} {
    if (byteLength(path) <= 100) return {name: path, prefix: ''};
    for (let i = path.indexOf('/'); i >= 0; i = path.indexOf('/', i + 1)) {
        const prefix = path.slice(0, i);
        const name = path.slice(i + 1);
        if (byteLength(prefix) <= 155 && byteLength(name) <= 100) return {name, prefix};
    }
    throw new Error(`Path too long for a tar header: ${path}`);
}

function byteLength(s: string): number {
    return new TextEncoder().encode(s).length;
}

function writeString(h: Uint8Array, offset: number, length: number, value: string): void {
    const bytes = new TextEncoder().encode(value);
    if (bytes.length > length) throw new Error(`Too long for a tar header field: ${value}`);
    h.set(bytes, offset);
}

/** An octal number, zero-padded, ending in a NUL, as ustar's numeric fields are. */
function writeOctal(h: Uint8Array, offset: number, length: number, value: number): void {
    const digits = value.toString(8);
    if (digits.length > length - 1) throw new Error(`Too large for a tar header field: ${value}`);
    writeString(h, offset, length, digits.padStart(length - 1, '0') + '\0');
}
