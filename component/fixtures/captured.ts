/**
 * The e2e fixtures as the renderer gets them from the real app: captured from
 * main by e2e/tests/component-fixtures.spec.ts, which also keeps them true.
 */
import type {Project} from '../../src/domain/project/project';
import standard from './standard.json';

/** Where the captured fixture's home is: the e2e home's temporary path, made stable. */
export const FIXTURE_HOME = '/home/fixture';

export interface CapturedFixture {
    /** `getProjects(false)`. */
    projects: Project[];
    /** `getProjects(true)`: archived sessions too. */
    projectsWithArchived: Project[];
}

const FIXTURES = {standard: standard as CapturedFixture};

export function captured(name: keyof typeof FIXTURES): CapturedFixture {
    return structuredClone(FIXTURES[name]);
}

/** An absolute project path in a captured fixture, from one relative to its home. */
export function fixtureProjectPath(relative: string): string {
    return `${FIXTURE_HOME}/${relative}`;
}
