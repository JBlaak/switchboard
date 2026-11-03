/**
 * The global config copy, Mac side (Q19, #283): on every connect to a VM host
 * whose `copyConfig` is on, send the Mac's `CLAUDE.md`, skills, commands,
 * agents, installed plugins and the safe part of `settings.json` to the VM's
 * `~/.claude` as one `copy-config`.
 *
 * What goes and in what form is decided in `domain/agent/config-copy`; this
 * service lists, reads, sends and remembers. It is meant to run on every
 * connect, so it is cheap when nothing changed: the listing's sizes and mtimes
 * (and a hash of the generated files) are compared with the manifest of the
 * last successful copy to that host, and an unchanged config is not sent.
 * When anything changed, the whole copy is sent again rather than only the
 * difference, so a VM whose `~/.claude` was wiped or edited heals on the next
 * change instead of drifting.
 *
 * It never throws: a failed copy is logged and tried again on the next
 * connect, because the manifest is only saved once the agent said `done`.
 */
import {
    type ConfigCopyManifest,
    type ConfigEntry,
    COPIED_FOLDERS,
    CONFIG_MESSAGE_CAP_BYTES,
    GLOBAL_CLAUDE_MD,
    INSTALLED_PLUGINS_PATH,
    isUnchanged,
    KNOWN_MARKETPLACES_PATH,
    manifestOf,
    planConfigCopy,
    planPlugins,
    planSettings,
    removedSince,
    SETTINGS_PATH,
} from '../../domain/agent/config-copy';
import type {ConfigFile, HostSettings} from '../../domain/agent/protocol';
import type {RemoteConfig} from '../../domain/project/remote-target';
import type {ClaudeConfigSource, ConfigCopyConnection, ConfigManifestStore} from '../ports/claude-config';
import type {Logger} from '../ports/logger';
import type {SettingsStore} from '../ports/settings-store';

/** What one `copyTo` did, for the caller's log line and for tests. */
export type ConfigCopyOutcome =
    | {kind: 'off'}
    | {kind: 'unchanged'}
    | {kind: 'sent'; files: number; removed: number}
    | {kind: 'too-large'; bytes: number}
    | {kind: 'failed'; error: string};

export interface ConfigCopyServiceDeps {
    source: ClaudeConfigSource;
    manifests: ConfigManifestStore;
    logger: Logger;
}

/** The key a host's manifest is kept under: one per VM, whichever project on it connected. */
export function configCopyHostKey(host: RemoteConfig): string {
    return `${host.user}@${host.host}:${host.port}`;
}

/** The settings-store key holding every host's manifest. */
export const CONFIG_MANIFESTS_SETTINGS_KEY = 'agentConfigCopyManifests';

/**
 * A manifest store kept in the app's settings store, one key holding a map of
 * host key to manifest. The manifests are small (a path and a fingerprint per
 * file) and belong with the other per-host state the Mac keeps.
 */
export function manifestStoreOn(settings: SettingsStore): ConfigManifestStore {
    const all = (): Record<string, ConfigCopyManifest> =>
        settings.get<Record<string, ConfigCopyManifest>>(CONFIG_MANIFESTS_SETTINGS_KEY) ?? {};
    return {
        get: (hostKey) => all()[hostKey] ?? null,
        set: (hostKey, manifest) => settings.set(CONFIG_MANIFESTS_SETTINGS_KEY, {...all(), [hostKey]: manifest}),
    };
}

function base64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString('base64');
}

export class ConfigCopyService {
    constructor(private readonly deps: ConfigCopyServiceDeps) {}

