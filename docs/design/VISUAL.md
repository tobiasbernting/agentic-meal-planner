---
name: Almanacka
description: A printed almanac page for the household's week, in ink on paper with one red.
colors:
  paper: "#fbfaf6"
  raised: "#ffffff"
  ink: "#1a1a1a"
  red: "#c4161c"
  muted: "#6b6b63"
  rule: "#d9d7cf"
  paper-dark: "#161614"
  raised-dark: "#22211e"
  ink-dark: "#ecebe4"
  red-dark: "#ff6b6b"
  muted-dark: "#a3a29a"
  rule-dark: "#3a3934"
typography:
  week:
    fontFamily: "Libre Franklin, system-ui, sans-serif"
    fontSize: "4.5rem"
    fontWeight: 900
    lineHeight: 0.8
    letterSpacing: "-2px"
  date-today:
    fontFamily: "Libre Franklin, system-ui, sans-serif"
    fontSize: "2.375rem"
    fontWeight: 800
    lineHeight: 1
  date:
    fontFamily: "Libre Franklin, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 800
    lineHeight: 1
  dish-today:
    fontFamily: "Libre Franklin, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 800
    lineHeight: 1.05
  dish:
    fontFamily: "Libre Franklin, system-ui, sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
  body:
    fontFamily: "Libre Franklin, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.4
  lunch:
    fontFamily: "Libre Franklin, system-ui, sans-serif"
    fontSize: "0.875rem"
  label:
    fontFamily: "Libre Franklin, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    letterSpacing: "0.8px"
rounded:
  none: "0"
spacing:
  gutter: "16px"
  date-col: "68px"
  tap: "44px"
  tabbar: "58px"
components:
  button:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "8px 14px"
    height: "44px"
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  notice:
    backgroundColor: "{colors.ink}"
    textColor: "#ffffff"
    padding: "12px 14px"
  day-today:
    backgroundColor: "{colors.raised}"
---

# Almanacka: visual design

