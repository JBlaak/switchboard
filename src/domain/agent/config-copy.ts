/**
 * The global config copy (Q19, #283): which parts of the Mac's `~/.claude` go
 * to a VM, and in what form.
 *
 * The copy goes one way, Mac to VM, so that Claude on the VM works the way the
 * user taught it to: their `CLAUDE.md`, `skills/`, `commands/`, `agents/` and
 * the plugins they installed for themselves. Credentials, transcripts, project
 * memory and MCP config stay behind (`NEVER_COPIED` and `isSafeConfigPath`),
 * and so does everything below that only makes sense on the Mac.
 *
 * Everything here is pure, so the rules can be read and tested without a disk.
 * The service in `application/services/config-copy-service` lists and reads the
 * files and sends what these functions choose.
 *
 * ## How Claude Code lays out plugins (researched on a real Mac, 2026-11)
 *
 * - `plugins/installed_plugins.json` (`version: 2`) maps `name@marketplace` to a
 *   list of installs. Each has a `scope` (`user`, or `project` with a
 *   `projectPath` naming a Mac checkout) and an absolute `installPath` such as
 *   `/Users/<name>/.claude/plugins/cache/<marketplace>/<plugin>/<version>`.
 * - `plugins/known_marketplaces.json` maps a marketplace name to its `source`
 *   (`{source: 'github', repo}`) and an absolute `installLocation` such as
 *   `/Users/<name>/.claude/plugins/marketplaces/<marketplace>`.
 * - `plugins/cache/<marketplace>/<plugin>/<version>/` holds a plugin's files.
 *   Old versions stay next to the current one; a `.in_use/<pid>` folder marks
 *   which processes use it; `temp_git_*` folders are half-done clones.
 * - `plugins/marketplaces/<marketplace>/` is a clone of the marketplace (a git
 *   checkout with `.git`, or a downloaded snapshot). Its
 *   `.claude-plugin/marketplace.json` describes every plugin, and for some
 *   (the LSP plugins) that entry *is* the plugin: their cache folder holds only
 *   a README.
 * - `plugins/data/<plugin>-<marketplace>/` is a plugin's own persistent state,
 *   and the catalogue caches (`plugin-catalog-cache.json`,
 *   `plugin-directory-cache-v2.json`, `blocklist.json`, `store/`, `synced/`)
 *   are Claude Code's downloads.
 * - The plugin files themselves held no absolute Mac paths; only the two JSON
 *   records do.
 *
 * ## What the copy does with them
 *
 * - A plugin is copied when it has a `user`-scope install whose folder is under
 *   `~/.claude/plugins/cache/` and whose marketplace is known with a folder
 *   under `~/.claude/plugins/marketplaces/`. Its install folder is copied, and
 *   its marketplace's `.claude-plugin/` folder (the manifest), not the whole
 *   marketplace clone: the clone is large, and the VM's Claude refreshes it
 *   from the marketplace's own source when it wants to.
 * - A plugin installed only for projects is left out with a reason: its
 *   records name Mac checkouts that do not exist on the VM.
 * - `installed_plugins.json` and `known_marketplaces.json` are rewritten:
 *   only the copied plugins and their marketplaces, and every absolute
 *   `installPath`/`installLocation` turned into `CLAUDE_DIR_PLACEHOLDER` plus
 *   the path below `~/.claude`. The agent expands the placeholder to its own
 *   `~/.claude` (see `expandClaudeDirPlaceholder`). A record that still names
 *   the Mac's home after that is left out with a reason.
 * - `plugins/data/`, the catalogue caches and the marketplace clones are not
 *   copied.
 *
 * ## `settings.json`
 *
 * Copied in part, by allow-list (`COPIED_SETTINGS`). It is useful (which
 * plugins are on, the model and effort, the permission rules), but much of it
 * is Mac-only or secret: `hooks` and `statusLine` run Mac scripts by absolute
 * path, `env` and `apiKeyHelper` hold or fetch secrets, and the MCP keys name
 * Mac servers. Anything not on the list is left out; within the list,
 * `enabledPlugins` keeps only the copied plugins, `permissions` keeps only its
 * rules and default mode (never `additionalDirectories`, which are Mac
 * folders), `extraKnownMarketplaces` keeps only remote sources, and any value
 * still naming the Mac's home is dropped. The result replaces the VM's
 * `settings.json` whole; Switchboard's own question hook does not live there
 * (it is passed with `--settings`), so nothing of Switchboard's is lost.
 */
