/** Trim, lowercase, collapse whitespace: the deterministic comparison key (FR-6, FR-11). No diacritic folding. */
export function normaliseName(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, " ");
}
