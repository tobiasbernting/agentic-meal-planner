# One living Shopping List with per-dinner Shares

---
Status: Accepted (owner, 2026-10-18)
---

Both parents tick the Shopping List on their phones in the store (ADR-0008). Until now the list was per Weekly Plan: a Plan Run rebuilt the week's rows, and Checked Off, Extra Item and Removed Line were keyed by week and ingredient name so the rebuild would not touch them. That shape breaks at the week boundary (a Sunday shop for Monday, extras added mid-week) and has no precedent: of seven shared grocery apps surveyed, none resets a list per week, and ticked lines stay struck until an explicit clear in every app that documents clearing (see `docs/research/2026-10-18-shared-grocery-list-models.md`).

We replace it with one living Shopping List. A line is keyed by normalised Ingredient name and holds Shares, one per Planned Dinner, following AnyList's recipe model: quantity is the sum of Shares, a Swap withdraws one Share instead of rebuilding the list, and a line with no Shares left is deleted if unticked and kept if ticked. A Plan Run adds Shares only for Planned Dinners it has not pushed before, and never deletes a line or clears a tick. Lines leave the list only through two household actions, Delete (one line) and Clear (every Checked Off line). Because a pushed Share never returns, a deleted or cleared line survives any re-run without a tombstone, which is why Removed Line is gone from the glossary. Ticks are last-write-wins per line, unattributed, and a tick on a line that no longer exists is a silent no-op.

Considered and rejected:
- **Per-week lists with carry-forward of unticked lines.** Smallest change to the current keys, but two lists are live around the boundary and no surveyed app works this way.
- **Living list with week tags on each line.** Re-runs stay safe by tag, but the same Ingredient wanted by two weeks needs the Share merge rules anyway, plus tag bookkeeping. Shares give the same safety with one mechanism.
- **Tick as removal into a recently-used tray (Bring!).** Keeps the aisle view short, but with two shoppers a struck line is what tells the other one the item is already in the basket.
- **Automatic clear on the next Plan Run.** Would wipe Sunday's ticks before Monday's shop is unpacked. No surveyed app clears automatically.

Consequences: Shares are computed once, so a Recipe re-extraction or an Adaptation edit after the push does not change the list; the household edits the line by hand. A Dish-derived line's quantity is not editable, a hand-added one's is. Lines do not age out; stale ones from an abandoned week are deleted by hand, and the line's provenance (Dish and date) makes them easy to spot. The "Shopping List push" Phase becomes "Shopping List update". The old per-week tables migrate once at startup through `runOnce`: the latest built plan's rows become Shares, its ticks and Extra Items carry over, its Removed Lines are skipped once, and older weeks' edits are dropped. A tick in a dead zone fails visibly and is retried by hand until #110 brings HTTPS and the service worker back.
