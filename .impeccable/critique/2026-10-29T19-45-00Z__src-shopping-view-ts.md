---
target: the Shopping List page (Inköp) at the store, on a phone
total_score: 14
max_score: 36
na_heuristics: 10
p0_count: 2
p1_count: 3
target_identity: "file:src/shopping/view.ts"
target_fingerprint: "sha256:feed9cf23264a7c60a6265abaf858d022c6ea470ae4f7767a5609085af1dc64b"
target_path: src/shopping/view.ts
timestamp: 2026-10-29T19-45-00Z
slug: src-shopping-view-ts
---
# Critique: the Shopping List in the store

Method: live run at 390×844 (iPhone-class, touch) with a seeded household: 7 dinners Mon–Sun, 7 Pantry Items, 4 hand-added lines, 4 lines ticked by Pappa. That gave 32 Köp lines and 7 Kolla skafferiet lines. Flows driven: first screen, tick, Har alltid hemma and Ångra, hand-add, Clear and Nyligen. Targets: src/shopping/view.ts, src/shopping/routes.ts, public/app.css (tab bar, `.line`).

Measured: the page is 4086px tall. Each Köp line is about 131px tall, so 6 lines fit on the first screen. The tab bar is 118px tall. The add row starts at y≈3770.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 1 | A tick sends the line to the bottom; after an add the new line is off screen; no "N kvar" |
| 2 | Match System / Real World | 2 | List follows dinner order, not the store; "1 st citron", "1100 g" |
| 3 | User Control and Freedom | 2 | Nyligen and Ångra exist, but Ångra vanishes after 6 s |
| 4 | Consistency and Standards | 1 | 5 tabs in a 4-column grid; Clear says "går inte att ångra" while Nyligen restores everything |
| 5 | Error Prevention | 2 | Har alltid hemma (changes future Plan Runs) sits one thumb-width from Ta bort on every line |
| 6 | Recognition Rather Than Recall | 2 | Autocomplete on add is good; provenance is there but verbose |
| 7 | Flexibility and Efficiency | 1 | 6 lines per screen; add row 3770px down; every add is a full reload |
| 8 | Aesthetic and Minimalist Design | 1 | Two text actions repeated on 32 lines take more width than the item name |
| 9 | Error Recovery | 2 | Deleted and Cleared lines come back from Nyligen, but without their quantity |
| 10 | Help and Documentation | n/a | A shopping list needs no help |
| Total | | 14/36 | Poor |

## Design Specificity Verdict

The page shows everything the list knows, all the time. It does not lead with the one thing the store needs: what is left to put in the basket, in the order you walk past it. Shopping mode (tick, glance, next) and management mode (pantry rules, delete, add, sinks, activity) share one undifferentiated scroll. Management wins on space: 135px for "Har alltid hemma" plus 74px for "Ta bort" on every line squeeze the name to about 150px. That is why "1100 g / nötfärs" and "140 g / bacon" break over two lines.

## Priority Issues

