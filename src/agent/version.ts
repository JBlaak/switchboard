/**
 * The agent's own version, which a client's `hello.appVersion` must equal (#276).
 *
 * The agent ships inside the app and is always installed at the app's
 * version, so the build stamps package.json's version into both bundles as
 * `__AGENT_VERSION__` (an esbuild `define`, see scripts/build.mjs). Run from
 * source (tsx, the tests) nothing stamps it, and the version reads `dev`.
 */
declare const __AGENT_VERSION__: string | undefined;

export const AGENT_VERSION: string = typeof __AGENT_VERSION__ === 'string' ? __AGENT_VERSION__ : 'dev';