import {MAX_FRAME_BYTES} from './framing';
import {isSafeConfigPath} from './protocol';

// ── Caps ──

/**
 * The largest single file the copy sends. Config is text; a file bigger than
 * this is a bundled binary or a vendored asset nobody's Claude needs.
 */
export const CONFIG_FILE_CAP_BYTES = 1024 * 1024;

/**
 * The largest `copy-config` message the copy sends, as encoded: base64
 * contents, paths and JSON overhead. The contract sends the whole copy as one
 * message, and one message is one frame, so this sits just under the frame
 * limit (16 MiB), which comes to roughly 11–12 MiB of files. Over it the copy
 * stops rather than send part of the config.
 */
export const CONFIG_MESSAGE_CAP_BYTES = MAX_FRAME_BYTES - 256 * 1024;

/** What each file costs in the message beyond its base64 contents and path: the JSON keys and the mode. */
const PER_FILE_OVERHEAD_BYTES = 64;

// ── What is copied ──

/** The single file at the top of `~/.claude` that is always copied when present. */
export const GLOBAL_CLAUDE_MD = 'CLAUDE.md';

/** The folders copied whole (minus exclusions). */
export const COPIED_FOLDERS: readonly string[] = ['skills', 'commands', 'agents'];

export const SETTINGS_PATH = 'settings.json';
export const INSTALLED_PLUGINS_PATH = 'plugins/installed_plugins.json';
export const KNOWN_MARKETPLACES_PATH = 'plugins/known_marketplaces.json';

/** Where plugin installs and marketplace clones live, below `~/.claude`. */
const PLUGIN_CACHE_DIR = 'plugins/cache';
const MARKETPLACES_DIR = 'plugins/marketplaces';
/** Inside a marketplace clone, the folder with its manifest. */
const MARKETPLACE_MANIFEST_DIR = '.claude-plugin';

/**
 * Folder or file names never copied wherever they appear: version-control
 * internals, installed dependencies, Finder litter, Claude Code's per-process
 * `.in_use` markers on plugin folders and the skills `.trash`. The lister may
 * use `isExcludedName` to avoid walking into them at all.
 */
export const EXCLUDED_NAMES: readonly string[] = ['.git', 'node_modules', '.DS_Store', '.in_use', '.trash'];

export function isExcludedName(name: string): boolean {
    return EXCLUDED_NAMES.includes(name);
}

// ── The placeholder the agent expands ──

/**
 * Stands for the VM's absolute `~/.claude` (no trailing slash) in the files of
 * `PLACEHOLDER_FILES`. The Mac does not know the VM's home, so it writes this
 * and the agent replaces it before writing the file.
 */
export const CLAUDE_DIR_PLACEHOLDER = '{{SWITCHBOARD_CLAUDE_DIR}}';

/** The only files that carry the placeholder; the agent expands it in exactly these. */
export const PLACEHOLDER_FILES: readonly string[] = [INSTALLED_PLUGINS_PATH, KNOWN_MARKETPLACES_PATH];

/**
 * The agent's half of the path rule: every placeholder in `content` becomes
 * `claudeDir`, the VM's absolute `~/.claude`. The files are JSON and the
 * placeholder sits inside JSON strings, so the path is escaped as a JSON
 * string body would be (a no-op for ordinary paths).
 */
export function expandClaudeDirPlaceholder(content: string, claudeDir: string): string {
    const escaped = JSON.stringify(claudeDir.replace(/\/+$/, '')).slice(1, -1);
    return content.split(CLAUDE_DIR_PLACEHOLDER).join(escaped);
}

// ── Inputs and outputs ──

/** One regular file below `~/.claude` on the Mac, as the lister reports it. */
export interface ConfigEntry {
    /** Relative to `~/.claude`, `/`-separated. */
    path: string;
    size: number;
    /** `st_mode` or just its permission bits; only the permission bits are sent. */
    mode: number;
    mtimeMs: number;
}

/** A file the copy chose not to send, and why, for the log. */
export interface SkippedConfigFile {
    path: string;
    reason: string;
}

