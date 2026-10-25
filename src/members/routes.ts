/**
 * Members (ADR-0010): CRUD under Mer in the Pantry pages' pattern, and the device chooser
 * `/me` ("Vems telefon är detta?") that sets the `member` cookie. Colour is picked from the
 * fixed palette as labelled radio swatches; red is not offered.
 */
import type { FeaturePlugin } from "../app.js";
import { langOf, t, type Lang, type MessageKey } from "../i18n/index.js";
import { escapeHtml, notice, page } from "../ui/layout.js";
import { memberChip, memberCookie, memberOf } from "./device.js";
import { MEMBER_COLOURS, isMemberColour, nextFreeColour, type MemberColour } from "./palette.js";
import { createMember, deleteMember, getMember, listMembers, updateMember, type Member, type MemberInput } from "./repo.js";

interface MemberForm {
  name?: string;
  colour?: string;
  topic?: string;
}

interface MemberParams {
  id: string;
}

interface MeForm {
  member?: string;
  next?: string;
}

/** A same-origin relative path ("/x"), else undefined. */
function safePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\") || /[\r\n]/.test(value)) return undefined;
  return value;
}

function parseMemberForm(body: MemberForm): MemberInput | undefined {
  const name = body.name?.trim() ?? "";
  if (!name || !isMemberColour(body.colour)) return undefined;
  return { name, colour: body.colour, topic: body.topic?.trim() || null };
}

export function colourLabel(lang: Lang, colour: MemberColour): string {
  return t(lang, `member.colour.${colour}` as MessageKey);
}

/** The palette as labelled radio swatches; the name is always beside the colour. */
function colourField(lang: Lang, chosen: MemberColour): string {
  const swatches = MEMBER_COLOURS.map(
    (c) =>
      `<label class="chip swatch member-${c}"><input type="radio" name="colour" value="${c}"${c === chosen ? " checked" : ""} /> <span class="member-dot" aria-hidden="true"></span>${escapeHtml(colourLabel(lang, c))}</label>`,
  ).join("\n    ");
  return `<fieldset>
    <legend>${t(lang, "member.colour")}</legend>
    ${swatches}
  </fieldset>`;
}

function memberFields(lang: Lang, member: MemberInput): string {
  return `<label>${t(lang, "common.name")} <input name="name" required value="${escapeHtml(member.name)}" /></label>
  ${colourField(lang, member.colour)}
  <label>${t(lang, "member.topic")} <input name="topic" value="${escapeHtml(member.topic ?? "")}" placeholder="${escapeHtml(t(lang, "member.topicHint"))}" /></label>`;
}

function memberRow(lang: Lang, member: Member, mine: boolean): string {
  const status = [member.topic ? escapeHtml(member.topic) : "", mine ? t(lang, "member.thisDevice") : ""].filter(Boolean).join(" · ");
  return `<li class="row with-actions">
  <span class="row-label">${memberChip(member)}</span>${status ? `\n  <span class="row-status">${status}</span>` : ""}
  <div class="row-actions"><a class="button quiet" href="/members/${member.id}/edit">${t(lang, "common.edit")}</a>
  <form method="post" action="/members/${member.id}/delete"><button type="submit" class="quiet">${t(lang, "common.delete")}</button></form></div>
</li>`;
}

function listPage(lang: Lang, members: Member[], mine: Member | undefined, error?: string): string {
  const body = `<header class="page-head"><h1>${t(lang, "member.title")}</h1></header>
${error ? notice({ text: error }) : ""}
<p class="muted">${t(lang, "member.intro")}</p>
<ul class="rows">
${members.map((m) => memberRow(lang, m, m.id === mine?.id)).join("\n")}
</ul>
<p><a class="button quiet" href="/me">${mine ? escapeHtml(t(lang, "member.deviceIs", { name: mine.name })) : t(lang, "member.chooseDevice")}</a></p>
<h2>${t(lang, "member.addHeading")}</h2>
<form method="post" action="/members">
  ${memberFields(lang, { name: "", colour: nextFreeColour(members.map((m) => m.colour)), topic: null })}
  <button type="submit">${t(lang, "common.add")}</button>
</form>`;
  return page({ title: t(lang, "member.title"), body, lang, tab: "more" });
}

