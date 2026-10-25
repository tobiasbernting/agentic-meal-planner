/**
 * Quantity arithmetic for one Shopping List line (FR-11, NFR-3): pure and LLM-free. Parts
 * (one per Share) are summed when every part shares one unit; otherwise they are kept side by
 * side ("2 dl + 1 msk") so nothing is silently lost. A hand-added line's free text is appended
 * after the Share total, or stands alone when the line has no Shares.
 */
export interface QuantityPart {
  quantity: number;
  unit: string | null;
}

export interface Quantity {
  /** A number as text when summed under one unit, a joined note otherwise, null when nothing was given. */
  quantity: string | null;
  /** The shared unit of a summed quantity; null for a mixed note or no unit. */
  unit: string | null;
}

export function formatQuantity(n: number): string {
  return String(Number(n.toFixed(3)));
}

export function combineParts(parts: readonly QuantityPart[]): Quantity {
  if (parts.length === 0) return { quantity: null, unit: null };
  const unit = parts[0]!.unit;
  if (parts.every((p) => p.unit === unit)) {
    const total = parts.reduce((sum, p) => sum + p.quantity, 0);
    return { quantity: formatQuantity(total), unit };
  }
  return { quantity: parts.map((p) => (p.unit ? `${formatQuantity(p.quantity)} ${p.unit}` : formatQuantity(p.quantity))).join(" + "), unit: null };
}

/** The line's quantity from its Share parts and, for a hand-added line, its free text. */
export function lineQuantity(parts: readonly QuantityPart[], handText: string | null): Quantity {
  const fromShares = combineParts(parts);
  const text = handText?.trim() || null;
  if (!text) return fromShares;
  if (fromShares.quantity === null) return { quantity: text, unit: null };
  const shares = fromShares.unit ? `${fromShares.quantity} ${fromShares.unit}` : fromShares.quantity;
  return { quantity: `${shares} + ${text}`, unit: null };
}

/**
 * Whether a new Share landing on a Checked Off line should un-tick it: only when more is now
 * needed than before. A Swap that replaces one Share with an equal one leaves the tick alone,
 * since what was bought still covers the line. With no comparable number (mixed units, no
 * quantities) any added Share counts as more.
 */
export function needsMore(before: readonly QuantityPart[], after: readonly QuantityPart[]): boolean {
  if (after.length === 0) return false;
  if (before.length === 0) return true;
  const a = combineParts(before);
  const b = combineParts(after);
  if (a.unit !== b.unit || a.quantity === null || b.quantity === null) return true;
  const na = Number(a.quantity);
  const nb = Number(b.quantity);
  if (!Number.isFinite(na) || !Number.isFinite(nb)) return after.length > before.length;
  return nb > na;
}
