/**
 * The page's right column: the selected item's header — title and ref, its
 * pills, `branch → base`, the issues it closes — over its diff.
 */
import type { JSX } from 'react';
import { openOnGitHub } from './actions';
import { closedIssues, itemBranchLine, itemPills, itemRef, itemTitle } from './describe';
import { DiffView } from './DiffView';
import { Pills } from './Pills';
import { selectedItem } from '../../state/session-work-slice';
import type { SessionWorkPage } from '../../state/session-work-slice';

export function WorkDetail({ page }: { page: SessionWorkPage }): JSX.Element {
  const item = selectedItem(page);
  if (!page.snapshot || !item) {
    return <section className="sw-detail" aria-label="Selected work item" />;
  }

  const repository = page.snapshot.repository;
  const branch = itemBranchLine(item);
  const closes = closedIssues(item, repository);

  return (
    <section className="sw-detail" aria-label="Selected work item">
      <div className="sw-detail-head">
        <h2 className="sw-detail-title">
          {itemTitle(item)} <span className="sw-detail-ref">{itemRef(item)}</span>
        </h2>
        <div className="sw-detail-facts">
          <Pills pills={itemPills(item)} />
          {branch && <span className="sw-branch">{branch}</span>}
          {closes.length > 0 && (
            <span>
              Closes{' '}
              {closes.map((issue, i) => (
                <span key={issue.label}>
                  {i > 0 && ', '}
                  {issue.url
                    ? (
                      <a
                        href={issue.url}
                        onClick={(e) => {
                          e.preventDefault();
                          openOnGitHub(issue.url!);
                        }}
                      >
                        {issue.label}
                      </a>
                    )
                    : issue.label}
                </span>
              ))}
            </span>
          )}
        </div>
        {item.error && <div className="sw-item-error" role="status">{item.error}</div>}
      </div>
      <DiffView page={page} item={item} />
    </section>
  );
}
