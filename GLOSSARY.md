# Meal Planner

The domain language for a household dinner planner that works around kids' school lunches and produces a weekly shopping list.

## Language

### Dishes and recipes

**Dish**:
A named dinner the household eats. May link to a Recipe and carry a prep-time tag.
_Avoid_: meal, dinner recipe

**Favorite Dish**:
A Dish the household has put in its rotation. The Weekly Plan is built only from Favorite Dishes. A Dish that is not in rotation is kept but never planned.
_Avoid_: saved recipe, bookmark

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
A single line item a Dish requires, optionally with quantity and unit. Comes from the Dish's manual entries or from its Recipe.
_Avoid_: item, product

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
The assignment of one Favorite Dish to each dinner date of a Monday–Sunday week.
_Avoid_: meal plan (ambiguous), menu

**Planned Dinner**:
One dated slot in a Weekly Plan.
_Avoid_: meal, slot

**Quick Day**:
A dinner date constrained to Dishes under a configured prep-time limit, because the household has activities. The limit applies to every Dish planned on that date, Weekend Dishes included.
_Avoid_: busy day, fast day

**Variety Preference**:
A soft planning preference to avoid Dishes served within a configurable recent window. Never blocks a Dish — weekly staples ("burgers every Friday") are expected; a repeat just earns a rationale.
_Avoid_: no-repeat rule, cooldown

**Planner Agent**:
The whole pipeline that produces the Weekly Plan: deterministic constraint enforcement plus LLM-assisted selection and extraction. The LLM part is the LlmAgent.
_Avoid_: AI, scheduler

### Shopping

**Shopping List**:
The aggregated Ingredients for a Weekly Plan, split into a "Buy" section and a "Check pantry" section.
_Avoid_: grocery list (fine informally, but Shopping List is canonical)

**Pantry Item**:
An Ingredient the household restocks ad hoc during the week (flour, milk, cream, …). Lands in "Check pantry", never in "Buy".
_Avoid_: staple, basic