- [P0] **The tab bar wraps onto two rows.** `.tabbar` is `grid-template-columns: repeat(4, 1fr)`, but there have been five tabs since Listor arrived. "Mer" sits alone on a second row. The bar is 118px tall, a seventh of the screen, while `main` reserves only `--tabbar-h` (58px) + 24px. So the last ~36px of every page hides behind it on every tab, not just this one. Fix: `repeat(5, 1fr)` (public/app.css:214). This is a one-line fix and the cheapest win in this list.
- [P0] **Management actions crowd out the list.** "Har alltid hemma" and "Ta bort" are full-width text buttons on all 32 Köp lines, and "Ta bort" is on all 7 pantry lines too. Lines become 131px tall, a 39-line list is 4000px, and in the store you scroll past 64 action links you won't use. Fix: a line in the store is tick + name/quantity + one quiet provenance line. Move both actions behind the line. Options: a "…" disclosure per line, a swipe, or one "Redigera" toggle at the top of the list that reveals them on all lines. That should bring lines down to ~56–64px and fit ~11 on a screen.
- [P1] **A tick makes the line vanish from under your thumb.** `checkedLast` re-sorts on every render, and the HTMX swap replaces `#shopping-lists`. The ticked line jumps to the end of its section, which can be 25 lines away. You get no confirmation where you tapped, and a mis-tick is hard to find. The outerHTML swap also drops focus to `<body>` for keyboard and screen-reader users. Fix: leave a ticked line in place, struck through, until the page next loads. Or fade it and collapse it into an "I korgen (N)" group at the section end. Swap the single `<li>` rather than the whole wrapper, so focus stays on the tick.
- [P1] **The order is the dinner order, not the store's.** Köp lists nötfärs, tacoskal, gräddfil, bacon, ägg, parmesan, laxfilé, potatis… as the Plan Run met them. Produce, dairy and meat are interleaved, so every aisle means scanning the whole list again. Fix: group Köp by store section (Frukt & grönt, Kött & fisk, Mejeri, Bröd, Skafferi, Fryst, Övrigt). Assign sections with a small deterministic Swedish/English keyword map, with the agent as a cached fallback per Ingredient name. This matches the product rule that hard structure is deterministic. Hand-added lines get the same lookup.
- [P1] **Har alltid hemma is a one-tap change to every future plan.** It creates a Pantry Item, so the ingredient never lands in Köp again. Yet it looks and sits like a peer of Ta bort, next to the tick column, on a phone held one-handed in a store. Its Ångra lives 6 seconds (`hx-trigger="load delay:6s"`) and then disappears, with no trace on the page. Fix: move it into the line's menu (see P0). Keep Ångra in a status line until the next edit, e.g. "gräddfil räknas nu som skafferi · Ångra".
- [P2] **Adding a line is far away and loses your place.** The add row is at y≈3770, after every line. It is a plain form POST with a 303 to `/shopping`, so you land back at scrollY 0. The new line is appended near the end of Köp, out of view, so you can't confirm it went in. On a phone the name and quantity are two fields. Fix: put a single add field at the top of the list, under the title. Parse "2 l mjölk" with the same deterministic approach as Quick Add. Use `hx-post` that swaps the sections and keeps focus in the field for the next item.
- [P2] **Clear asks about something that can be undone.** The confirmation page says "Det går inte att ångra", yet right after Clear, Nyligen offers every cleared line back with one tap. That is a full page, plus a confirmation, for a reversible action. Fix: clear inline and show "5 rader rensade · Ångra" (or point to Nyligen). At minimum, fix the copy.
- [P2] **The week header leads a list that has no week.** "v. 44 / OKTOBER 2026" takes the top ~88px. The Shopping List is one living list (ADR-0009), so the week answers no question here. Fix: a compact title with progress, e.g. "Inköp · 28 kvar av 32". Make it sticky so the count stays visible while you shop.
- [P3] **Quantities read like a database.** "1 st citron", "12 st tacoskal" and "4 st ägg" carry a redundant "st", and "1100 g nötfärs" should read "1,1 kg". The provenance line runs to two or three lines ("till: Ugnsbakad lax med potatis (ons 28 okt), Hemgjord pizza (sön 1 nov)"). Weekday + dish ("lax ons · pizza sön") is enough in the store.
- [P3] **Nyligen chips drop the planned quantity.** Clearing "12 st tacoskal" stores the item's own quantity, which is null for a planned line because the amount lives in its Shares. So the chip and the re-added line say just "tacoskal".

## Persona Red Flags

Alex (one hand, trolley, in a hurry): 6 lines per screen, an aisle-by-aisle rescan of 4000px, and a ticked line that jumps away. "Ta bort" and "Har alltid hemma" are the widest tap targets on every line, so they are the easiest to hit by mistake.

Casey (other parent, adds "mjölk" between meetings): has to scroll to the bottom, fill two fields, then lands at the top without seeing the line.

Sam (screen reader): every tick replaces the whole list and focus falls to `<body>`. The Ångra that appears and self-removes after 6 s is never announced.

## Minor Observations

Kolla skafferiet lines use the same tick as Köp, but it is unclear what ticking means there ("I have it" vs "I bought it"). The section label "KÖP" is the smallest text on the screen, for the section that matters most. "Ingen mottagare inställd" is fine, but it sits in the shopping flow and could live in Mer.

## Questions to Consider

What if the Inköp tab opened in a "store mode" (tick only, grouped by aisle, sticky count) and everything else sat behind one "Redigera"? Does Kolla skafferiet need ticks at all, or is it a checklist you read before leaving home? Would anyone miss the full-page Clear confirmation if Clear were inline with Ångra?
