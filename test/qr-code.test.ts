import { test } from 'node:test';
import assert from 'node:assert';
import {
  alignmentPositions, encodeQr, formatBits, reedSolomonDivisor, reedSolomonRemainder, versionBits,
} from '../src/domain/qr/qr-code';

const draw = (modules: readonly (readonly boolean[])[]): string[] =>
  modules.map(row => row.map(dark => (dark ? '#' : '.')).join(''));

test('a short text encodes to the version 1 code a reference encoder draws for it', () => {
  // Drawn by the `qrcode` npm package at level M, which picks the same mask.
  /* Given */
  const expected = [
    '#######..##.#.#######',
    '#.....#..##...#.....#',
    '#.###.#.###...#.###.#',
    '#.###.#.#.#.#.#.###.#',
    '#.###.#.#.#.#.#.###.#',
    '#.....#.#.##..#.....#',
    '#######.#.#.#.#######',
    '........###..........',
    '#.#####...##..#####..',
    '#.#.#..#..###########',
    '.#.#.######.###..#.#.',
    '.#.###...#####.######',
    '##..#.#.#...#.##.....',
    '........#...#..##..##',
    '#######..###.#...###.',
    '#.....#.###..#.#.####',
    '#.###.#.#..#.#####..#',
    '#.###.#.#.#.#..####..',
    '#.###.#.##..#.#...#..',
    '#.....#..#..##..###..',
    '#######.#####.##...#.',
  ];

  /* When */
  const qr = encodeQr('switchboard');

  /* Then */
  assert.strictEqual(qr.version, 1);
  assert.strictEqual(qr.mask, 2);
  assert.deepStrictEqual(draw(qr.modules), expected);
});

test('the version grows with the text: a pairing invite fits a version the phone scans easily', () => {
  /* Given */
  const invite = 'switchboard://pair?v=1&fp=' + 'AB:'.repeat(31) + 'AB&code=' + 'k'.repeat(22) + '&host=joris-mbp.local&port=48231';

  /* When */
  const sizes = ['', 'a'.repeat(14), 'a'.repeat(15), invite].map(text => encodeQr(text));

  /* Then */
  // Version 1 at level M holds 14 bytes; the 15th needs version 2.
  assert.deepStrictEqual(sizes.slice(0, 3).map(q => q.version), [1, 1, 2]);
  assert.ok(sizes[3].version <= 10, `invite needed version ${sizes[3].version}`);
  for (const qr of sizes) {
    assert.strictEqual(qr.size, qr.version * 4 + 17);
    assert.strictEqual(qr.modules.length, qr.size);
    assert.ok(qr.modules.every(row => row.length === qr.size));
  }
});

test('every code has its three finders, its timing lines and the dark module', () => {
  /* Given */
  const finder = ['#######', '#.....#', '#.###.#', '#.###.#', '#.###.#', '#.....#', '#######'];

  for (const text of ['hi', 'x'.repeat(150), 'x'.repeat(400)]) {
    /* When */
    const { modules, size } = encodeQr(text);
    const rows = draw(modules);
    const square = (x: number, y: number) => rows.slice(y, y + 7).map(r => r.slice(x, x + 7));

    /* Then */
    assert.deepStrictEqual(square(0, 0), finder);
    assert.deepStrictEqual(square(size - 7, 0), finder);
    assert.deepStrictEqual(square(0, size - 7), finder);
    for (let i = 8; i < size - 8; i++) {
      assert.strictEqual(modules[6][i], i % 2 === 0);
      assert.strictEqual(modules[i][6], i % 2 === 0);
    }
    assert.strictEqual(modules[size - 8][8], true);
  }
});

test('text beyond ASCII is encoded as its UTF-8 bytes', () => {
  /* When */
  const accented = encodeQr('é'.repeat(7)); // 14 bytes: still version 1
  const more = encodeQr('é'.repeat(8)); // 16 bytes: version 2

  /* Then */
  assert.strictEqual(accented.version, 1);
  assert.strictEqual(more.version, 2);
});

test('a text too long for version 40 is refused', () => {
  /* When */
  const tooLong = () => encodeQr('x'.repeat(2400));

  /* Then */
  assert.throws(tooLong, RangeError);
});

test('Reed-Solomon gives the error correction of the standard\'s worked example', () => {
  // "HELLO WORLD" at 1-M, from the standard's annex: 16 data codewords, 10 for correction.
  /* Given */
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];

  /* When */
  const ecc = reedSolomonRemainder(data, reedSolomonDivisor(10));

  /* Then */
  assert.deepStrictEqual(ecc, [196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test('format and version bits match the standard\'s tables', () => {
  /* When */
  const format = [0, 1, 2, 3, 4, 5, 6, 7].map(formatBits);

  /* Then */
  // Level M, masks 0–7.
  assert.deepStrictEqual(format.map(b => b.toString(2).padStart(15, '0')), [
    '101010000010010', '101000100100101', '101111001111100', '101101101001011',
    '100010111111001', '100000011001110', '100111110010111', '100101010100000',
  ]);
  assert.strictEqual(versionBits(7), 0x07c94);
  assert.strictEqual(versionBits(40), 0x28c69);
});

test('alignment patterns sit where the standard\'s table puts them', () => {
  /* When */
  const positions = [1, 2, 6, 7, 14, 32, 40].map(v => alignmentPositions(v));

  /* Then */
  assert.deepStrictEqual(positions, [
    [],
    [6, 18],
    [6, 34],
    [6, 22, 38],
    [6, 26, 46, 66],
    [6, 34, 60, 86, 112, 138],
    [6, 30, 58, 86, 114, 142, 170],
  ]);
});
