/**
 * Fuzzy subsequence matching, for the pickers that filter as you type.
 *
 * Separate from the full-text index: this ranks a short list of names already
 * in memory (projects, sessions in a dialog) and reports where each query
 * character landed so the caller can highlight it.
 */

/** A fuzzy match: its score, and where in the text each query character landed. */
export interface FuzzyMatch {
  score: number;
  positions: number[];
}

/**
 * True when position `i` in `text` starts a new word: the first character, one
 * after a separator, or a camelCase hump.
 */
function isFuzzyBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  if (/[\s/\\_.@:-]/.test(prev)) return true;
  return prev === prev.toLowerCase() && text[i] !== text[i].toLowerCase();
}

/**
 * One left-to-right pass, taking each query character at the earliest position
 * at or after `start` that still keeps the match in order.
 */
function fuzzyScanFrom(q: string, lower: string, text: string, start: number): FuzzyMatch | null {
  const positions: number[] = [];
  let score = 0;
  let prev = -2;
  let from = start;
  for (let qi = 0; qi < q.length; qi++) {
    const at = qi === 0 ? start : lower.indexOf(q[qi], from);
    if (at === -1) return null;
    score += 10;
    // Contiguity outweighs a word boundary: in a separator-heavy string every
    // character sits on a boundary, and "b-o-a-r-d" should not outrank the
    // literal "board".
    if (at === prev + 1) score += 25;              // contiguous run
    // Where the match starts says more about intent than a boundary in the
    // middle of it: "sb" should anchor on switchboard, not on the s of joris.
    if (isFuzzyBoundary(text, at)) score += qi === 0 ? 25 : 15;
    if (qi === 0) score -= Math.min(at, 20);       // reward matching early
    positions.push(at);
    prev = at;
    from = at + 1;
  }
  return { score, positions };
}

/**
 * Fuzzy-match `query` against `text` as a case-insensitive subsequence.
 *
 * Returns null when a query character can't be found in order, otherwise the
 * score (higher is better) and the matched positions, so callers can highlight
 * them. Scoring favours contiguous runs, word boundaries, and matches that
 * start early — which is what ranks "swb" onto switchboard ahead of
 * some/web/lib. An empty query matches everything with score 0.
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  if (!query) return { score: 0, positions: [] };
  if (!text) return null;
  const q = query.toLowerCase();
  const lower = text.toLowerCase();
  // A single greedy pass can settle for a worse run than one further along
  // ("ab" against "a-ab"), so restart from every occurrence of the first
  // character and keep the best-scoring match.
  let best: FuzzyMatch | null = null;
  for (let start = lower.indexOf(q[0]); start !== -1; start = lower.indexOf(q[0], start + 1)) {
    const match = fuzzyScanFrom(q, lower, text, start);
    if (match && (!best || match.score > best.score)) best = match;
  }
  return best;
}
