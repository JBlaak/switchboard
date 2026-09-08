/**
 * Side-effect imports of non-code assets.
 *
 * The renderer bundle pulls xterm's stylesheet in through `import '….css'` so
 * esbuild emits it alongside the JS. TypeScript 7 rejects a side-effect import
 * it has no declaration for (TS2882), so the wildcard states that these resolve
 * to nothing type-wise — the bundler, not tsc, is what consumes them.
 *
 * No imports or exports here on purpose: an ambient module declaration is only
 * allowed at the top level of a non-module file.
 */
declare module '*.css';
declare module '*.png';