    /**
     * Copies the Mac's global Claude config to `host` over `connection`, when
     * the host's settings allow it and something changed since the last copy.
     */
    public async copyTo(
        host: RemoteConfig,
        connection: ConfigCopyConnection,
        settings: HostSettings,
    ): Promise<ConfigCopyOutcome> {
        if (!settings.copyConfig) return {kind: 'off'};
        const hostKey = configCopyHostKey(host);
        try {
            return await this.copy(hostKey, connection);
        } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            this.deps.logger.error(`[config-copy] ${hostKey}: copy failed: ${error}`);
            return {kind: 'failed', error};
        }
    }

    private async copy(hostKey: string, connection: ConfigCopyConnection): Promise<ConfigCopyOutcome> {
        const {source, logger, manifests} = this.deps;
        const listings = new Map<string, ConfigEntry[]>();
        const listFolder = (folder: string): ConfigEntry[] => {
            let entries = listings.get(folder);
            if (!entries) listings.set(folder, (entries = source.list(folder)));
            return entries;
        };

        const plugins = planPlugins({
            installedPluginsJson: this.readText(INSTALLED_PLUGINS_PATH),
            knownMarketplacesJson: this.readText(KNOWN_MARKETPLACES_PATH),
            macHome: source.homeDir,
            hasFiles: (folder) => listFolder(folder).length > 0,
        });
        const settings = planSettings(this.readText(SETTINGS_PATH), source.homeDir, new Set(plugins.plugins));

        const claudeMd = source.stat(GLOBAL_CLAUDE_MD);
        const entries = [
            ...(claudeMd ? [claudeMd] : []),
            ...COPIED_FOLDERS.flatMap(listFolder),
            ...plugins.folders.flatMap(listFolder),
        ];
        const sources: Partial<Record<string, ConfigEntry>> = {};
        for (const path of [SETTINGS_PATH, INSTALLED_PLUGINS_PATH, KNOWN_MARKETPLACES_PATH]) {
            const entry = source.stat(path);
            if (entry) sources[path] = entry;
        }
        const plan = planConfigCopy({entries, plugins, settings, sources});

        for (const dropped of plan.droppedPlugins) {
            logger.info(`[config-copy] ${hostKey}: plugin ${dropped.plugin} left out: ${dropped.reason}`);
        }
        for (const skipped of plan.skipped) {
            logger.info(`[config-copy] ${hostKey}: ${skipped.path} left out: ${skipped.reason}`);
        }
        if (plan.droppedSettings.length > 0) {
            logger.debug(`[config-copy] ${hostKey}: settings.json keys left out: ${plan.droppedSettings.join(', ')}`);
        }

        if (plan.estimatedBytes > CONFIG_MESSAGE_CAP_BYTES) {
            logger.error(
                `[config-copy] ${hostKey}: not copied: the config comes to ${plan.estimatedBytes} bytes encoded, ` +
                    `over the ${CONFIG_MESSAGE_CAP_BYTES}-byte cap; trim ~/.claude/skills or the installed plugins`,
            );
            return {kind: 'too-large', bytes: plan.estimatedBytes};
        }

        const previous = manifests.get(hostKey);
        const next = manifestOf(plan.files);
        if (isUnchanged(previous, next)) {
            logger.debug(`[config-copy] ${hostKey}: unchanged since the last copy`);
            return {kind: 'unchanged'};
        }

        const removed = removedSince(previous, next);
        const saved: ConfigCopyManifest = {rules: next.rules, files: {...next.files}};
        const files: ConfigFile[] = [];
        for (const file of plan.files) {
            if (file.kind === 'generated') {
                files.push({
                    path: file.path,
                    mode: file.mode,
                    contentBase64: base64(new TextEncoder().encode(file.content)),
                });
                continue;
            }
            try {
                files.push({path: file.path, mode: file.mode, contentBase64: base64(source.read(file.path))});
            } catch (err) {
                // Gone or unreadable since the listing: send the rest, and leave the VM's copy of it (if any)
                // alone. The saved manifest keeps what the VM really has for it, so the next connect retries.
                const before = previous?.files[file.path];
                if (before === undefined) delete saved.files[file.path];
                else saved.files[file.path] = before;
                logger.warn(`[config-copy] ${hostKey}: ${file.path} could not be read: ${String(err)}`);
            }
        }

        const reply = await connection.copyConfig({files, removed});
        if (!reply.ok) {
            logger.error(`[config-copy] ${hostKey}: the agent refused the copy: ${reply.error ?? 'no reason given'}`);
            return {kind: 'failed', error: reply.error ?? 'refused'};
        }
        manifests.set(hostKey, saved);
        logger.info(`[config-copy] ${hostKey}: copied ${files.length} files, removed ${removed.length}`);
        return {kind: 'sent', files: files.length, removed: removed.length};
    }

    /** A config file as UTF-8, or null when it is missing or unreadable (the plan then treats it as absent). */
    private readText(path: string): string | null {
        const {source, logger} = this.deps;
        if (source.stat(path) === null) return null;
        try {
            return new TextDecoder().decode(source.read(path));
        } catch (err) {
            logger.warn(`[config-copy] ${path} could not be read: ${String(err)}`);
            return null;
        }
    }
}
