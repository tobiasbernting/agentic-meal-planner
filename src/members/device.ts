/**
 * The device Member (ADR-0010): "this phone is Pappa's", kept in a cookie like the language.
 * Every write that attributes an edit reads it with `memberOf`; no cookie, or a cookie for a
 * deleted Member, means an unattributed edit, never a refusal. `memberChip` is the one way a
 * Member is shown: their colour as a dot and their name as text, so colour is never the only signal.
 */
import type Database from "better-sqlite3";
import { escapeHtml } from "../ui/layout.js";
import { getMember, type Member } from "./repo.js";

export const MEMBER_COOKIE = "member";
const ONE_YEAR_SECONDS = 31536000;

export function memberIdOf(req: { headers: { cookie?: string | undefined } }): number | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === MEMBER_COOKIE) {
      const id = Number(rest.join("=").trim());
      return Number.isInteger(id) && id > 0 ? id : undefined;
    }
  }
  return undefined;
}

/** The request's Member, or undefined when the device has none or its Member was deleted. */
export function memberOf(req: { headers: { cookie?: string | undefined } }, db: Database.Database): Member | undefined {
  const id = memberIdOf(req);
  return id === undefined ? undefined : getMember(db, id);
}

/** The Set-Cookie value that makes this device the Member's, or clears it. */
export function memberCookie(memberId: number | undefined): string {
  return memberId === undefined ? `${MEMBER_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax` : `${MEMBER_COOKIE}=${memberId}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
}

/** The Member as a chip: a coloured dot and the name in text. */
export function memberChip(member: Pick<Member, "name" | "colour">): string {
  return `<span class="member-chip member-${member.colour}"><span class="member-dot" aria-hidden="true"></span>${escapeHtml(member.name)}</span>`;
}
