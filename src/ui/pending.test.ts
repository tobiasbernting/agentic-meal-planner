import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

/** Just enough of an element for public/pending.js: tag, attributes, dataset, text and ancestry. */
class FakeElement {
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  disabled = false;
  constructor(
    public tagName: string,
    public textContent = "",
    public parent: FakeElement | null = null,
  ) {}
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  removeAttribute(name: string) {
    this.attributes.delete(name);
  }
  /** Supports the selectors pending.js uses: a tag name or `[attr]`. */
  closest(selector: string): FakeElement | null {
    const attr = /^\[([\w-]+)\]$/.exec(selector)?.[1];
    for (let el: FakeElement | null = this; el; el = el.parent) {
      if (attr ? el.attributes.has(attr) : el.tagName === selector.toUpperCase()) return el;
    }
    return null;
  }
}

function loadPending() {
  const listeners = new Map<string, (event: unknown) => void>();
  const on = (type: string, fn: (event: unknown) => void) => listeners.set(type, fn);
  const source = readFileSync(join(import.meta.dirname, "../../public/pending.js"), "utf8");
  runInNewContext(source, {
    document: { addEventListener: on, querySelectorAll: () => [] },
    window: { addEventListener: on },
    setTimeout: (fn: () => void) => fn(),
  });
  return (type: string, event: unknown) => listeners.get(type)!(event);
}

describe("pending.js on an HTMX link outside a form (Byt, Välj rätt)", () => {
  it("marks the region it updates busy for the request and clears it after", () => {
    const fire = loadPending();
    const body = new FakeElement("BODY");
    body.setAttribute("data-working-label", "Arbetar…");
    const day = new FakeElement("LI", "", body);
    const swap = new FakeElement("A", "Byt", day);

    fire("htmx:beforeRequest", { detail: { elt: swap, target: day } });
    const during = { busy: day.getAttribute("aria-busy"), text: swap.textContent };
    fire("htmx:afterRequest", { detail: { elt: swap, target: day } });

    expect(during).toEqual({ busy: "true", text: "Arbetar…" });
    expect(day.getAttribute("aria-busy")).toBeNull();
    expect(swap.textContent).toBe("Byt");
  });

  it("marks the element itself busy when the request names no target", () => {
    const fire = loadPending();
    const choose = new FakeElement("BUTTON", "Välj rätt");

    fire("htmx:beforeRequest", { detail: { elt: choose } });
    const during = choose.getAttribute("aria-busy");
    fire("htmx:afterRequest", { detail: { elt: choose } });

    expect(during).toBe("true");
    expect(choose.getAttribute("aria-busy")).toBeNull();
  });
});
