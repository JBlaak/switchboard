/**
 * SQLite behind the SessionRepository port.
 *
 * Statements are prepared once in the constructor, which is what makes the
 * sidebar's per-render queries free; the two bulk writes are wrapped in
 * transactions, because indexing a project means hundreds of upserts and a
 * transaction each would take a second.
 */
import type Database from 'better-sqlite3';
import {decodePullRequests} from '../../domain/session/pull-requests';
import type {CachedSession, FolderMeta, SessionMeta} from '../../domain/session/session';
import type {IssuePlanPin, PlanPin, ProjectPin} from '../../domain/project/project-list';
import type {SessionRepository} from '../../application/ports/session-repository';
import {orderPins} from '../../domain/pin/pin-order';
import type {PinRef, PinSection} from '../../domain/pin/pin-order';

/** A `session_cache` row as SQLite hands it back: the PR list is still JSON text. */
type CachedSessionRow = Omit<CachedSession, 'pullRequests'> & {pullRequests: string | null};

/** An ISO time as epoch ms; 0 when there is none. */
function timeOf(iso: string | null): number {
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isNaN(ms) ? 0 : ms;
}

/** A cache row with its PR list decoded. */
function fromRow(row: CachedSessionRow): CachedSession {
    return {...row, pullRequests: decodePullRequests(row.pullRequests)};
}

export class SqliteSessionRepository implements SessionRepository {
    private readonly metaGetStatement;
    private readonly metaGetAllStatement;
    private readonly metaUpsertNameStatement;
    private readonly metaToggleStarStatement;
    private readonly metaUpsertArchivedStatement;
    private readonly metaUpsertSnoozedStatement;

    private readonly planPinsGetAllStatement;
    private readonly planPinInsertStatement;
    private readonly planPinDeleteStatement;
    private readonly issuePlanPinsGetAllStatement;
    private readonly issuePlanPinInsertStatement;
    private readonly issuePlanPinDeleteStatement;
    private readonly projectPinsGetAllStatement;
    private readonly projectPinInsertStatement;
    private readonly projectPinDeleteStatement;
    private readonly sessionPinsStatement;
    private readonly planPinTimesStatement;
    private readonly setPinOrderTransaction;

    private readonly cacheCountStatement;
    private readonly cacheGetAllStatement;
    private readonly cacheGetOneStatement;
    private readonly cacheGetFolderStatement;
    private readonly cacheGetFingerprints;
    private readonly cacheUpsertStatement;
    private readonly cacheDeleteOneStatement;
    private readonly cacheDeleteFolderStatement;

    private readonly folderGetAllStatement;
    private readonly folderUpsertStatement;
    private readonly folderDeleteStatement;

    private readonly upsertManyTransaction;

