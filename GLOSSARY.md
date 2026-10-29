# Meal Planner

The domain language for a household dinner planner that works around kids' school lunches and produces a weekly shopping list.

## Language

### Dishes and recipes

**Dish**:
A named dinner the household eats. May link to a Recipe and carry a prep-time tag.
_Avoid_: meal, dinner recipe

**Favorite Dish**:
A Dish the household has put in its rotation. The Weekly Plan prefers Favorite Dishes; a Suggested Dish fills a date where none is eligible. A Dish that is neither in rotation nor suggested is kept but never planned.
_Avoid_: saved recipe, bookmark

**Suggested Dish**:
A Dish the Planner Agent proposed for a dinner date where no Favorite Dish was eligible, drawn from family-friendly home cooking in the household's chosen style. Kept as a Dish outside the rotation until the household adds it to its favorites. Still bound by every hard rule.
_Avoid_: fallback dish, generated dish, placeholder

**Preferred Days**:
The weekdays a Favorite Dish is soft-favoured on ("burgers on Friday and Saturday"). Never blocks a Dish; a move off its preferred days earns a rationale.
_Avoid_: fixed day, schedule

**Weekend Dish**:
A Favorite Dish that may only be planned on Saturday or Sunday ("tacos on weekends"). A hard rule, not a preference.
_Avoid_: weekend dinner (ambiguous with a dinner on a weekend date), weekend flag

**Recipe**:
Cooking instructions and an ingredient list, usually living at an external URL the Dish points to.
_Avoid_: instructions, cooking page

**Ingredient**:
A single line item a Dish requires, optionally with quantity and unit. Comes from the Dish's manual entries or from its Recipe. Named as it would be bought ("mjölk"), in the household's language; how it is used ("till mos", "smält") is its Preparation Note.
_Avoid_: item, product

**Preparation Note**:
How a Dish uses an Ingredient ("till mos", "smält"). Shown with the Dish, never on the Shopping List, so the same Ingredient from several Dishes merges into one line.
_Avoid_: comment, remark

**Adaptation**:
A household's standing modification to a Dish ("no chili — the kids"), applied to whatever source the Dish's Ingredients came from.
_Avoid_: tweak, note

**Main Category**:
The broad food group a Dish or Lunch Entry belongs to, drawn from a fixed list, used to avoid serving the same kind of food the kids had for lunch. Each category has a stable identity and is shown under a Swedish or English label; the label is presentation, not identity. "Other" means uncategorised and never triggers a collision.
_Avoid_: cuisine, type, free-text category

### School lunches

**School**:
A source of kids' lunch menus, identified by one published menu URL. A household can have several Schools, since its kids may attend different ones.
_Avoid_: canteen, kindergarten

**Lunch Menu**:
The set of Lunch Entries a School publishes for a given week.
_Avoid_: lunch schedule, canteen plan

**Lunch Entry**:
What a School serves for lunch on one specific date, as free-text dish names. Carries a Main Category when one can be determined at ingest.
_Avoid_: lunch dish, menu item

**School Plugin**:
A scraper implementation that turns one School's published menu format into Lunch Entries.
_Avoid_: parser, adapter

**Ingest Outcome**:
The result of the most recent attempt to obtain a School's Lunch Menu for a week: fetched, cached, or no data with a reason. One per School, replaced on every attempt.
_Avoid_: scrape status, sync result

### Planning

**Weekly Plan**:
The assignment of one Dish (a Favorite Dish, or a Suggested Dish when none is eligible) to each dinner date of a Monday–Sunday week.
_Avoid_: meal plan (ambiguous), menu

**Planned Dinner**:
One dated slot in a Weekly Plan.
_Avoid_: meal, slot

**Swap**:
The household replacing one Planned Dinner's Dish by hand with another Dish eligible for that date. Every hard rule still holds; the rationale says it was chosen by hand. Not possible once the Weekly Plan is confirmed.
_Avoid_: override, reroll, change

**Quick Day**:
A dinner date constrained to Dishes under a configured prep-time limit, because the household has activities. The limit applies to every Dish planned on that date, Weekend Dishes included.
_Avoid_: busy day, fast day

**Variety Preference**:
A soft planning preference to avoid Dishes served within a configurable recent window, and the same Main Category on consecutive dinners. Never blocks a Dish — weekly staples ("burgers every Friday") are expected; a repeat just earns a rationale.
_Avoid_: cooldown

**Once a Week**:
The hard rule that a Weekly Plan holds each Dish at most once. Across weeks only the Variety Preference applies.
_Avoid_: no-repeat rule, uniqueness

**Planner Agent**:
The whole pipeline that produces the Weekly Plan: deterministic constraint enforcement plus LLM-assisted selection and extraction. The LLM part is the LlmAgent.
_Avoid_: AI, scheduler

**Plan Run**:
One execution of everything a week needs, triggered by hand or by the schedule: lunch ingest, dish selection, ingredient resolution, pantry matching, and Shopping List update. At most one Plan Run per week is in flight at a time. The household can see which Phase a Plan Run is in.
_Avoid_: job, task, generation

**Phase**:
One of the five stages of a Plan Run, in fixed order: Lunch ingest, Dish selection, Ingredient resolution (reported per Dish), Pantry matching, Shopping List update.
_Avoid_: step, stage

### Shopping

**Shopping List**:
The household's one living list of lines to buy, split into a "Buy" section and a "Check pantry" section. A line is identified by its Ingredient name and holds the Shares of every Planned Dinner that wants it, from any week, and may also be hand-added. A Plan Run adds Shares to it; only the household removes lines, by Delete or Clear. Each line may be Checked Off.
_Avoid_: grocery list (fine informally, but Shopping List is canonical), weekly list, this week's list

