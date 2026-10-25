import { describe, expect, it } from "vitest";
import { enhanceQuickAdd, parseQuickAdd, type QuickAddContext } from "./quick-add.js";

// Wednesday.
const TODAY = "2026-10-21";
const members = [
  { id: 1, name: "Mamma" },
  { id: 2, name: "Pappa" },
  { id: 3, name: "Fredag" },
  { id: 4, name: "Mormor Eva" },
  { id: 5, name: "Mormor" },
];
const sv: QuickAddContext = { lang: "sv", today: TODAY, members };
const en: QuickAddContext = { lang: "en", today: TODAY, members };

/** The parse without spans, for compact expectations. */
function fields(text: string, ctx: QuickAddContext) {
  const { spans: _spans, ...rest } = parseQuickAdd(text, ctx);
  return rest;
}

/** The matched words, in text order. */
function marked(text: string, ctx: QuickAddContext): string[] {
  return parseQuickAdd(text, ctx).spans.map((s) => text.slice(s.start, s.end));
}

describe("parseQuickAdd in Swedish", () => {
  it("parses the spec's example: title, Due next Friday 15:00, Mamma, three spans", () => {
    const text = "Boka tandläkare Ella fredag kl 15 @Mamma";
    expect(fields(text, sv)).toEqual({ title: "Boka tandläkare Ella", dueDate: "2026-10-23", dueTime: "15:00", repeat: null, memberId: 1 });
    expect(marked(text, sv)).toEqual(["fredag", "kl 15", "@Mamma"]);
  });

  it.each([
    ["Handla idag", "2026-10-21"],
    ["Handla i dag", "2026-10-21"],
    ["Handla imorgon", "2026-10-22"],
    ["Handla i morgon", "2026-10-22"],
    ["Handla i övermorgon", "2026-10-23"],
    ["Handla måndag", "2026-10-26"],
    ["Handla tis", "2026-10-27"],
    ["Handla tisdag", "2026-10-27"],
    ["Handla tors", "2026-10-22"],
    ["Handla tor", "2026-10-22"],
    ["Handla på fredag", "2026-10-23"],
    ["Handla lör", "2026-10-24"],
    ["Handla söndag", "2026-10-25"],
    ["Handla 24/12", "2026-12-24"],
    ["Handla 1/3", "2027-03-01"],
    ["Handla 5/1-2027", "2027-01-05"],
  ])("%s sets Due %s", (text, date) => {
    expect(fields(text, sv)).toMatchObject({ title: "Handla", dueDate: date, dueTime: null });
  });

  it("reads a weekday equal to today as next week", () => {
    expect(fields("Soptunnan onsdag", sv).dueDate).toBe("2026-10-28");
    expect(fields("Soptunnan ons", sv).dueDate).toBe("2026-10-28");
  });

  it.each([
    ["Ring kl 9", "09:00"],
    ["Ring kl 9:30", "09:30"],
    ["Ring kl. 17.45", "17:45"],
    ["Ring 18:05", "18:05"],
  ])("%s sets time %s, today", (text, time) => {
    expect(fields(text, sv)).toMatchObject({ title: "Ring", dueDate: TODAY, dueTime: time });
  });

  it("reads a date and a time together, in either order", () => {
    expect(fields("Hämta Ella imorgon kl 15", sv)).toMatchObject({ title: "Hämta Ella", dueDate: "2026-10-22", dueTime: "15:00" });
    expect(fields("Hämta Ella 15:00 24/12", sv)).toMatchObject({ title: "Hämta Ella", dueDate: "2026-12-24", dueTime: "15:00" });
  });

  it.each([
    ["Vattna varje dag", { kind: "daily" }, TODAY],
    ["Läxor varje vardag", { kind: "weekdays" }, TODAY],
    ["Soptunnan varje onsdag", { kind: "weekly", weekdays: ["wed"] }, TODAY],
    ["Träning varje måndag och torsdag", { kind: "weekly", weekdays: ["mon", "thu"] }, "2026-10-22"],
    ["Städa varje mån, ons och fre", { kind: "weekly", weekdays: ["mon", "wed", "fri"] }, TODAY],
    ["Byta lakan varannan vecka", { kind: "every_n_weeks", n: 2 }, TODAY],
    ["Hyran varje månad den 25", { kind: "monthly", day: 25 }, "2026-10-25"],
    ["Hyran varje månad den 5:e", { kind: "monthly", day: 5 }, "2026-11-05"],
    ["Deklarera varje år", { kind: "yearly" }, TODAY],
  ])("%s repeats", (text, repeat, dueDate) => {
    const parsed = fields(text, sv);
    expect(parsed.repeat).toEqual(repeat);
    expect(parsed.dueDate).toBe(dueDate);
    expect(parsed.title).not.toMatch(/varje|varannan/);
  });

  it("lets a Repeat keep a typed date as its anchor", () => {
    expect(fields("Soptunnan varje onsdag 28/10", sv)).toMatchObject({ title: "Soptunnan", dueDate: "2026-10-28", repeat: { kind: "weekly", weekdays: ["wed"] } });
  });

  it("takes the longest Member name after an @, case-insensitive, and leaves a Member's name without @ as text", () => {
    expect(fields("Ring @mormor eva", sv)).toMatchObject({ title: "Ring", memberId: 4 });
    expect(fields("Ring @Mormor", sv)).toMatchObject({ title: "Ring", memberId: 5 });
    expect(fields("Ring mamma @PAPPA", sv)).toMatchObject({ title: "Ring mamma", memberId: 2 });
    expect(fields("Mata katten @Fredag", sv)).toMatchObject({ title: "Mata katten", dueDate: null, memberId: 3 });
    expect(fields("Ring @Okänd", sv)).toMatchObject({ title: "Ring @Okänd", memberId: null });
    expect(fields("mejla x@mamma.se", sv)).toMatchObject({ memberId: null });
  });

  it("keeps the first of two dates and leaves the second as text", () => {
    expect(fields("Möte fredag imorgon", sv)).toMatchObject({ title: "Möte imorgon", dueDate: "2026-10-23" });
  });

  it("does not take tokens inside words", () => {
    expect(fields("Städa i dagis", sv)).toEqual({ title: "Städa i dagis", dueDate: null, dueTime: null, repeat: null, memberId: null });
    expect(fields("Köp fredagsmys", sv).dueDate).toBeNull();
    expect(fields("Torsk till middag", sv).dueDate).toBeNull();
  });

  it("parses nothing from a phrase with no tokens, or rejects impossible dates and times", () => {
    expect(parseQuickAdd("Köp mjölk", sv)).toEqual({ title: "Köp mjölk", dueDate: null, dueTime: null, repeat: null, memberId: null, spans: [] });
    expect(fields("Köp 31/2", sv).dueDate).toBeNull();
    expect(fields("Ring kl 25", sv).dueTime).toBeNull();
  });

  it("keeps the phrase whole when nothing would be left of the title", () => {
    expect(parseQuickAdd("imorgon", sv)).toEqual({ title: "imorgon", dueDate: null, dueTime: null, repeat: null, memberId: null, spans: [] });
  });

  it("collapses whitespace where spans were removed", () => {
    expect(fields("  Boka   imorgon   tid  ", sv).title).toBe("Boka tid");
  });
});

