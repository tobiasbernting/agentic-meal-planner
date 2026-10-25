import { describe, expect, it } from "vitest";
import { describeRepeat, nextDue, parseRepeat } from "./repeat.js";

describe("nextDue", () => {
  it("advances a day, skips weekends, and finds the next listed weekday", () => {
    expect(nextDue({ kind: "daily" }, "2026-10-31")).toBe("2026-11-01");
    expect(nextDue({ kind: "weekdays" }, "2026-10-30")).toBe("2026-11-02"); // Friday → Monday
    expect(nextDue({ kind: "weekly", weekdays: ["mon", "wed"] }, "2026-10-26")).toBe("2026-10-28"); // Monday → Wednesday
    expect(nextDue({ kind: "weekly", weekdays: ["mon", "wed"] }, "2026-10-28")).toBe("2026-11-02"); // Wednesday → next Monday
    expect(nextDue({ kind: "weekly", weekdays: ["sun"] }, "2026-10-25")).toBe("2026-11-01"); // same weekday: a week later
  });

  it("every N weeks and yearly, across a year end and a leap day", () => {
    expect(nextDue({ kind: "every_n_weeks", n: 2 }, "2026-12-28")).toBe("2027-01-11");
    expect(nextDue({ kind: "yearly" }, "2026-06-15")).toBe("2027-06-15");
    expect(nextDue({ kind: "yearly" }, "2028-02-29")).toBe("2029-02-28");
  });

  it("monthly keeps the rule's day, clamping to short months and recovering after", () => {
    expect(nextDue({ kind: "monthly", day: 31 }, "2026-03-31")).toBe("2026-04-30");
    expect(nextDue({ kind: "monthly", day: 31 }, "2026-04-30")).toBe("2026-05-31");
    expect(nextDue({ kind: "monthly", day: 5 }, "2026-12-05")).toBe("2027-01-05");
    expect(nextDue({ kind: "monthly", day: 30 }, "2027-01-30")).toBe("2027-02-28");
  });
});

describe("describeRepeat", () => {
  it("speaks both languages", () => {
    expect(describeRepeat({ kind: "weekly", weekdays: ["mon", "wed"] }, "sv")).toBe("varje måndag och onsdag");
    expect(describeRepeat({ kind: "weekly", weekdays: ["mon", "wed", "fri"] }, "en")).toBe("every monday, wednesday and friday");
    expect(describeRepeat({ kind: "every_n_weeks", n: 2 }, "en")).toBe("every other week");
    expect(describeRepeat({ kind: "every_n_weeks", n: 3 }, "sv")).toBe("var 3:e vecka");
    expect(describeRepeat({ kind: "monthly", day: 22 }, "en")).toBe("monthly on the 22nd");
    expect(describeRepeat({ kind: "monthly", day: 1 }, "sv")).toBe("den 1:e varje månad");
    expect(describeRepeat({ kind: "weekdays" }, "en")).toBe("every weekday");
    expect(describeRepeat({ kind: "yearly" }, "sv")).toBe("varje år");
  });
});

describe("parseRepeat", () => {
  it("reads stored rules and rejects malformed ones as no Repeat", () => {
    expect(parseRepeat('{"kind":"weekly","weekdays":["mon","xyz"]}')).toEqual({ kind: "weekly", weekdays: ["mon"] });
    expect(parseRepeat('{"kind":"weekly","weekdays":[]}')).toBeNull();
    expect(parseRepeat('{"kind":"every_n_weeks","n":1}')).toBeNull();
    expect(parseRepeat('{"kind":"monthly","day":32}')).toBeNull();
    expect(parseRepeat("not json")).toBeNull();
    expect(parseRepeat(null)).toBeNull();
    expect(parseRepeat('{"kind":"daily"}')).toEqual({ kind: "daily" });
  });
});