/** A plugin the copy left out, and why, for the log. */
export interface DroppedPlugin {
    plugin: string;
    reason: string;
}

// ── Plugins ──

export interface PluginPlanInput {
    /** `plugins/installed_plugins.json` as text, or null when there is none. */
    installedPluginsJson: string | null;
    /** `plugins/known_marketplaces.json` as text, or null when there is none. */
    knownMarketplacesJson: string | null;
    /** The Mac's absolute home, e.g. `/Users/name`; its `.claude` is where install paths must point. */
    macHome: string;
    /** Whether a folder below `~/.claude` has any file in it, to leave out a plugin whose install is gone. */
    hasFiles(folder: string): boolean;
}

export interface PluginPlan {
    /** The copied plugins, `name@marketplace`. */
    plugins: string[];
    /** Folders below `~/.claude` whose files are copied for them: installs and marketplace manifests. */
    folders: string[];
    /** The rewritten `installed_plugins.json`, or null when no plugin is copied. */
    installedPlugins: string | null;
    /** The rewritten `known_marketplaces.json`, or null when no plugin is copied. */
    knownMarketplaces: string | null;
    dropped: DroppedPlugin[];
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseObject(json: string | null): JsonObject | null {
    if (json === null) return null;
    try {
        const parsed: unknown = JSON.parse(json);
        return isObject(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function claudeDirOf(macHome: string): string {
    return macHome.replace(/\/+$/, '') + '/.claude';
}

/** `absolute` below the Mac's `~/.claude`, relative and safe, or null. */
function relativeToClaudeDir(absolute: unknown, claudeDir: string): string | null {
    if (typeof absolute !== 'string' || !absolute.startsWith(claudeDir + '/')) return null;
    const relative = absolute.slice(claudeDir.length + 1).replace(/\/+$/, '');
    return isSafeConfigPath(relative) ? relative : null;
}

/** Whether any string inside `value` still names the Mac's home: a path the VM cannot use. */
function mentionsHome(value: unknown, macHome: string): boolean {
    return JSON.stringify(value).includes(macHome.replace(/\/+$/, '') + '/');
}

function marketplaceOf(pluginKey: string): string {
    const at = pluginKey.lastIndexOf('@');
    return at < 0 ? '' : pluginKey.slice(at + 1);
}

function toJson(value: unknown): string {
    return JSON.stringify(value, null, 2) + '\n';
}

/**
 * Which installed plugins go to the VM, the folders that carry them, and the
 * two plugin records rewritten for the VM (see the module comment for the
 * rules).
 */
export function planPlugins(input: PluginPlanInput): PluginPlan {
    const empty: PluginPlan = {plugins: [], folders: [], installedPlugins: null, knownMarketplaces: null, dropped: []};
    const installed = parseObject(input.installedPluginsJson);
    if (installed === null) {
        if (input.installedPluginsJson !== null) {
            empty.dropped.push({plugin: '*', reason: `${INSTALLED_PLUGINS_PATH} is not a JSON object`});
        }
        return empty;
    }
    const records = isObject(installed.plugins) ? installed.plugins : {};
    const marketplaces = parseObject(input.knownMarketplacesJson) ?? {};
    const claudeDir = claudeDirOf(input.macHome);

    const plan: PluginPlan = {...empty, dropped: []};
    const outPlugins: JsonObject = {};
    const outMarketplaces: JsonObject = {};
    const folders = new Set<string>();

    for (const key of Object.keys(records).sort()) {
        const installs = records[key];
        const userInstall = Array.isArray(installs)
            ? installs.find((entry): entry is JsonObject => isObject(entry) && entry.scope === 'user')
            : undefined;
        if (!userInstall) {
            plan.dropped.push({plugin: key, reason: 'installed for Mac projects only'});
            continue;
        }
        const installDir = relativeToClaudeDir(userInstall.installPath, claudeDir);
        if (installDir === null || !installDir.startsWith(PLUGIN_CACHE_DIR + '/')) {
            plan.dropped.push({plugin: key, reason: 'installed outside ~/.claude/plugins/cache'});
            continue;
        }
        if (!input.hasFiles(installDir)) {
            plan.dropped.push({plugin: key, reason: `its install folder ${installDir} is missing or empty`});
            continue;
        }
        const marketplaceName = marketplaceOf(key);
        const marketplace = marketplaces[marketplaceName];
        const marketplaceDir = isObject(marketplace)
            ? relativeToClaudeDir(marketplace.installLocation, claudeDir)
            : null;
        if (!isObject(marketplace) || marketplaceDir === null || !marketplaceDir.startsWith(MARKETPLACES_DIR + '/')) {
            plan.dropped.push({
                plugin: key,
                reason: `marketplace ${marketplaceName || '(none)'} is not known in ~/.claude`,
            });
            continue;
        }
        const rewrittenMarketplace = {...marketplace, installLocation: `${CLAUDE_DIR_PLACEHOLDER}/${marketplaceDir}`};
        const rewrittenInstall = {...userInstall, installPath: `${CLAUDE_DIR_PLACEHOLDER}/${installDir}`};
        if (mentionsHome(rewrittenMarketplace, input.macHome) || mentionsHome(rewrittenInstall, input.macHome)) {
            plan.dropped.push({plugin: key, reason: 'its records name other Mac paths'});
            continue;
        }
        outMarketplaces[marketplaceName] = rewrittenMarketplace;
        outPlugins[key] = [rewrittenInstall];
        folders.add(installDir);
        folders.add(`${marketplaceDir}/${MARKETPLACE_MANIFEST_DIR}`);
        plan.plugins.push(key);
    }

    if (plan.plugins.length === 0) return {...empty, dropped: plan.dropped};
    plan.folders = [...folders].sort();
    plan.installedPlugins = toJson({...installed, plugins: outPlugins});
    plan.knownMarketplaces = toJson(outMarketplaces);
    return plan;
}

// ── settings.json ──

/**
 * The `settings.json` keys that may go to the VM. Everything else stays on the
 * Mac: `hooks`, `statusLine` (Mac scripts), `env`, `apiKeyHelper`,
 * `awsAuthRefresh`, `awsCredentialExport`, `otelHeadersHelper` (secrets),
 * `enableAllProjectMcpServers`, `enabledMcpjsonServers`,
 * `disabledMcpjsonServers` (MCP config), `autoMode` (a description of the
 * Mac's own environment), `sandbox`, and whatever Claude Code adds later
 * until someone decides it is safe.
 */
export const COPIED_SETTINGS: readonly string[] = [
    'model',
    'effortLevel',
    'alwaysThinkingEnabled',
    'outputStyle',
    'language',
    'includeCoAuthoredBy',
    'attribution',
    'cleanupPeriodDays',
    'editorMode',
    'vimInsertModeRemaps',
    'permissions',
    'enabledPlugins',
    'extraKnownMarketplaces',
];

/** Inside `permissions`, the parts that may go: the rules and the default mode. */
const COPIED_PERMISSION_KEYS: readonly string[] = ['allow', 'deny', 'ask', 'defaultMode'];

/** Marketplace sources the VM can fetch by itself; a `directory` or `file` source is a Mac path. */
const REMOTE_MARKETPLACE_SOURCES: readonly string[] = ['github', 'git', 'url'];

export interface SettingsPlan {
    /** The VM's `settings.json`, or null when nothing of the Mac's is worth sending. */
    content: string | null;
    /** Top-level keys left out, for the log. */
    dropped: string[];
}

function filterPermissions(value: unknown, macHome: string): JsonObject | null {
    if (!isObject(value)) return null;
    const out: JsonObject = {};
    for (const key of COPIED_PERMISSION_KEYS) {
        const part = value[key];
        if (Array.isArray(part)) {
            const rules = part.filter((rule) => typeof rule === 'string' && !mentionsHome(rule, macHome));
            if (rules.length > 0) out[key] = rules;
        } else if (key === 'defaultMode' && typeof part === 'string') {
            out[key] = part;
        }
    }
    return Object.keys(out).length > 0 ? out : null;
}

function filterEnabledPlugins(value: unknown, copiedPlugins: ReadonlySet<string>): JsonObject | null {
    if (!isObject(value)) return null;
    const out: JsonObject = {};
    for (const [plugin, enabled] of Object.entries(value)) if (copiedPlugins.has(plugin)) out[plugin] = enabled;
    return Object.keys(out).length > 0 ? out : null;
}

function filterMarketplaces(value: unknown, macHome: string): JsonObject | null {
    if (!isObject(value)) return null;
    const out: JsonObject = {};
    for (const [name, marketplace] of Object.entries(value)) {
        if (!isObject(marketplace) || !isObject(marketplace.source)) continue;
        const kind = marketplace.source.source;
        if (typeof kind !== 'string' || !REMOTE_MARKETPLACE_SOURCES.includes(kind)) continue;
        if (mentionsHome(marketplace, macHome)) continue;
        out[name] = marketplace;
    }
    return Object.keys(out).length > 0 ? out : null;
}

/**
 * The part of the Mac's `settings.json` the VM gets (see `COPIED_SETTINGS`
 * and the module comment). `copiedPlugins` are the plugins the copy sends:
 * enabling one the VM does not have would only earn a warning there.
 */
export function planSettings(json: string | null, macHome: string, copiedPlugins: ReadonlySet<string>): SettingsPlan {
    const settings = parseObject(json);
    if (settings === null) return {content: null, dropped: json === null ? [] : [SETTINGS_PATH]};
    const out: JsonObject = {};
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(settings)) {
        let kept: unknown = null;
        if (COPIED_SETTINGS.includes(key)) {
            if (key === 'permissions') kept = filterPermissions(value, macHome);
            else if (key === 'enabledPlugins') kept = filterEnabledPlugins(value, copiedPlugins);
            else if (key === 'extraKnownMarketplaces') kept = filterMarketplaces(value, macHome);
            else kept = mentionsHome(value, macHome) ? null : value;
        }
        if (kept === null || kept === undefined) dropped.push(key);
        else out[key] = kept;
    }
    return {content: Object.keys(out).length > 0 ? toJson(out) : null, dropped};
}

// ── Selecting files ──

/** Whether `path` belongs to the copy by where it is: `CLAUDE.md`, the copied folders, or a plugin folder. */
function isWanted(path: string, pluginFolders: readonly string[]): boolean {
    if (path === GLOBAL_CLAUDE_MD) return true;
    return [...COPIED_FOLDERS, ...pluginFolders].some((folder) => path.startsWith(folder + '/'));
}

export interface ConfigSelection {
    selected: ConfigEntry[];
    skipped: SkippedConfigFile[];
}

/**
 * From a listing of `~/.claude`, the files the copy sends as they are:
 * `CLAUDE.md`, everything under `skills/`, `commands/` and `agents/`, and
 * everything under `pluginFolders` (from `planPlugins`). Excluded names,
 * files over `CONFIG_FILE_CAP_BYTES` and anything `isSafeConfigPath` refuses
 * are skipped; paths outside those places are ignored without a word, since a
 * whole-tree listing is mostly things the copy never meant to send.
 *
 * The generated files (`settings.json` and the plugin records) are not
 * chosen here; `planConfigCopy` adds them.
 */
export function selectConfigFiles(entries: readonly ConfigEntry[], pluginFolders: readonly string[]): ConfigSelection {
    const selected: ConfigEntry[] = [];
    const skipped: SkippedConfigFile[] = [];
    for (const entry of entries) {
        if (!isWanted(entry.path, pluginFolders)) continue;
        if (entry.path.split('/').some(isExcludedName)) continue;
        if (!isSafeConfigPath(entry.path)) skipped.push({path: entry.path, reason: 'refused by isSafeConfigPath'});
        else if (entry.size > CONFIG_FILE_CAP_BYTES) {
            skipped.push({path: entry.path, reason: `larger than ${CONFIG_FILE_CAP_BYTES} bytes`});
        } else selected.push(entry);
    }
    selected.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {selected, skipped};
}

// ── The whole plan ──

/** One file of the copy before its bytes are read: from disk as is, or generated here. */
export type PlannedConfigFile =
    | {path: string; mode: number; size: number; kind: 'file'; fingerprint: string}
    | {path: string; mode: number; size: number; kind: 'generated'; content: string; fingerprint: string};

export interface ConfigCopyPlan {
    files: PlannedConfigFile[];
    skipped: SkippedConfigFile[];
    droppedPlugins: DroppedPlugin[];
    droppedSettings: string[];
    /** The `copy-config` message's size as encoded, to hold against `CONFIG_MESSAGE_CAP_BYTES`. */
    estimatedBytes: number;
}

export interface ConfigCopyPlanInput {
    /** The listing of the copied folders, `CLAUDE.md` and the plugin folders. */
    entries: readonly ConfigEntry[];
    plugins: PluginPlan;
    settings: SettingsPlan;
    /** The listing's entries for the generated files' sources, for their modes. */
    sources: Partial<Record<string, ConfigEntry>>;
}

/** Permission bits only: the file type bits of `st_mode` mean nothing to the agent's `chmod`. */
function permissionBits(mode: number): number {
    return mode & 0o777;
}

function utf8Length(text: string): number {
    return new TextEncoder().encode(text).length;
}

/**
 * A short, stable hash (FNV-1a, 32 bits) of generated content. It only has to
 * notice that a rewritten record changed between two connects, not resist
 * anyone.
 */
export function contentHash(text: string): string {
    let hash = 0x811c9dc5;
    for (const byte of new TextEncoder().encode(text)) {
        hash ^= byte;
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(16).padStart(8, '0');
}

/** What a `copy-config` file costs in the message: base64 contents, its path, the keys around them. */
export function encodedFileBytes(path: string, size: number): number {
    return Math.ceil(size / 3) * 4 + utf8Length(path) + PER_FILE_OVERHEAD_BYTES;
}

/** Puts the chosen files and the generated ones together, with what each costs and its fingerprint. */
export function planConfigCopy(input: ConfigCopyPlanInput): ConfigCopyPlan {
    const {selected, skipped} = selectConfigFiles(input.entries, input.plugins.folders);
    const files: PlannedConfigFile[] = selected.map((entry) => ({
        path: entry.path,
        mode: permissionBits(entry.mode),
        size: entry.size,
        kind: 'file',
        fingerprint: `${entry.size}:${entry.mtimeMs}`,
    }));
    const generated: [string, string | null][] = [
        [SETTINGS_PATH, input.settings.content],
        [INSTALLED_PLUGINS_PATH, input.plugins.installedPlugins],
        [KNOWN_MARKETPLACES_PATH, input.plugins.knownMarketplaces],
    ];
    for (const [path, content] of generated) {
        if (content === null) continue;
        files.push({
            path,
            mode: permissionBits(input.sources[path]?.mode ?? 0o644),
            size: utf8Length(content),
            kind: 'generated',
            content,
            fingerprint: `g:${contentHash(content)}`,
        });
    }
    const estimatedBytes = files.reduce((total, file) => total + encodedFileBytes(file.path, file.size), 0);
    return {
        files,
        skipped,
        droppedPlugins: input.plugins.dropped,
        droppedSettings: input.settings.dropped,
        estimatedBytes,
    };
}

// ── The manifest of the last copy ──

/**
 * Bumped whenever these rules change what a given `~/.claude` turns into, so
 * that every host gets a fresh copy after an upgrade even though no file on
 * the Mac changed.
 */
export const CONFIG_COPY_RULES_VERSION = 1;

/**
 * What the last successful copy to a host wrote: each path with its
 * fingerprint (`size:mtimeMs` for a file, `g:<hash>` for a generated one).
 */
export interface ConfigCopyManifest {
    rules: number;
    files: Record<string, string>;
}

export function manifestOf(files: readonly PlannedConfigFile[]): ConfigCopyManifest {
    const out: Record<string, string> = {};
    for (const file of files) out[file.path] = file.fingerprint;
    return {rules: CONFIG_COPY_RULES_VERSION, files: out};
}

/** Whether `next` would write exactly what `previous` already did: same rules, same paths, same fingerprints. */
export function isUnchanged(previous: ConfigCopyManifest | null, next: ConfigCopyManifest): boolean {
    if (previous === null || previous.rules !== next.rules) return false;
    const before = Object.keys(previous.files);
    if (before.length !== Object.keys(next.files).length) return false;
    return before.every((path) => next.files[path] === previous.files[path]);
}

/**
 * The paths the last copy wrote that this one does not, which the agent
 * deletes. Only safe paths: a manifest is stored data, and the agent checks
 * again anyway.
 */
export function removedSince(previous: ConfigCopyManifest | null, next: ConfigCopyManifest): string[] {
    if (previous === null) return [];
    return Object.keys(previous.files)
        .filter((path) => !(path in next.files) && isSafeConfigPath(path))
        .sort();
}
