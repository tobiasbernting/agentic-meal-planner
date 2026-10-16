/** Date helpers for a Monday-start week, on ISO `YYYY-MM-DD` strings (UTC, no time zone math). */

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The seven dates Monday..Sunday starting at `weekStart`. */
export function weekDates(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** The five dates Monday..Friday starting at `weekStart`: the days a School serves lunch. */
export function weekdayDates(weekStart: string): string[] {
  return weekDates(weekStart).slice(0, 5);
}
