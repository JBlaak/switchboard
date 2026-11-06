/**
 * "Hide project" on a project's settings view (#176).
 */
import {dispatch} from '../../state/app-store';
import {loadProjects} from '../../features/sessions/session-list';
import {projectLabel} from '../../features/sessions/project-label';

/**
 * Hide the project from Switchboard, after asking. Its session files stay on
 * disk; it just stops being listed, so its page gives way to the empty screen.
 */
export async function hideProjectFromPage(projectPath: string): Promise<void> {
    if (
        !confirm(
            `Hide ${projectLabel(projectPath)}?\n\nSession files are not deleted. Add the folder again to bring it back.`,
        )
    )
        return;
    await window.api.removeProject(projectPath);
    dispatch({type: 'screenCleared'});
    void loadProjects();
}
