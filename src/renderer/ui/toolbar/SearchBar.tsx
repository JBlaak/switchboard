/**
 * The search box, its clear button and the titles-only toggle.
 *
 * `#search-bar` itself is the portal's container, outside this tree, so its
 * `has-query` class — which shows the clear button — is set on it from an
 * effect, as soon as there is anything in the box.
 */
import { useLayoutEffect, useRef } from 'react';
import { useStore } from '../use-store';
import { clearSearch, toggleSearchTitlesOnly, typeSearch } from './actions';
import type { JSX } from 'react';

export const SEARCH_BAR_ID = 'search-bar';

export function SearchBar(): JSX.Element {
  const query = useStore(s => s.toolbar.searchQuery);
  const titlesOnly = useStore(s => s.toolbar.searchTitlesOnly);
  const input = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    document.getElementById(SEARCH_BAR_ID)?.classList.toggle('has-query', query.length > 0);
  }, [query]);

  return (
    <>
      <input
        ref={input} id="search-input" type="text" placeholder="Search sessions..."
        value={query} onChange={e => typeSearch(e.target.value)}
      />
      <button
        id="search-clear" type="button" aria-label="Clear search"
        onClick={() => { clearSearch(); input.current?.focus(); }}
      >
        &times;
      </button>
      <button
        id="search-titles-toggle" type="button" title="Search titles only" aria-label="Search titles only"
        className={titlesOnly ? 'active' : undefined} onClick={toggleSearchTitlesOnly}
      >
        Tt
      </button>
    </>
  );
}
