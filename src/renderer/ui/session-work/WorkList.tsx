/**
 * The page's left column: the session's work items, grouped as In progress,
 * Issues and Done (D5, D10, D12).
 *
 * Every item is a real button, and an issue a real link, so the list tabs and
 * reads like one; `j`/`k` (on the page) move the selection and the focus
 * together. Done starts collapsed each time the page opens.
 */
import type { JSX } from 'react';
import { selectWorkItem, openOnGitHub, toggleDoneItems } from './actions';
import { itemKind, itemPills, itemRef, itemTitle, itemUrl } from './describe';
import { Pills } from './Pills';
import { workSections } from '../../state/session-work-slice';
import type { SessionWorkPage } from '../../state/session-work-slice';
import type { SessionWorkItem } from '../../../domain/session-work/model';

export function WorkList({ page }: { page: SessionWorkPage }): JSX.Element {
  const { snapshot } = page;
  if (!snapshot) {
    return (
      <nav className="sw-list" aria-label="Work items" aria-busy="true">
        <div className="sw-section-label">In progress</div>
        <div className="sw-skeleton" />
        <div className="sw-skeleton" />
        <div className="sw-skeleton" />
      </nav>
    );
  }

  const { inProgress, issues, done } = workSections(snapshot);
  const repository = snapshot.repository;
  const row = (item: SessionWorkItem) => (
    <WorkListItem key={item.id} item={item} selected={item.id === page.selectedItemId} />
  );

  return (
    <nav className="sw-list" aria-label="Work items">
      {inProgress.length > 0 && (
        <>
          <div className="sw-section-label">In progress</div>
          {inProgress.map(row)}
        </>
      )}
      {issues.length > 0 && (
        <>
          <div className="sw-section-label">Issues</div>
          {issues.map(item => <IssueLink key={item.id} item={item} repository={repository} />)}
        </>
      )}
      {done.length > 0 && (
        <>
          <button
            type="button"
            className="sw-done-toggle"
            aria-expanded={page.doneExpanded}
            onClick={toggleDoneItems}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 6l6 6-6 6" />
            </svg>
            <span className="sw-section-label">Done</span>
            <span className="sw-pill is-grey">{done.length}</span>
          </button>
          {page.doneExpanded && done.map(row)}
        </>
      )}
    </nav>
  );
}

function WorkListItem({ item, selected }: { item: SessionWorkItem; selected: boolean }): JSX.Element {
  return (
    <button
      type="button"
      className={'sw-item' + (selected ? ' is-selected' : '')}
      aria-current={selected ? 'true' : undefined}
      data-item-id={item.id}
      onClick={() => selectWorkItem(item.id)}
    >
      <ItemTop item={item} />
      <span className="sw-item-title">{itemTitle(item)}</span>
      <Pills pills={itemPills(item)} />
    </button>
  );
}

/** An issue nothing closes: a link out to GitHub (D10), not something to select. */
function IssueLink({ item, repository }: { item: SessionWorkItem; repository: string }): JSX.Element {
  const url = itemUrl(item, repository);
  return (
    <a
      className="sw-item is-link"
      href={url ?? undefined}
      onClick={(e) => {
        e.preventDefault();
        if (url) openOnGitHub(url);
      }}
    >
      <ItemTop item={item} external />
      <span className="sw-item-title">{itemTitle(item)}</span>
      <Pills pills={itemPills(item)} />
    </a>
  );
}

function ItemTop({ item, external = false }: { item: SessionWorkItem; external?: boolean }): JSX.Element {
  return (
    <span className="sw-item-top">
      <span className="sw-kind">{itemKind(item)}</span>
      <span className="sw-ref">{itemRef(item)}</span>
      {external && (
        <svg className="sw-external" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M7 17L17 7M9 7h8v8" />
        </svg>
      )}
    </span>
  );
}
