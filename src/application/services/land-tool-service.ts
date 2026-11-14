/**
 * A session landing a pull request, through Switchboard's `land` tool.
 *
 * The call goes to the Merging host, as Land it on a row does, so it lands on
 * this Mac or on the VM that merges, and is judged the same way: the session
 * reads back where the PR landed, or why it did not.
 */
import {landOutcome, type LandInput} from '../../domain/merge-manager/land-tool';
import type {ArchiveToolOutcome} from '../../domain/session/archive-tool';
import type {Logger} from '../ports/logger';
import type {LandResult} from './merge-manager-service';

export interface LandToolServiceDeps {
    mergeManager: {land(repository: string, number: number): Promise<LandResult>};
    log: Logger;
}

export class LandToolService {
    constructor(private readonly deps: LandToolServiceDeps) {}

    /** The session launched as `launchId` asked to land `input`. */
    public async land(launchId: string, input: LandInput): Promise<ArchiveToolOutcome> {
        const result = await this.deps.mergeManager.land(input.repository, input.number);
        this.deps.log.info(
            `[land-tool] session=${launchId} landed ${input.repository}#${input.number}: ` +
                (result.ok ? 'landed' : result.reason),
        );
        return landOutcome(input, result);
    }
}