**Share**:
One Planned Dinner's claim on a Shopping List line: the quantity and unit that dinner's Dish needs of the Ingredient. A line's quantity is the sum of its Shares. A Share is added once, when its Planned Dinner is first pushed to the list, and withdrawn when that Planned Dinner is Swapped or regenerated. Later edits to the Dish do not touch Shares already on the list.
_Avoid_: contribution, source, portion

**Pantry Item**:
An Ingredient the household restocks ad hoc during the week (flour, milk, cream, …). Lands in "Check pantry", never in "Buy". A line's section is fixed when its first Share or hand-add lands.
_Avoid_: staple, basic

**Store Section**:
Where in the store a Buy line is picked up: Frukt & grönt, Bröd, Kött & fisk, Mejeri & ägg, Torrvaror & konserver, Fryst, Hushåll or Övrigt, in that walking order. Derived from the line's name alone, deterministically (Swedish and English words; a compound goes by its last part), never stored and never asked of the agent. Groups the unticked Buy lines on the page; Check pantry and the sinks are not grouped.
_Avoid_: aisle (fine in the UI's spirit, but stores differ), category (that is a Dish's Main Category)

**Checked Off**:
A Shopping List line the household has marked as in the basket or handled. Stays visible, struck through, below the unticked lines of its section (on Buy, together after every Store Section), until Cleared. A tick leaves the line where it is until the page next loads, so it never jumps from under the thumb. Tapping again un-ticks. A new Share landing on a Checked Off line un-ticks it, since more is now needed. Not attributed to a person.
_Avoid_: bought (pantry lines get checked too), done, completed

**Extra Item**:
A Shopping List line the household added by hand, not derived from any Planned Dinner. Its quantity is free text. Adding a name already on the list un-ticks that line and marks it hand-added instead of duplicating it. Always in "Buy" unless the line already existed in "Check pantry".
_Avoid_: custom item, manual ingredient

**Delete**:
The household taking one line off the Shopping List, ticked or not. Final: the Shares it held never come back, and the Dish keeps its Ingredient.
_Avoid_: remove, hide

**Clear**:
The household taking every Checked Off line off the Shopping List in one action, across both sections. The only way ticked lines leave the list; never automatic on a Plan Run or a timer.
_Avoid_: reset, done shopping, new week

### Offline

Dormant since ADR-0008: with the app reached over plain HTTP, no service worker runs. The terms stay for the day it returns.

**Pending Change**:
A household edit made while the device could not reach the server, kept on the device until it can. Only edits that need no Plan Run can become Pending Changes.
_Avoid_: queued request, offline edit

**Offline Copy**:
The last version of a screen the device saw, shown with its timestamp when the server is unreachable.
_Avoid_: cache, snapshot

### Lists

Added by ADR-0010. The Shopping List (above) is the first List; these terms cover every List.

**List**:
A named, ordered, household-wide list of lines or Todos. Every List is shared by the whole household; there are no private Lists. A List is shopping-style (lines with a free-text quantity, ticked and Cleared like the Shopping List) or todo-style (Todos with a due date, a Member and a Repeat). The Shopping List is the one shopping-style List the Plan Run writes to and cannot be deleted.
_Avoid_: project, board, note, checklist (ambiguous with the shopping-style kind)

**Todo**:
One thing to do on a todo-style List: a title, optional notes, an optional due date and time, an optional Member and an optional Repeat. Done when ticked.
_Avoid_: task, reminder, item, to-do item

**Due**:
The date, and optionally the time, a Todo should be done by. A Todo past its due date is overdue and shows on Today until done. A Todo with no due date lives only on its List.
_Avoid_: deadline, scheduled for

**Repeat**:
A Todo's fixed-schedule rule: daily, weekdays, weekly on chosen weekdays, every N weeks, monthly on a day, or yearly, anchored on its due date. Ticking a repeating Todo advances its due date to the next occurrence and records the done occurrence; it never becomes a struck line. Stored as a structured rule, never as free text.
_Avoid_: recurring, recurrence rule, every!

**Done**:
A Todo the household has ticked. Stays visible, struck through, below the open Todos of its List, until Cleared. Tapping again un-ticks. Attributed to the device's Member. The todo-style counterpart of Checked Off.
_Avoid_: completed, finished, archived

**Member**:
A person in the household, with a name and a colour. Data, not an account: no password, no login. A device picks its Member once and keeps it in a cookie, which attributes its edits and makes "mine" work. A Todo may be assigned to one Member. Kids are Members whether or not they hold a phone.
_Avoid_: user, account, assignee (say "assigned to a Member"), profile

**Quick Add**:
The one input at the top of a List that adds a line or a Todo from a single typed phrase. A small Swedish and English grammar sets Due, Repeat and Member from words in the phrase ("imorgon", "fredag kl 17", "varje måndag", "@Pappa"); the parsed span is shown and a tap reverts it to plain text. Works without an agent.
_Avoid_: smart add, natural language input, parse

**Activity**:
The record of who did what on a List: a Member, an action (added, ticked, un-ticked, Cleared, deleted) and a time, kept for 30 days. A record, not a lock: ticks stay last-write-wins per line.
_Avoid_: log, history, audit trail

**Daily Brief**:
One message a day at a configured hour, sent through a configured webhook sink: today's lunch and dinner, the Todos due today, and how many Shopping List lines are left to buy. Optional; off when no sink is configured.
_Avoid_: digest, agenda email, morning push
