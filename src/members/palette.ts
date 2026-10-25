/**
 * The eight Member colours (ADR-0010; docs/design/VISUAL.md). Ink-friendly tones that read on
 * paper and in dark mode; red is excluded because it belongs to red days. Each name is a CSS
 * class `member-<name>` in public/app.css, and colour is never the only signal: a chip always
 * carries the Member's name in text.
 */
export const MEMBER_COLOURS = ["moss", "sea", "plum", "clay", "sand", "slate", "berry", "pine"] as const;

export type MemberColour = (typeof MEMBER_COLOURS)[number];

export function isMemberColour(value: unknown): value is MemberColour {
  return typeof value === "string" && (MEMBER_COLOURS as readonly string[]).includes(value);
}

/** The first colour no Member uses yet, else the first in the palette. */
export function nextFreeColour(used: readonly string[]): MemberColour {
  return MEMBER_COLOURS.find((c) => !used.includes(c)) ?? MEMBER_COLOURS[0];
}
