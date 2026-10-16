# Meal Planner

The domain language for a household dinner planner that works around kids' school lunches and produces a weekly shopping list.

## Language

### Dishes and recipes

**Dish**:
A named dinner the household eats. May link to a Recipe and carry a prep-time tag.
_Avoid_: meal, dinner recipe

**Favorite Dish**:
A Dish the household has added to its rotation. The unit the Weekly Plan is built from.
_Avoid_: saved recipe, bookmark

**Recipe**:
Cooking instructions and an ingredient list, usually living at an external URL the Dish points to.
_Avoid_: instructions, cooking page

**Ingredient**:
A single line item a Recipe requires, optionally with quantity and unit.
_Avoid_: item, product

**Adaptation**:
A household's standing modification to a Dish ("no chili — the kids"), applied to whatever source the Dish's Ingredients came from.
_Avoid_: tweak, note

**Main Category**:
The broad food group a Dish belongs to (pasta, fish, chicken, …), used to avoid serving the same kind of food the kids had for lunch.
_Avoid_: cuisine, type

### School lunches

**School**:
A source of kids' lunch menus, identified by one or more published URLs. A household can have several.
_Avoid_: canteen, kindergarten

**Lunch Menu**:
The set of Lunch Entries a School publishes for a given week.
_Avoid_: lunch schedule, canteen plan

**Lunch Entry**:
What a School serves for lunch on one specific date, as free-text dish names.
_Avoid_: lunch dish, menu item

**School Plugin**:
A scraper implementation that turns one School's published menu format into Lunch Entries.
_Avoid_: parser, adapter

### Planning

**Weekly Plan**:
The assignment of one Favorite Dish to each dinner date of a Monday–Sunday week.
_Avoid_: meal plan (ambiguous), menu

**Planned Dinner**:
One dated slot in a Weekly Plan.
_Avoid_: meal, slot

**Quick Day**:
A dinner date constrained to Dishes under a configured prep-time limit, because the household has activities.
_Avoid_: busy day, fast day

**Planner Agent**:
The component that produces the Weekly Plan: deterministic constraint enforcement plus LLM-assisted selection and extraction.
_Avoid_: AI, scheduler

### Shopping

**Shopping List**:
The aggregated Ingredients for a Weekly Plan, split into a "Buy" section and a "Check pantry" section.
_Avoid_: grocery list (fine informally, but Shopping List is canonical)

**Pantry Item**:
An Ingredient the household restocks ad hoc during the week (flour, milk, cream, …). Lands in "Check pantry", never in "Buy".
_Avoid_: staple, basic
