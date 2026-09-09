/**
 * Forking a session.
 *
 * A fork is a new session that starts from another one's history, so it launches
 * with the project's normal defaults plus the id to branch from. The main
 * process cannot know the new session's real id until Claude writes it — see
 * the transition detector for how the row catches up.
 */
import { resolveDefaultSessionOptions } from './launch-options';
import { launchNewSession } from '../sessions/session-actions';
import type { Project } from '../../../domain/project/project';
import type { SessionRow } from '../../../domain/session/session';

export async function forkSession(session: SessionRow, project: Project): Promise<void> {
  const options = await resolveDefaultSessionOptions(project.projectPath);
  options.forkFrom = session.sessionId;
  await launchNewSession(project, options);
}
