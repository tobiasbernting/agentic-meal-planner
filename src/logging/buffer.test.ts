import { describe, expect, it } from "vitest";
import { LogBuffer } from "./buffer.js";

describe("LogBuffer", () => {
  it("keeps the most recent records up to its capacity, oldest first", () => {
    const buffer = new LogBuffer(3);
    for (const n of [1, 2, 3, 4, 5]) buffer.push({ msg: `m${n}` });

    expect(buffer.snapshot().map((r) => r.msg)).toEqual(["m3", "m4", "m5"]);
  });

  it("holds 2000 records by default", () => {
    const buffer = new LogBuffer();
    for (let n = 0; n < 2005; n++) buffer.push({ n });

    const records = buffer.snapshot();
    expect(records).toHaveLength(2000);
    expect(records[0]).toEqual({ n: 5 });
  });

  it("notifies subscribers of each new record until they unsubscribe", () => {
    const buffer = new LogBuffer();
    const seen: unknown[] = [];
    const unsubscribe = buffer.subscribe((r) => seen.push(r.msg));

    buffer.push({ msg: "a" });
    unsubscribe();
    buffer.push({ msg: "b" });

    expect(seen).toEqual(["a"]);
  });
});
