/**
 * A QR code encoder, for the Phone access pairing code (#194).
 *
 * Only what the pairing invite needs: byte mode (the text as UTF-8), error
 * correction level M, the smallest version that holds the text, and the mask
 * the standard's penalty rules pick. That is a few hundred lines rather than
 * a dependency, and it is plain rules with nothing to fake, so it lives here.
 *
 * The steps follow ISO/IEC 18004 in order: the data bits, the Reed-Solomon
 * error correction per block, the blocks interleaved, the function patterns,
 * the codewords laid out in the zigzag, then the mask and the format bits.
 */

export interface QrCode {
  /** 1–40. */
  readonly version: number;
  /** Modules per side: 17 + 4 × version. */
  readonly size: number;
  /** 0–7, the mask that was applied. */
  readonly mask: number;
  /** `modules[y][x]`, true for a dark module. No quiet zone. */
  readonly modules: readonly (readonly boolean[])[];
}

/** Error correction codewords per block, level M, by version (index 0 unused). */
const ECC_PER_BLOCK = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];

/** Error correction blocks, level M, by version (index 0 unused). */
const BLOCKS = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
  17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];

/** Level M's two format bits. */
const ECL_M = 0b00;

/** Encode `text` as a QR code. Throws when it is too long for version 40. */
export function encodeQr(text: string): QrCode {
  const bytes = new TextEncoder().encode(text);
  const version = smallestVersion(bytes.length);
  const codewords = addErrorCorrection(dataCodewords(bytes, version), version);

  const size = version * 4 + 17;
  const grid = new Grid(size);
  drawFunctionPatterns(grid, version);
  drawCodewords(grid, codewords);

  let best = -1;
  let bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    applyMask(grid, mask);
    drawFormatBits(grid, mask);
    const score = penalty(grid.modules);
    if (score < bestPenalty) {
      best = mask;
      bestPenalty = score;
    }
    applyMask(grid, mask); // XOR again undoes it
  }
  applyMask(grid, best);
  drawFormatBits(grid, best);

  return { version, size, mask: best, modules: grid.modules };
}

// ── Capacity ──

/** Modules left for data and error correction once the function patterns are drawn. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    result -= (25 * align - 10) * align - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCapacity(version: number): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[version] * BLOCKS[version];
}

/** The byte-mode character count is 8 bits up to version 9, 16 after. */
function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

function smallestVersion(length: number): number {
  for (let version = 1; version <= 40; version++) {
    const bits = 4 + countBits(version) + length * 8;
    if (bits <= dataCapacity(version) * 8) return version;
  }
  throw new RangeError(`${length} bytes do not fit in a QR code at level M`);
}

// ── The data ──

function dataCodewords(bytes: Uint8Array, version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, countBits(version));
  for (const b of bytes) push(b, 8);

  const capacityBits = dataCapacity(version) * 8;
  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  push(0, (8 - (bits.length % 8)) % 8);

  const result: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    result.push(byte);
  }
  for (let pad = 0xec; result.length < capacityBits / 8; pad ^= 0xec ^ 0x11) result.push(pad);
  return result;
}

/**
 * Split the data into blocks, append each block's error correction, and
 * interleave them: the first codeword of every block, then the second, and so on.
 * The later blocks are one data codeword longer than the earlier ones.
 */
function addErrorCorrection(data: readonly number[], version: number): number[] {
  const blockCount = BLOCKS[version];
  const eccLength = ECC_PER_BLOCK[version];
  const raw = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (raw % blockCount);
  const shortLength = Math.floor(raw / blockCount);

  const divisor = reedSolomonDivisor(eccLength);
  const blocks: number[][] = [];
  for (let i = 0, k = 0; i < blockCount; i++) {
    const length = shortLength - eccLength + (i < shortBlocks ? 0 : 1);
    const chunk = data.slice(k, k + length);
    k += length;
    const ecc = reedSolomonRemainder(chunk, divisor);
    // A placeholder keeps a short block's error correction in step with the long ones'.
    if (i < shortBlocks) chunk.push(0);
    blocks.push([...chunk, ...ecc]);
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      if (i !== shortLength - eccLength || j >= shortBlocks) result.push(block[i]);
    });
  }
  return result;
}

// ── Reed-Solomon over GF(2⁸), modulo x⁸ + x⁴ + x³ + x² + 1 ──

/** The generator polynomial of degree `degree`, highest term first and the leading 1 left out. */
export function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

/** The error correction codewords for `data`. */
export function reedSolomonRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coefficient, i) => { result[i] ^= gfMultiply(coefficient, factor); });
  }
  return result;
}

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

// ── The grid ──

class Grid {
  readonly modules: boolean[][];
  /** The modules the mask leaves alone: finders, timing, alignment, format and version. */
  readonly reserved: boolean[][];

  constructor(readonly size: number) {
    this.modules = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    this.reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  }

  fixed(x: number, y: number, dark: boolean): void {
    this.modules[y][x] = dark;
    this.reserved[y][x] = true;
  }
}