This file records the look the app shipped with (spec #71). It describes the code as it is: `public/app.css`, `src/ui/`, `src/almanac/`, `src/plan-run/banner.ts`. It is separate from `docs/DESIGN.md`, which covers architecture. The reference sketch is `docs/design/today-sketch.html`. Where the code and the sketch differ, the code wins and the difference is listed under Known deviations.

## Overview

The app is a printed almanac for one household's week. Ink on warm paper, a heavy rule under each page title, a big week number, and a date column down the left side of every day. Phones are the main screen, so the page is a single column, at most 40rem wide.

The surface is for use, not for show. Two moments matter: the daily glance at Today, and the Sunday review on Plan. Both read like a calendar page. Hierarchy comes from type size and weight, plus rules. There are no cards, shadows, rounded corners or icons.

Colour is nearly absent on purpose. Red means one thing: Sunday or a public holiday. Failures and warnings are not red. They are inverted ink blocks.

Design principles:

- The date numeral leads, then the Dish name, then the lunch line, then the rationale.
- Rules do the work that boxes do elsewhere. A 1px rule separates rows, a 2px ink rule marks the top of a page or the tab bar.
- Every control is at least 44px.
- Nothing loads from another host. Fonts and HTMX are served from `/assets/`.

## Colors

Tokens live on `:root` and are redefined under `prefers-color-scheme: dark`. Pages use the tokens or the component classes, never raw hex.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--paper` | `#fbfaf6` | `#161614` | Page background, tab bar |
| `--raised` | `#ffffff` | `#22211e` | Today's row, form inputs, chip checked state |
| `--ink` | `#1a1a1a` | `#ecebe4` | Text, heavy rules, button outlines, focus ring |
| `--red` | `#c4161c` | `#ff6b6b` | Sundays and public holidays only |
| `--muted` | `#6b6b63` | `#a3a29a` | Lunch lines, rationale, status text, labels |
| `--rule` | `#d9d7cf` | `#3a3934` | 1px row dividers, input borders |
| `--notice-bg` | `--ink` | `--ink` | Notice background |
| `--notice-fg` | `#ffffff` | `#161614` | Notice text |
| `--focus` | `--ink` | `--ink` | Focus ring |

The Member palette (ADR-0010) is eight ink-friendly tones, used only for a Member's chip dot. Red is not among them; it stays for red days. Each has a name in Swedish and English, shown beside its swatch when a colour is picked.

| Token | Light | Dark | Name (sv / en) |
|---|---|---|---|
| `--member-moss` | `#4f7a3a` | `#8fc06e` | Mossa / Moss |
| `--member-sea` | `#2f6f8f` | `#7fb8d8` | Hav / Sea |
| `--member-plum` | `#6d4a86` | `#b48ad0` | Plommon / Plum |
| `--member-clay` | `#a0522d` | `#e0906a` | Lera / Clay |
| `--member-sand` | `#a98a2a` | `#d8c060` | Sand / Sand |
| `--member-slate` | `#4f5d6e` | `#9fb0c4` | Skiffer / Slate |
| `--member-berry` | `#9c2f5a` | `#e07aa3` | Bär / Berry |
| `--member-pine` | `#2f6b5a` | `#7fc0a8` | Tall / Pine |

Rules for use:

- Red is applied to the date numeral and weekday of a `.day-red` row and to the holiday name (`.day-holiday`). It is never used for errors, buttons or links.
- Muted text is for secondary information only. It must stay readable, so it is not lightened further.
- The notice inverts with the theme. It is a dark block on light paper and a light block on dark paper. That keeps it the loudest thing on the page in both themes.
- Dark mode follows the system setting. There is no manual switch.

## Typography

One family, Libre Franklin, in four weights: 400, 600, 800, 900. The files are `public/fonts/libre-franklin-{400,600,800,900}.woff2`, built by `scripts/build-font.py` from the upstream variable font and loaded with `font-display: swap`. The fallback stack is `system-ui, -apple-system, "Segoe UI", sans-serif`.

Digits are lining and tabular (`font-variant-numeric: lining-nums tabular-nums` on `body`), so dates and minutes line up down the page.

| Token | Size | Where |
|---|---|---|
| `--fs-week` | 4.5rem, weight 900, tracking -2px | "v. 42" landmark on Plan, Shopping |
| `--fs-date-today` | 2.375rem, 800 | Date numeral of today's row |
| `--fs-date` | 1.875rem, 800 | Date numeral of other days |
| `--fs-dish-today` | 1.875rem, 800 | Today's Dish name |
| `--fs-h1` | 1.75rem, 800 | Page title on `.page-head` |
| `--fs-dish` | 1.0625rem, 600 | Dish name on other days, row labels |
| `--fs-body` | 1rem, 400 | Body text, today's lunch line |
| `--fs-lunch` | 0.875rem | Lunch line on other days |
| `--fs-small` | 0.8125rem | Status text, `.meta`, Quick Day tag |
| `--fs-label` | 0.75rem, 600, uppercase, 0.8px tracking | Weekday under the date, `h2`, `.label`, `.section-label` |

Section headings (`h2`) look like labels: small, uppercase, muted. Pages get structure from rules and spacing, not from large subheads. The only large type is the week number and the date numerals.

## Layout

- One column, `max-width: 40rem`, centred. Side gutter is `--gutter` (16px). Bottom padding clears the fixed tab bar and the iOS safe area.
- Direct children of `main` get the gutter. These run edge to edge and manage their own padding: `.page-head`, `.week-head`, `.week-nav`, `.rows`, `.day`, `.notice`.
- Day row: a two-column grid, `--date-col` (68px) for the date and `1fr` for the cell. Date numeral over weekday on the left. On the right the lunch line first, then the Dinner.
- Density has three levels, set by the caller:
  - `full` (Plan): "Lunch" label and one line per School, "Middag" label, Dish, Quick Day tag and minutes, Suggested marker, rationale, and the Byt and Recept actions.
  - `half`: lunch line, Dish at 1.25rem, meta.
  - `compact`: lunch line and Dish name only.
- Today's row is raised: `--raised` background, a 4px ink rule on the left, and larger type.
- Page header, in order: `.week-head` (week number left, month right) or `.page-head` (title), then `.week-nav` (neighbouring weeks), then notices and status, then the days or ruled rows.
- Lists are `.rows`: full-width `li` items divided by 1px rules, each at least 60px tall. A whole row is the link.
- Spacing is a few fixed values (4, 8, 12, 16, 24px) rather than a scale. Sections are separated by 24px.
- Navigation is a fixed bottom tab bar with five tabs in fixed order: Idag, Inköp, Listor, Plan, Mer (ADR-0010). Listor holds every List, the Shopping List first. Library and admin pages (Dishes, Schools, Pantry, Members, Settings, Logs) sit under Mer. Language is switched on Settings.
- A day cell carries the Todos due that day after the Dinner: every Todo with its tick in a `full` row, the first three and "+N till" in a `half` row, a count ("3 att göra") in a `compact` row. Today's row lists overdue Todos first under "Försenat".

## Elevation & Depth

Flat. There are no shadows, blurs or gradients. Depth has two sources:

- Tone: `--raised` is a step lighter than `--paper` in light mode and a step lighter in dark mode. It marks today's row and form inputs.
- Rules: the 4px left rule on today's row, the 2px rule under headers, the 2px rule above the tab bar.

The tab bar is the only fixed element. It sits at `z-index: 10` on the paper colour.

## Shapes

Square corners everywhere (`border-radius: 0`). Outlines are 1.5px ink for controls and tags, 1.5px rule colour for inputs and chips, 1px rule colour for dividers, 2px ink for headings. The Suggested marker uses a dashed 1.5px ink outline, so it reads as provisional next to the solid Quick Day tag.

## Components

**Week head.** `v.` in small type before the week number, as an `h1` with an `aria-label` ("Vecka 42"). Month and year at the right, uppercase muted.

**Week nav.** "v. 41 ‹" and "› v. 43" in a row under the week head, 44px tall, with a 1px rule below. Uses `rel=prev` and `rel=next`.

**Day row.** `<article class="day day-<density>">`, with `day-today` and `day-red` modifiers, `id="day-<date>"`, and `aria-current="date"` on today. A holiday's name opens the cell in small red caps. Empty states are plain words in muted text ("Ingen skollunch", "Ingen plan", "Ingen middag planerad"). A missing lunch on a weekday in a full row is an inverted notice, because it needs attention.

**Quick Day tag.** A box with a 1.5px ink outline: "Snabbdag max 30 min". Written as "max" because the font has no `≤`.

**Suggested marker.** Dashed-outline tag with a promote button beside it.

**Buttons.** Ink outline, transparent fill, square, at least 44px by 44px, weight 600. `.primary` is filled ink with paper text. `.quiet` has no border and is underlined, for secondary actions like Skicka igen or Recept. Disabled buttons drop to 55% opacity. Button rows use `.actions` (8px gap, wrapping).

**Inputs.** Full width, 44px minimum, raised background, 1.5px rule border that turns ink on focus. Labels sit above in 600 weight. Checkboxes and radios are 22px with ink accent. `.chip` is a 44px label around a checkbox for toggles such as Preferred Days. Checked chips get an ink border.

**Notice (inverted ink).** `notice()` in `src/ui/layout.ts`. A block with `--notice-bg` and `--notice-fg`, a bold uppercase label ("Fel", "Fas") and plain text. Use `role="alert"` for failures and `role="status"` for progress. Buttons inside it take the notice foreground colour. Inside a day cell it shrinks to a compact version. Every error message in the app uses it. Do not use red for these.

**Plan Run banner.** `#plan-run-banner.plan-run`. In flight is a notice with the phase and progress. Failed is a notice with the reason. Finished is a quiet muted line with a rule beneath. Idle is hidden. While a run is in flight, the Byt control is hidden by CSS and Recept stays.

**Swap list.** Byt expands in place into a list of eligible Dishes, each one a full-width ruled row button, with the current Dish left out.

**Ruled rows with actions.** `li.with-actions`: label, status lines, then a row of quiet buttons (Schools, Pantry).

**Section label.** `.section-label`: small bold uppercase muted text over a ruled list. Used for Köp and Kolla skafferiet on Shopping.

**Tab bar.** Five equal cells, 58px tall, 2px ink rule on top, labels short enough to fit a 360px screen. Inactive tabs are muted. The active tab is ink, weight 800, with a 2px underline, and carries `aria-current="page"`.

**Member chip.** `memberChip()` in `src/members/device.ts`: a 12px square dot in the Member's colour with a 1.5px ink border, then the Member's name in 600 weight. The name is always there, so colour is never the only signal.

**Todo row.** `li.todo` in `.rows`: the tick column of the Shopping List, the title, then a muted status line with the Due ("fre 31 okt 15:00"), the Member chip, the Repeat ("↻ varje onsdag") and, when Done, who ticked it ("Pappa 14:02"). Done rows are struck and muted and sort below the open ones. An overdue Todo says "Försenad" in words and sets its Due in 800 weight ink; it is not red.

**Quick Add marks.** The words Quick Add parsed are shown once on the new row as `<mark>` with a 2px ink underline and 700 weight, no fill, next to a quiet "behåll som text".

**Nyligen and Aktivitet.** The re-add tray is a row of quiet chips (rule outline, 400 weight) under the add row. Aktivitet is a `<details>` disclosure at the foot of a List, closed by default, with muted ruled rows.

**First-run block.** On Today before any Schools or Dishes exist: a 2px ink box with a heading and links to what is missing.

**Focus.** A 2px ink ring with 2px offset on every focusable element (inverted to the notice foreground inside a notice). On the tab bar the ring sits inside the cell.

**Motion.** Almost none. HTMX requests dim the target to 60% opacity over 120ms, and only when the user has not asked for reduced motion.

## Do's and Don'ts

Do:

- Reuse `page()`, `weekHead`, `weekNav`, `dayRow`, `almanac().day` and `notice()` before writing new markup.
- Use `.rows` for any list of things, with the whole row as the tap target.
- Say what is wrong in plain words inside a notice, and give the way out.
- Test every new page in light and dark, and add it to `PAGES` in `src/ui/shell.test.ts`.
- Add Swedish and English strings for every new piece of text.

Don't:

- Don't use red for anything but Sundays and public holidays.
- Don't add cards, shadows, rounded corners, gradients or icons.
- Don't write raw colours in components. Use the tokens.
- Don't write "≤" in copy. The font lacks it. Write "max 30 min".
- Don't shrink a tap target under 44px.
- Don't load fonts, scripts or styles from another host.
- Don't hide status behind colour alone. Pair it with a label or a word.

## Known deviations from the spec and sketch

- **Muted colour.** The sketch uses `#7a7a72` on paper, which is 4.1:1 and fails WCAG AA. The shipped `--muted` is `#6b6b63`, which passes. Dark mode uses `#a3a29a`.
- **Tabular digits.** Libre Franklin has no `tnum` feature. `scripts/build-font.py` gives digits 0-9 one shared advance width in the built files, so figures are tabular by default and `font-variant-numeric: tabular-nums` has no extra effect.
- **No `≤` glyph.** The font build has no `≤`, so copy says "max 30 min".
- **Language switch.** The sketch's header switch moved to Settings (Språk).