    constructor(db: Database.Database) {
        this.metaGetStatement = db.prepare<[string], SessionMeta>('SELECT * FROM session_meta WHERE sessionId = ?');
        this.metaGetAllStatement = db.prepare<[], SessionMeta>('SELECT * FROM session_meta');
        this.metaUpsertNameStatement = db.prepare<[string, string | null]>(`
      INSERT INTO session_meta (sessionId, name) VALUES (?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET name = excluded.name
    `);
        this.metaToggleStarStatement = db.prepare<[string]>(`
      INSERT INTO session_meta (sessionId, starred) VALUES (?, 1)
      ON CONFLICT(sessionId) DO UPDATE SET
        starred = CASE WHEN starred = 1 THEN 0 ELSE 1 END,
        pinPosition = CASE WHEN starred = 1 THEN NULL ELSE pinPosition END
    `);
        this.metaUpsertArchivedStatement = db.prepare<[string, 0 | 1]>(`
      INSERT INTO session_meta (sessionId, archived) VALUES (?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET archived = excluded.archived
    `);
        this.metaUpsertSnoozedStatement = db.prepare<[string, string | null]>(`
      INSERT INTO session_meta (sessionId, snoozedUntil) VALUES (?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET snoozedUntil = excluded.snoozedUntil
    `);

        this.planPinsGetAllStatement = db.prepare<[], {project_path: string; slug: string; position: number | null}>(
            'SELECT project_path, slug, position FROM pinned_plans',
        );
        this.planPinInsertStatement = db.prepare<[string, string]>(
            'INSERT OR IGNORE INTO pinned_plans (project_path, slug) VALUES (?, ?)',
        );
        this.planPinDeleteStatement = db.prepare<[string, string]>(
            'DELETE FROM pinned_plans WHERE project_path = ? AND slug = ?',
        );
        this.issuePlanPinsGetAllStatement = db.prepare<
            [],
            {
                project_path: string;
                repository: string;
                number: number;
                title: string;
                pinned_at: number;
                position: number | null;
            }
        >(
            'SELECT project_path, repository, number, title, pinned_at, position FROM pinned_issue_plans ORDER BY pinned_at',
        );
        this.issuePlanPinInsertStatement = db.prepare<[string, string, number, string, number]>(
            'INSERT OR IGNORE INTO pinned_issue_plans (project_path, repository, number, title, pinned_at) VALUES (?, ?, ?, ?, ?)',
        );
        this.issuePlanPinDeleteStatement = db.prepare<[string, string, number]>(
            'DELETE FROM pinned_issue_plans WHERE project_path = ? AND repository = ? AND number = ?',
        );
        this.projectPinsGetAllStatement = db.prepare<
            [],
            {project_path: string; pinned_at: number; position: number | null}
        >('SELECT project_path, pinned_at, position FROM pinned_projects ORDER BY pinned_at');
        this.projectPinInsertStatement = db.prepare<[string, number]>(
            'INSERT OR IGNORE INTO pinned_projects (project_path, pinned_at) VALUES (?, ?)',
        );
        this.projectPinDeleteStatement = db.prepare<[string]>('DELETE FROM pinned_projects WHERE project_path = ?');

        this.sessionPinsStatement = db.prepare<
            [],
            {sessionId: string; pinPosition: number | null; modified: string | null}
        >(`
      SELECT m.sessionId AS sessionId, m.pinPosition AS pinPosition, c.modified AS modified
      FROM session_meta m LEFT JOIN session_cache c ON c.sessionId = m.sessionId
      WHERE m.starred = 1
    `);
        this.planPinTimesStatement = db.prepare<
            [],
            {project_path: string; slug: string; position: number | null; modified: string | null}
        >(`
      SELECT p.project_path AS project_path, p.slug AS slug, p.position AS position,
        (SELECT MAX(c.modified) FROM session_cache c
         WHERE c.projectPath = p.project_path AND c.slug = p.slug) AS modified
      FROM pinned_plans p
    `);
        const setSessionPosition = db.prepare<[number, string]>(
            'UPDATE session_meta SET pinPosition = ? WHERE sessionId = ?',
        );
        const setProjectPosition = db.prepare<[number, string]>(
            'UPDATE pinned_projects SET position = ? WHERE project_path = ?',
        );
        const setPlanPosition = db.prepare<[number, string, string]>(
            'UPDATE pinned_plans SET position = ? WHERE project_path = ? AND slug = ?',
        );
        const setIssuePlanPosition = db.prepare<[number, string, string, number]>(
            'UPDATE pinned_issue_plans SET position = ? WHERE project_path = ? AND repository = ? AND number = ?',
        );
        this.setPinOrderTransaction = db.transaction((order: readonly PinRef[]) => {
            order.forEach((ref, i) => {
                switch (ref.kind) {
                    case 'session':
                        setSessionPosition.run(i, ref.sessionId);
                        return;
                    case 'project':
                        setProjectPosition.run(i, ref.projectPath);
                        return;
                    case 'plan':
                        setPlanPosition.run(i, ref.projectPath, ref.slug);
                        return;
                    case 'issuePlan':
                        setIssuePlanPosition.run(i, ref.projectPath, ref.repository, ref.number);
                        return;
                }
            });
        });

        this.cacheCountStatement = db.prepare<[], {cnt: number}>('SELECT COUNT(*) as cnt FROM session_cache');
        this.cacheGetAllStatement = db.prepare<[], CachedSessionRow>('SELECT * FROM session_cache');
        this.cacheGetOneStatement = db.prepare<[string], CachedSessionRow>(
            'SELECT * FROM session_cache WHERE sessionId = ?',
        );
        this.cacheGetFolderStatement = db.prepare<[string], {folder: string}>(
            'SELECT folder FROM session_cache WHERE sessionId = ?',
        );
        this.cacheGetFingerprints = db.prepare<[string], Pick<CachedSession, 'sessionId' | 'fileMtime'>>(
            'SELECT sessionId, fileMtime FROM session_cache WHERE folder = ?',
        );
        this.cacheUpsertStatement = db.prepare<
            [
                string,
                string,
                string,
                string,
                string,
                string,
                string,
                number,
                string | null,
                string | null,
                string | null,
                string,
            ]
        >(`
      INSERT INTO session_cache (
        sessionId, folder, projectPath, summary, firstPrompt, created, modified,
        messageCount, slug, aiTitle, fileMtime, pullRequests
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(sessionId) DO UPDATE SET
        folder = excluded.folder, projectPath = excluded.projectPath,
        summary = excluded.summary, firstPrompt = excluded.firstPrompt,
        created = excluded.created, modified = excluded.modified,
        messageCount = excluded.messageCount, slug = excluded.slug,
        aiTitle = excluded.aiTitle, fileMtime = excluded.fileMtime,
        pullRequests = excluded.pullRequests
    `);
        this.cacheDeleteOneStatement = db.prepare<[string]>('DELETE FROM session_cache WHERE sessionId = ?');
        this.cacheDeleteFolderStatement = db.prepare<[string]>('DELETE FROM session_cache WHERE folder = ?');

        this.folderGetAllStatement = db.prepare<[], FolderMeta>('SELECT * FROM cache_meta');
        this.folderUpsertStatement = db.prepare<[string, string | null, number]>(`
      INSERT INTO cache_meta (folder, projectPath, indexMtimeMs) VALUES (?, ?, ?)
      ON CONFLICT(folder) DO UPDATE SET
        projectPath = excluded.projectPath, indexMtimeMs = excluded.indexMtimeMs
    `);
        this.folderDeleteStatement = db.prepare<[string]>('DELETE FROM cache_meta WHERE folder = ?');

        this.upsertManyTransaction = db.transaction((sessions: readonly CachedSession[]) => {
            for (const s of sessions) {
                this.cacheUpsertStatement.run(
                    s.sessionId,
                    s.folder,
                    s.projectPath,
                    s.summary,
                    s.firstPrompt,
                    s.created,
                    s.modified,
                    s.messageCount || 0,
                    s.slug || null,
                    s.aiTitle || null,
                    s.fileMtime || null,
                    JSON.stringify(s.pullRequests ?? []),
                );
            }
        });
    }