function editPage(lang: Lang, member: Member, error?: string): string {
  const body = `<header class="page-head"><h1>${t(lang, "member.editHeading")}</h1></header>
${error ? notice({ text: error }) : ""}
<form method="post" action="/members/${member.id}">
  ${memberFields(lang, member)}
  <button type="submit">${t(lang, "common.save")}</button>
</form>
<p><a href="/members">${t(lang, "member.back")}</a></p>`;
  return page({ title: t(lang, "member.editHeading"), body, lang, tab: "more" });
}

/** The device chooser: one radio per Member and "no one", posting the cookie. */
function mePage(lang: Lang, members: Member[], current: Member | undefined, next: string): string {
  const options = [
    ...members.map((m) => `<label class="chip"><input type="radio" name="member" value="${m.id}"${m.id === current?.id ? " checked" : ""} /> ${memberChip(m)}</label>`),
    `<label class="chip"><input type="radio" name="member" value=""${current ? "" : " checked"} /> ${t(lang, "member.nobody")}</label>`,
  ].join("\n  ");
  const add = members.length === 0 ? `<p><a class="button" href="/members">${t(lang, "member.addFirst")}</a></p>` : "";
  const body = `<header class="page-head"><h1>${t(lang, "member.meTitle")}</h1></header>
<p class="muted">${t(lang, "member.meIntro")}</p>
<form method="post" action="/me">
  <input type="hidden" name="next" value="${escapeHtml(next)}" />
  ${options}
  <div class="actions"><button type="submit" class="primary">${t(lang, "common.save")}</button></div>
</form>
${add}`;
  return page({ title: t(lang, "member.meTitle"), body, lang, tab: "more" });
}

export const memberRoutes: FeaturePlugin = async (app, { db }) => {
  const html = (reply: { type(t: string): unknown }) => reply.type("text/html; charset=utf-8");

  app.get("/members", async (req, reply) => {
    html(reply);
    return listPage(langOf(req), listMembers(db), memberOf(req, db));
  });

  app.post<{ Body: MemberForm }>("/members", async (req, reply) => {
    const input = parseMemberForm(req.body ?? {});
    if (!input) {
      html(reply.code(400));
      return listPage(langOf(req), listMembers(db), memberOf(req, db), t(langOf(req), "member.invalid"));
    }
    createMember(db, input);
    return reply.redirect("/members", 303);
  });

  app.get<{ Params: MemberParams }>("/members/:id/edit", async (req, reply) => {
    const member = getMember(db, Number(req.params.id));
    if (!member) return reply.code(404).send(t(langOf(req), "member.notFound"));
    html(reply);
    return editPage(langOf(req), member);
  });

  app.post<{ Params: MemberParams; Body: MemberForm }>("/members/:id", async (req, reply) => {
    const member = getMember(db, Number(req.params.id));
    if (!member) return reply.code(404).send(t(langOf(req), "member.notFound"));
    const input = parseMemberForm(req.body ?? {});
    if (!input) {
      html(reply.code(400));
      return editPage(langOf(req), member, t(langOf(req), "member.invalid"));
    }
    updateMember(db, member.id, input);
    return reply.redirect("/members", 303);
  });

  app.post<{ Params: MemberParams }>("/members/:id/delete", async (req, reply) => {
    const id = Number(req.params.id);
    deleteMember(db, id);
    // A device that was this Member's forgets it at once.
    if (memberOf(req, db) === undefined && req.headers.cookie?.includes(`member=${id}`)) reply.header("set-cookie", memberCookie(undefined));
    return reply.redirect("/members", 303);
  });

  app.get<{ Querystring: { next?: string } }>("/me", async (req, reply) => {
    html(reply);
    return mePage(langOf(req), listMembers(db), memberOf(req, db), safePath(req.query.next) ?? "/more");
  });

  app.post<{ Body: MeForm }>("/me", async (req, reply) => {
    const raw = req.body?.member?.trim() ?? "";
    const id = raw === "" ? undefined : Number(raw);
    if (id !== undefined && !getMember(db, id)) return reply.code(400).send(t(langOf(req), "member.notFound"));
    reply.header("set-cookie", memberCookie(id));
    return reply.redirect(safePath(req.body?.next) ?? "/more", 303);
  });
};
