#!/usr/bin/env node
const { createCanvas } = require('@napi-rs/canvas');
const fs = require('fs');
const path = require('path');

const WIDTH = 660;
const HEIGHT = 400;
const OUTPUT_DIR = path.join(__dirname, '..', 'build');

// Icon positions must match build.dmg.contents in package.json, and iconSize
// must match build.dmg.iconSize — they decide where Finder puts the labels,
// which is what the plates below are sized around.
const ICON_X = [170, 490];
const ICON_Y = 170;
const ICON_SIZE = 100;

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

/**
 * Draw the whole background. Used for both the 1x and 2x renders — they were
 * previously two copies of the same ~50 lines, which is how they drift.
 */
function draw(ctx) {
  // Light background.
  //
  // Finder owns the icon-label colour — nothing in the .DS_Store or
  // electron-builder's dmg config can set it — and it draws unselected DMG labels
  // in near-black regardless of system appearance; disk image windows don't follow
  // Dark Mode. The previous dark background left "Switchboard" and "Applications"
  // at roughly 2.5:1 and effectively unreadable. Since the text can't be
  // lightened, the background is light: ~18:1 under the labels, and no per-label
  // plates or bands needed to rescue it.
  const gradient = ctx.createLinearGradient(0, 0, WIDTH, HEIGHT);
  gradient.addColorStop(0, '#f5f7f6');
  gradient.addColorStop(1, '#e6ebe9');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Subtle grid dots
  ctx.fillStyle = 'rgba(20, 40, 34, 0.05)';
  for (let x = 20; x < WIDTH; x += 20) {
    for (let y = 20; y < HEIGHT; y += 20) {
      ctx.beginPath();
      ctx.arc(x, y, 1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Arrow from app icon to Applications
  ctx.strokeStyle = 'rgba(47, 143, 116, 0.75)';
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(245, HEIGHT / 2 - 20);
  ctx.lineTo(415, HEIGHT / 2 - 20);
  ctx.stroke();

  // Arrowhead
  ctx.setLineDash([]);
  ctx.fillStyle = 'rgba(47, 143, 116, 0.75)';
  ctx.beginPath();
  ctx.moveTo(410, HEIGHT / 2 - 28);
  ctx.lineTo(420, HEIGHT / 2 - 20);
  ctx.lineTo(410, HEIGHT / 2 - 12);
  ctx.closePath();
  ctx.fill();

  // "Drag to install" text
  ctx.fillStyle = 'rgba(30, 52, 45, 0.7)';
  ctx.font = '13px -apple-system, "Helvetica Neue", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Drag to install', WIDTH / 2, HEIGHT / 2 + 15);

  // Bottom border accent
  const accentGradient = ctx.createLinearGradient(0, HEIGHT - 2, WIDTH, HEIGHT - 2);
  accentGradient.addColorStop(0, 'rgba(46, 182, 125, 0.75)');
  accentGradient.addColorStop(0.5, 'rgba(105, 226, 191, 0.75)');
  accentGradient.addColorStop(1, 'rgba(54, 197, 240, 0.75)');
  ctx.fillStyle = accentGradient;
  ctx.fillRect(0, HEIGHT - 2, WIDTH, 2);
}

function render(scale, filename) {
  const canvas = createCanvas(WIDTH * scale, HEIGHT * scale);
  const ctx = canvas.getContext('2d');
  if (scale !== 1) ctx.scale(scale, scale);
  draw(ctx);
  const buf = canvas.toBuffer('image/png');
  const outPath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(outPath, buf);
  console.log(`Created ${outPath} (${buf.length} bytes)`);
}

render(1, 'dmg-background.png');
render(2, 'dmg-background@2x.png');
