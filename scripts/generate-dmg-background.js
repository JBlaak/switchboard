#!/usr/bin/env node
/**
 * Draws the window background of the installer disk image, at 1x and 2x, into
 * build/. The window size matches build.dmg.window in package.json, and the
 * arrow runs between the two icon slots in build.dmg.contents.
 *
 * The background is light on purpose. Finder paints the icon labels itself, in
 * near-black, whatever the system appearance (disk image windows ignore Dark
 * Mode), and nothing in electron-builder's dmg config can change that. A dark
 * background left "Switchboard" and "Applications" barely readable.
 */
const {createCanvas} = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

const BUILD_DIR = path.join(__dirname, '..', 'build');
const WIDTH = 660;
const HEIGHT = 400;

/** The vertical line the arrow sits on, between the two icons. */
const ARROW_Y = HEIGHT / 2 - 20;
const ARROW_START_X = 245;
const ARROW_END_X = 420;
const ARROW_HEAD_LENGTH = 10;
const ARROW_HEAD_HALF_WIDTH = 8;

const GREEN = 'rgba(47, 143, 116, 0.75)';
const SHAFT = {width: 2, dash: [8, 6]};
const CAPTION = {
    text: 'Drag to install',
    font: '13px -apple-system, "Helvetica Neue", sans-serif',
    colour: 'rgba(30, 52, 45, 0.7)',
    /** Below the arrow, centred between the icons. */
    baseline: ARROW_Y + 35,
};

function fillBackdrop(ctx) {
    const wash = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
    wash.addColorStop(0, '#f5f7f6');
    wash.addColorStop(1, '#e6ebe9');
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
}

/** A faint dot every 20 points gives the plain backdrop some texture. */
function dotGrid(ctx) {
    const spacing = 20;
    ctx.fillStyle = 'rgba(20, 40, 34, 0.05)';
    for (let x = spacing; x < WIDTH; x += spacing) {
        for (let y = spacing; y < HEIGHT; y += spacing) {
            ctx.beginPath();
            ctx.arc(x, y, 1, 0, 2 * Math.PI);
            ctx.fill();
        }
    }
}

/** A dashed shaft that stops just inside a solid head pointing at Applications. */
function dragArrow(ctx) {
    const headBase = ARROW_END_X - ARROW_HEAD_LENGTH;

    ctx.strokeStyle = GREEN;
    ctx.lineWidth = SHAFT.width;
    ctx.setLineDash(SHAFT.dash);
    ctx.beginPath();
    ctx.moveTo(ARROW_START_X, ARROW_Y);
    ctx.lineTo(headBase + 5, ARROW_Y);
    ctx.stroke();
    ctx.setLineDash([]); // the head is solid

    ctx.fillStyle = GREEN;
    ctx.beginPath();
    ctx.moveTo(headBase, ARROW_Y - ARROW_HEAD_HALF_WIDTH);
    ctx.lineTo(ARROW_END_X, ARROW_Y);
    ctx.lineTo(headBase, ARROW_Y + ARROW_HEAD_HALF_WIDTH);
    ctx.closePath();
    ctx.fill();
}

function caption(ctx) {
    Object.assign(ctx, {fillStyle: CAPTION.colour, font: CAPTION.font, textAlign: 'center'});
    ctx.fillText(CAPTION.text, WIDTH / 2, CAPTION.baseline);
}

/** A two-point green-to-blue line along the bottom edge. */
function accentLine(ctx) {
    const thickness = 2;
    const top = HEIGHT - thickness;
    const line = ctx.createLinearGradient(0, top, WIDTH, top);
    line.addColorStop(0, 'rgba(46, 182, 125, 0.75)');
    line.addColorStop(0.5, 'rgba(105, 226, 191, 0.75)');
    line.addColorStop(1, 'rgba(54, 197, 240, 0.75)');
    ctx.fillStyle = line;
    ctx.fillRect(0, top, WIDTH, thickness);
}

/** Draws in points, so the 2x render is the same picture with a scaled context. */
function writeBackground(scale, filename) {
    const canvas = createCanvas(scale * WIDTH, scale * HEIGHT);
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    for (const layer of [fillBackdrop, dotGrid, dragArrow, caption, accentLine]) {
        layer(ctx);
    }
    const png = canvas.toBuffer('image/png');
    const out = path.join(BUILD_DIR, filename);
    fs.writeFileSync(out, png);
    console.log(`Wrote ${out} (${png.length} bytes)`);
}

fs.mkdirSync(BUILD_DIR, {recursive: true});
writeBackground(1, 'dmg-background.png');
writeBackground(2, 'dmg-background@2x.png');