function drawFunctionPatterns(grid: Grid, version: number): void {
  const { size } = grid;
  for (let i = 0; i < size; i++) {
    grid.fixed(6, i, i % 2 === 0);
    grid.fixed(i, 6, i % 2 === 0);
  }

  drawFinder(grid, 3, 3);
  drawFinder(grid, size - 4, 3);
  drawFinder(grid, 3, size - 4);

  const positions = alignmentPositions(version, size);
  const last = positions.length - 1;
  positions.forEach((x, i) => positions.forEach((y, j) => {
    // Not where a finder already sits.
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    drawAlignment(grid, x, y);
  }));

  drawFormatBits(grid, 0); // reserved now, written for real once the mask is known
  drawVersion(grid, version);
}

/** A finder pattern and its light separator, centred on (x, y). */
function drawFinder(grid: Grid, x: number, y: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx < 0 || xx >= grid.size || yy < 0 || yy >= grid.size) continue;
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      grid.fixed(xx, yy, distance !== 2 && distance !== 4);
    }
  }
}

function drawAlignment(grid: Grid, x: number, y: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      grid.fixed(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

/** The centres' coordinates along each axis, ascending. */
export function alignmentPositions(version: number, size = version * 4 + 17): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const result = [6];
  for (let position = size - 7; result.length < count; position -= step) result.splice(1, 0, position);
  return result;
}

/** The 15 format bits: level M and the mask, with their BCH code, XORed with 0x5412. */
export function formatBits(mask: number): number {
  const data = (ECL_M << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i++) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((data << 10) | remainder) ^ 0x5412;
}

function drawFormatBits(grid: Grid, mask: number): void {
  const bits = formatBits(mask);
  const bit = (i: number): boolean => ((bits >>> i) & 1) !== 0;
  const { size } = grid;

  // Around the top-left finder.
  for (let i = 0; i <= 5; i++) grid.fixed(8, i, bit(i));
  grid.fixed(8, 7, bit(6));
  grid.fixed(8, 8, bit(7));
  grid.fixed(7, 8, bit(8));
  for (let i = 9; i < 15; i++) grid.fixed(14 - i, 8, bit(i));

  // Split between the other two finders.
  for (let i = 0; i < 8; i++) grid.fixed(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) grid.fixed(8, size - 15 + i, bit(i));
  grid.fixed(8, size - 8, true); // always dark
}

/** The 18 version bits, from version 7 on: the version and its BCH code. */
export function versionBits(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i++) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  return (version << 12) | remainder;
}

function drawVersion(grid: Grid, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    const a = grid.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    grid.fixed(a, b, dark);
    grid.fixed(b, a, dark);
  }
}

/** Two columns at a time from the right, up then down, skipping the vertical timing line. */
function drawCodewords(grid: Grid, codewords: readonly number[]): void {
  const { size } = grid;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let step = 0; step < size; step++) {
      const y = upward ? size - 1 - step : step;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (grid.reserved[y][x] || i >= codewords.length * 8) continue;
        grid.modules[y][x] = ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) !== 0;
        i++;
      }
    }
  }
}

const MASKS: ((x: number, y: number) => boolean)[] = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(grid: Grid, mask: number): void {
  const flip = MASKS[mask];
  for (let y = 0; y < grid.size; y++) {
    for (let x = 0; x < grid.size; x++) {
      if (!grid.reserved[y][x] && flip(x, y)) grid.modules[y][x] = !grid.modules[y][x];
    }
  }
}

// ── The mask's penalty (ISO/IEC 18004 §8.8.2) ──

/** The finder-like run 1:1:3:1:1 with four light modules on one side. */
const FINDER_LIKE = [
  [true, false, true, true, true, false, true, false, false, false, false],
  [false, false, false, false, true, false, true, true, true, false, true],
];

export function penalty(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  const at = (x: number, y: number, transpose: boolean): boolean => (transpose ? modules[x][y] : modules[y][x]);
  let result = 0;

  for (const transpose of [false, true]) {
    for (let y = 0; y < size; y++) {
      // Runs of five or more of one colour.
      let run = 1;
      for (let x = 1; x <= size; x++) {
        if (x < size && at(x, y, transpose) === at(x - 1, y, transpose)) {
          run++;
          continue;
        }
        if (run >= 5) result += 3 + (run - 5);
        run = 1;
      }
      // Patterns that look like a finder.
      for (let x = 0; x + 11 <= size; x++) {
        for (const pattern of FINDER_LIKE) {
          if (pattern.every((dark, k) => at(x + k, y, transpose) === dark)) result += 40;
        }
      }
    }
  }

  // 2×2 blocks of one colour.
  for (let y = 0; y + 1 < size; y++) {
    for (let x = 0; x + 1 < size; x++) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3;
    }
  }

  // How far the share of dark modules is from half, in steps of 5%.
  let dark = 0;
  for (const row of modules) for (const m of row) if (m) dark++;
  const total = size * size;
  result += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;

  return result;
}