describe("parseQuickAdd in English", () => {
  it.each([
    ["Shop today", "2026-10-21"],
    ["Shop tomorrow", "2026-10-22"],
    ["Shop friday", "2026-10-23"],
    ["Shop on Monday", "2026-10-26"],
    ["Shop wednesday", "2026-10-28"],
    ["Shop 24/12", "2026-12-24"],
  ])("%s sets Due %s", (text, date) => {
    expect(fields(text, en)).toMatchObject({ title: "Shop", dueDate: date });
  });

  it.each([
    ["Call at 5pm", "17:00"],
    ["Call at 12am", "00:00"],
    ["Call at 7:30am", "07:30"],
    ["Call at 17:00", "17:00"],
    ["Call 9pm", "21:00"],
    ["Call 08:15", "08:15"],
  ])("%s sets time %s", (text, time) => {
    expect(fields(text, en)).toMatchObject({ title: "Call", dueDate: TODAY, dueTime: time });
  });

  it.each([
    ["Water every day", { kind: "daily" }],
    ["Water daily", { kind: "daily" }],
    ["Homework weekdays", { kind: "weekdays" }],
    ["Homework every weekday", { kind: "weekdays" }],
    ["Gym every monday and wednesday", { kind: "weekly", weekdays: ["mon", "wed"] }],
    ["Sheets every other week", { kind: "every_n_weeks", n: 2 }],
    ["Rent monthly on the 5th", { kind: "monthly", day: 5 }],
    ["Taxes yearly", { kind: "yearly" }],
    ["Taxes every year", { kind: "yearly" }],
  ])("%s repeats", (text, repeat) => {
    expect(fields(text, en).repeat).toEqual(repeat);
  });

  it("reads the spec's example in English with @Name", () => {
    const text = "Book dentist friday at 3pm @Mamma";
    expect(fields(text, en)).toEqual({ title: "Book dentist", dueDate: "2026-10-23", dueTime: "15:00", repeat: null, memberId: 1 });
    expect(marked(text, en)).toEqual(["friday", "at 3pm", "@Mamma"]);
  });

  it("leaves Swedish words as text in English and English three-letter days as words", () => {
    expect(fields("Köp fredag", en).dueDate).toBeNull();
    expect(fields("Sat down wed", en).dueDate).toBeNull();
  });
});

describe("enhanceQuickAdd", () => {
  it("is a no-op seam", async () => {
    const parsed = parseQuickAdd("Köp mjölk imorgon", sv);
    expect(await enhanceQuickAdd(parsed, "Köp mjölk imorgon", sv)).toBe(parsed);
  });
});
