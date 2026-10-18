---
target: the offline saved page after an edit made offline
total_score: 13
max_score: 36
na_heuristics: 10
p0_count: 2
p1_count: 1
target_identity: "file:/Users/utb/repos/meal-planner/.claude/worktrees/offline-first/src/offline/routes.ts"
target_fingerprint: "sha256:b71ea512ae53855ab823b2ffa4ba085040884ded2a5156678277646789a513af"
target_path: /Users/utb/repos/meal-planner/.claude/worktrees/offline-first/src/offline/routes.ts
timestamp: 2026-10-17T17-42-21Z
slug: src-offline-routes-ts
---
# Critique: the offline "saved" page and the edit round trip

Method: dual-agent (A: design review, B: detector scan). Target: src/offline/routes.ts (frame), public/offline/core.js (queueable-write), src/shopping/view.ts, public/offline/page.js.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 1 | "Sparat" shows on a page you leave; the list never shows the tick |
| 2 | Match System / Real World | 2 | "synkas", "ändring väntar" is system talk |
| 3 | User Control and Freedom | 1 | Undo buried in the badge as "Ta bort"; offline untick impossible |
| 4 | Consistency and Standards | 1 | Same tap differs online and offline; wrong tab; data-online="1" |
| 5 | Error Prevention | 2 | Duplicate ticks and removes queue easily |
| 6 | Recognition Rather Than Recall | 1 | Must remember which lines are ticked |
| 7 | Flexibility and Efficiency | 0 | Two page loads per tick |
| 8 | Aesthetic and Minimalist Design | 3 | Quiet, one sentence too many |
| 9 | Error Recovery | 2 | Failed replays show a reason |
| 10 | Help and Documentation | n/a | A tick needs no help |
| Total | | 13/36 | Poor |

## Design Specificity Verdict

Generic: the saved page names nothing, has no heading, the sentence is the title, and it sits under the Idag tab. Online a tick is a 303 back to the list with the line struck through; offline it is a detour returning to an unchanged list. Detector: source clean; one flat-type-hierarchy artifact on the rendered Shopping copy (stylesheet not resolved), a false positive.

## Priority Issues

- [P0] The Offline Copy does not show Pending Changes. Fix: overlay the queue onto the copy of Shopping (toggle line-checked, <s>, aria-pressed and the form action; hide removed lines; append pending Extra Items), keyed on a data-line attribute, in the worker or in offline-page.js. A per-line "väntar" mark replaces the global confirmation.
- [P0] A tick answers with a page instead of staying on the list. Fix: queueable writes from a copied page answer 303 Location: <referrer>; or hx-post per line with the worker returning the re-rendered <li>.
- [P1] "Saved" feedback in the wrong place. Fix: a polite role="status" live region in the offline banner ("Mjölk bockad, skickas hemma"); fold the count into the banner line.
- [P2] The saved frame is mis-shelled (tab today, sentence as title, no h1, data-online="1"). Keep it only for non-list contexts, with the referrer's tab and a short title.
- [P2] Discard label "Ta bort" collides with the line's remove. Rename to "Ångra".

## Persona Red Flags

Casey: small mid-page Tillbaka link, dead end when interrupted, no browser back in standalone mode. Alex: 40 navigations for 20 ticks, duplicate checks. Sam: sentence title, no heading, aria-pressed contradicts the announcement, badge without live region.

## Minor Observations

Badge note repeats the saved sentence in other words; the badge toggle is easy to miss; remove and Extra Item have the same invisibility problem.

## Questions to Consider

Would "väntar" be needed at the store if the copy rendered Pending Changes? Why does a tick need the network at all? Was out-of-scope optimistic rendering a cost or a correctness decision?
