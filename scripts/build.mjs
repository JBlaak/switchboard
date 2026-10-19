// Builds every bundle the app ships: the main process, the preload, the project
// scanner worker, the renderer, and the stylesheet; and the Quick Ask pop-up's
// own preload, renderer and stylesheet. Output lands in app/, which
// is what package.json's `main` and electron-builder's `files` point at.
//
//   node scripts/build.mjs           one-shot build
//   node scripts/build.mjs --watch   rebuild on change (used by npm start)
import * as esbuild from 'esbuild';
import * as sass from 'sass';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'app');
const watch = process.argv.includes('--watch');

// Native addons and Electron's own module can't be bundled — they have to be
// require()d from node_modules at runtime. electron-log is left external too:
// it resolves app paths relative to its own location.
const nodeExternals = [
  'electron', 'node-pty', 'better-sqlite3', 'electron-log',
  'electron-reloader',
];

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  // Electron 41 ships Chromium 138 / Node 22; nothing here needs downleveling
  // past what that understands.
  target: 'es2022',
};

const targets = [
  {
    name: 'main',
    ...common,
    entryPoints: [path.join(root, 'src/main/index.ts')],
    outfile: path.join(out, 'main.js'),
    platform: 'node',
    format: 'cjs',
    external: nodeExternals,
  },
  {
    name: 'preload',
    ...common,
    entryPoints: [path.join(root, 'src/preload/index.ts')],
    outfile: path.join(out, 'preload.js'),
    platform: 'node',
    format: 'cjs',
    external: nodeExternals,
  },
  {
    // The Quick Ask pop-up's (#142): it exposes `window.quickAsk`, not `window.api`.
    name: 'quick-ask-preload',
    ...common,
    entryPoints: [path.join(root, 'src/preload/quick-ask.ts')],
    outfile: path.join(out, 'quick-ask-preload.js'),
    platform: 'node',
    format: 'cjs',
    external: nodeExternals,
  },
  {
    // Emitted on its own so the schema-reconciliation test can open the
    // database under Electron-as-Node without booting the app (see
    // test/db-schema-reconcile.test.ts). main.js bundles its own copy.
    name: 'database',
    ...common,
    entryPoints: [path.join(root, 'src/infrastructure/sqlite/database.ts')],
    outfile: path.join(out, 'database.js'),
    platform: 'node',
    format: 'cjs',
    external: nodeExternals,
  },
  {
    name: 'worker',
    ...common,
    entryPoints: [path.join(root, 'src/workers/scan-projects.ts')],
    outfile: path.join(out, 'workers/scan-projects.js'),
    platform: 'node',
    format: 'cjs',
    external: nodeExternals,
  },
  {
    // The renderer is a plain browser bundle: contextIsolation is on and
    // nodeIntegration off, so xterm and React get bundled in rather
    // than pulled from node_modules by <script src>.
    //
    // React reads process.env.NODE_ENV to decide whether to ship its dev-only
    // checks and warnings; a one-shot build is what gets packaged, so it is
    // production, and only the watch build keeps them.
    name: 'renderer',
    ...common,
    entryPoints: [path.join(root, 'src/renderer/index.ts')],
    outfile: path.join(out, 'renderer/renderer.js'),
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
    loader: { '.png': 'dataurl', '.ttf': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
  },
  {
    // The Quick Ask pop-up, a window of its own: the same kind of bundle as
    // the renderer's, with none of the main window in it.
    name: 'quick-ask',
    ...common,
    entryPoints: [path.join(root, 'src/renderer/quick-ask/index.tsx')],
    outfile: path.join(out, 'quick-ask/quick-ask.js'),
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') },
    loader: { '.ttf': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
  },
];

/** Each stylesheet: its source, and where it is written. */
const stylesheets = [
  { from: 'src/renderer/styles/style.scss', to: 'renderer/style.css' },
  { from: 'src/renderer/quick-ask/style.scss', to: 'quick-ask/style.css' },
];

/** Each page: its source, and where it is copied. */
const pages = [
  { from: 'src/renderer/index.html', to: 'renderer/index.html' },
  { from: 'src/renderer/quick-ask/index.html', to: 'quick-ask/index.html' },
];

function buildStyles() {
  for (const { from, to } of stylesheets) {
    const result = sass.compile(path.join(root, from), {
      style: watch ? 'expanded' : 'compressed',
      sourceMap: true,
      // Silence the deprecation chatter from xterm's own CSS import chain.
      quietDeps: true,
    });
    const file = path.join(out, to);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${result.css}\n/*# sourceMappingURL=${path.basename(to)}.map */`);
    if (result.sourceMap) fs.writeFileSync(`${file}.map`, JSON.stringify(result.sourceMap));
    console.log(`  styles  app/${to}`);
  }
}

function copyHtml() {
  for (const { from, to } of pages) {
    const file = path.join(out, to);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(root, from), file);
    console.log(`  html    app/${to}`);
  }
}

async function main() {
  fs.rmSync(out, { recursive: true, force: true });

  if (watch) {
    for (const { name, ...opts } of targets) {
      const ctx = await esbuild.context(opts);
      await ctx.watch();
      console.log(`  watch   ${name}`);
    }
    copyHtml();
    buildStyles();
    for (const dir of ['src/renderer/styles', 'src/renderer/quick-ask']) {
      fs.watch(path.join(root, dir), { recursive: true }, (_event, file) => {
        if (!String(file).endsWith('.scss')) return;
        try { buildStyles(); } catch (err) { console.error(err.message); }
      });
    }
    for (const { from } of pages) {
      fs.watch(path.join(root, from), () => {
        try { copyHtml(); } catch (err) { console.error(err.message); }
      });
    }
    // Hold the process open for the watchers.
    await new Promise(() => {});
  } else {
    await Promise.all(targets.map(({ name, ...opts }) => esbuild.build(opts)));
    copyHtml();
    buildStyles();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