    // ── Metadata ──

    public getMeta(sessionId: string): SessionMeta | null {
        return this.metaGetStatement.get(sessionId) ?? null;
    }

    public getAllMeta(): Map<string, SessionMeta> {
        const map = new Map<string, SessionMeta>();
        for (const row of this.metaGetAllStatement.all()) map.set(row.sessionId, row);
        return map;
    }

    public setName(sessionId: string, name: string | null): void {
        this.metaUpsertNameStatement.run(sessionId, name);
    }

    public toggleStar(sessionId: string): 0 | 1 {
        this.metaToggleStarStatement.run(sessionId);
        return this.metaGetStatement.get(sessionId)?.starred ?? 0;
    }

    public setArchived(sessionId: string, archived: boolean): void {
        this.metaUpsertArchivedStatement.run(sessionId, archived ? 1 : 0);
    }

    public setSnoozedUntil(sessionId: string, until: string | null): void {
        this.metaUpsertSnoozedStatement.run(sessionId, until);
    }

    public getPinnedPlans(): PlanPin[] {
        return this.planPinsGetAllStatement
            .all()
            .map((row) => ({projectPath: row.project_path, slug: row.slug, position: row.position}));
    }

    public togglePlanPin(projectPath: string, slug: string): boolean {
        if (this.planPinDeleteStatement.run(projectPath, slug).changes > 0) return false;
        this.planPinInsertStatement.run(projectPath, slug);
        return true;
    }

