// Builds every bundle the app ships: the main process, the preload, the project
// scanner worker, the renderer, and the stylesheet. Output lands in app/, which
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
// require()d from node_modules at runtime. electron-log/electron-updater are
// left external too: they resolve app paths relative to their own location.
const nodeExternals = [
  'electron', 'node-pty', 'better-sqlite3', 'electron-log',
  'electron-updater', 'electron-reloader', 'ws',
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
    // nodeIntegration off, so xterm, morphdom, marked and CodeMirror all get
    // bundled in rather than pulled from node_modules by <script src>.
    name: 'renderer',
    ...common,
    entryPoints: [path.join(root, 'src/renderer/index.ts')],
    outfile: path.join(out, 'renderer/renderer.js'),
    platform: 'browser',
    format: 'iife',
    loader: { '.png': 'dataurl', '.ttf': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
  },
];

function buildStyles() {
  const result = sass.compile(path.join(root, 'src/renderer/styles/style.scss'), {
    style: watch ? 'expanded' : 'compressed',
    sourceMap: true,
    // Silence the deprecation chatter from xterm's own CSS import chain.
    quietDeps: true,
  });
  fs.mkdirSync(path.join(out, 'renderer'), { recursive: true });
  fs.writeFileSync(path.join(out, 'renderer/style.css'), `${result.css}\n/*# sourceMappingURL=style.css.map */`);
  if (result.sourceMap) {
    fs.writeFileSync(path.join(out, 'renderer/style.css.map'), JSON.stringify(result.sourceMap));
  }
  console.log('  styles  app/renderer/style.css');
}

function copyHtml() {
  fs.mkdirSync(path.join(out, 'renderer'), { recursive: true });
  fs.copyFileSync(path.join(root, 'src/renderer/index.html'), path.join(out, 'renderer/index.html'));
  console.log('  html    app/renderer/index.html');
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
    fs.watch(path.join(root, 'src/renderer/styles'), { recursive: true }, () => {
      try { buildStyles(); } catch (err) { console.error(err.message); }
    });
    fs.watch(path.join(root, 'src/renderer/index.html'), () => {
      try { copyHtml(); } catch (err) { console.error(err.message); }
    });
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
