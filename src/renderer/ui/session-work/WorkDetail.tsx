/**
 * The page's right column: the selected item's header — title and ref, its
 * pills, `branch → base`, the issues it closes — over the place its diff will
 * go (#75).
 */
import type { JSX } from 'react';
import { openOnGitHub } from './actions';
import {
  closedIssues, itemBranchLine, itemPills, itemRef, itemSummary, itemTitle,
} from './describe';
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
  const files = item.kind === 'dirty' ? item.files : [];

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
      <div className="sw-diff-placeholder" data-testid="session-work-diff">
        <div className="sw-diff-summary">{itemSummary(item)}</div>
        {files.length > 0 && (
          <ul className="sw-file-list">
            {files.map(file => <li key={file.path}>{file.path}</li>)}
          </ul>
        )}
      </div>
    </section>
  );
}
