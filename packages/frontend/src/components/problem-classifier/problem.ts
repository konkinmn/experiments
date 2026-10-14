/**
 * The induced side of the page's vocabulary: a **problem** is what pass 3 induced from
 * the readings, as against the **scenario** (the Gemma leaf a thread was selected by,
 * see `scenario.ts`).
 *
 * These two constants live here rather than in `CategoryList` so the crosstab and the
 * filters can use them without importing the component that renders them — the
 * component imports the crosstab, and a cycle back would be the result.
 */

/** Filter and crosstab key for the threads pass 3 left unassigned. */
export const UNASSIGNED = '__unassigned__';

/** Reader-facing name for the unassigned group. */
export const UNASSIGNED_LABEL = 'Unassigned';
