#!/usr/bin/env node
/**
 * Builds the app's macOS icons from the committed artwork in build/:
 * build/icon.icns for the bundle, and build/dock/*.png for the Dock icons the
 * App Icon setting swaps between at runtime.
 *
 * macOS icons don't fill their square: the artwork sits at 80% of the canvas
 * with a transparent margin around it, so every output goes through `inset()`
 * first. Without it the app icon looks oversized next to the system's own.
 */
const {execFileSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const BUILD_DIR = path.join(__dirname, '..', 'build');
const ARTWORK = path.join(BUILD_DIR, 'icon.png');
const PATCH_ARTWORK = path.join(BUILD_DIR, 'icon-patch.png');

const CANVAS_SIZE = 1024;
const MARGIN = Math.round(CANVAS_SIZE * 0.1);
const ARTWORK_SIZE = CANVAS_SIZE - 2 * MARGIN;

/** The point sizes an .iconset holds; each comes at 1x and at 2x. */
const ICONSET_POINT_SIZES = [16, 32, 128, 256, 512];

/**
 * Places the artwork on a transparent square. sips does the scaling, but it
 * can't composite onto a larger canvas, so Pillow does that part.
 */
const COMPOSITE_PY = `
import sys
from PIL import Image
path, size, offset = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
art = Image.open(path).convert('RGBA')
canvas = Image.new('RGBA', (size, size))
canvas.paste(art, (offset, offset), mask=art)
canvas.save(path)
`;

function resize(src, dest, pixels) {
    execFileSync('sips', ['-z', String(pixels), String(pixels), src, '--out', dest], {stdio: 'ignore'});
}

function inset(src, dest) {
    resize(src, dest, ARTWORK_SIZE);
    execFileSync('python3', ['-c', COMPOSITE_PY, dest, String(CANVAS_SIZE), String(MARGIN)], {stdio: 'inherit'});
}

function buildIcns(artwork, icnsPath) {
    const iconset = path.join(BUILD_DIR, 'icon.iconset');
    const framed = path.join(BUILD_DIR, 'icon-inset.png');
    fs.mkdirSync(iconset, {recursive: true});
    try {
        inset(artwork, framed);
        for (const points of ICONSET_POINT_SIZES) {
            resize(framed, path.join(iconset, `icon_${points}x${points}.png`), points);
            resize(framed, path.join(iconset, `icon_${points}x${points}@2x.png`), points * 2);
        }
        execFileSync('iconutil', ['-c', 'icns', iconset, '-o', icnsPath], {stdio: 'ignore'});
    } finally {
        fs.rmSync(iconset, {recursive: true, force: true});
        fs.rmSync(framed, {force: true});
    }
}

if (!fs.existsSync(ARTWORK)) {
    console.error(`Missing ${ARTWORK}: the icons are built from it.`);
    process.exit(1);
}

const icnsPath = path.join(BUILD_DIR, 'icon.icns');
buildIcns(ARTWORK, icnsPath);
console.log(`Wrote ${icnsPath}`);

// Same inset as the .icns, so swapping the Dock icon doesn't change its size.
const dockDir = path.join(BUILD_DIR, 'dock');
fs.mkdirSync(dockDir, {recursive: true});
inset(ARTWORK, path.join(dockDir, 'switchboard.png'));
inset(PATCH_ARTWORK, path.join(dockDir, 'patch.png'));
console.log(`Wrote the Dock icons to ${dockDir}`);