    public getPinnedIssuePlans(): IssuePlanPin[] {
        return this.issuePlanPinsGetAllStatement.all().map((row) => ({
            projectPath: row.project_path,
            repository: row.repository,
            number: row.number,
            title: row.title,
            pinnedAt: row.pinned_at,
            position: row.position,
        }));
    }

    public toggleIssuePlanPin(projectPath: string, repository: string, number: number, title: string): boolean {
        if (this.issuePlanPinDeleteStatement.run(projectPath, repository, number).changes > 0) return false;
        this.issuePlanPinInsertStatement.run(projectPath, repository, number, title, Date.now());
        return true;
    }

    public getPinnedProjects(): ProjectPin[] {
        return this.projectPinsGetAllStatement
            .all()
            .map((row) => ({projectPath: row.project_path, pinnedAt: row.pinned_at, position: row.position}));
    }

    public toggleProjectPin(projectPath: string): boolean {
        if (this.projectPinDeleteStatement.run(projectPath).changes > 0) return false;
        this.projectPinInsertStatement.run(projectPath, Date.now());
        return true;
    }

    public getPinOrder(section: PinSection): PinRef[] {
        switch (section) {
            case 'sessions':
                return orderPins(
                    this.sessionPinsStatement.all(),
                    (p) => p.pinPosition,
                    (p) => timeOf(p.modified),
                ).map((p) => ({kind: 'session', sessionId: p.sessionId}));
            case 'projects':
                return orderPins(
                    this.projectPinsGetAllStatement.all(),
                    (p) => p.position,
                    (p) => p.pinned_at,
                ).map((p) => ({kind: 'project', projectPath: p.project_path}));
            case 'plans': {
                const plans: {ref: PinRef; position: number | null; time: number}[] = [
                    ...this.planPinTimesStatement.all().map((p) => ({
                        ref: {kind: 'plan', projectPath: p.project_path, slug: p.slug} as const,
                        position: p.position,
                        time: timeOf(p.modified),
                    })),
                    ...this.issuePlanPinsGetAllStatement.all().map((p) => ({
                        ref: {
                            kind: 'issuePlan',
                            projectPath: p.project_path,
                            repository: p.repository,
                            number: p.number,
                        } as const,
                        position: p.position,
                        time: p.pinned_at,
                    })),
                ];
                return orderPins(
                    plans,
                    (p) => p.position,
                    (p) => p.time,
                ).map((p) => p.ref);
            }
        }
    }

    public setPinOrder(order: readonly PinRef[]): void {
        this.setPinOrderTransaction(order);
    }

    // ── Cache ──

    public isCachePopulated(): boolean {
        return (this.cacheCountStatement.get()?.cnt ?? 0) > 0;
    }

    public getAllCached(): CachedSession[] {
        return this.cacheGetAllStatement.all().map(fromRow);
    }

    public getCachedSession(sessionId: string): CachedSession | null {
        const row = this.cacheGetOneStatement.get(sessionId);
        return row ? fromRow(row) : null;
    }

    public getCachedFolder(sessionId: string): string | null {
        return this.cacheGetFolderStatement.get(sessionId)?.folder ?? null;
    }

    public getCachedFingerprints(folder: string): Pick<CachedSession, 'sessionId' | 'fileMtime'>[] {
        return this.cacheGetFingerprints.all(folder);
    }

    public upsertCachedSessions(sessions: readonly CachedSession[]): void {
        this.upsertManyTransaction(sessions);
    }

    public deleteCachedSession(sessionId: string): void {
        this.cacheDeleteOneStatement.run(sessionId);
    }

    public deleteCachedFolder(folder: string): void {
        this.cacheDeleteFolderStatement.run(folder);
        this.folderDeleteStatement.run(folder);
    }

    // ── Folder index gate ──

    public getAllFolderMeta(): Map<string, FolderMeta> {
        const map = new Map<string, FolderMeta>();
        for (const row of this.folderGetAllStatement.all()) map.set(row.folder, row);
        return map;
    }

    public setFolderMeta(folder: string, projectPath: string | null, indexMtimeMs: number): void {
        this.folderUpsertStatement.run(folder, projectPath, indexMtimeMs);
    }
}
