# What popular todo and family-organiser apps offer, and what this app should recreate

Research for the next step after [#118](https://github.com/tobiasbernting/agentic-meal-planner/issues/118): the owner wants this app to be the household's todo and shopping-list app, not only its dinner planner. Nine apps were inventoried from their own documentation on 2026-10-25. The per-app inventories, with one citation per claim, are in three companion files:

- [Todoist, Microsoft To Do, TickTick](./2026-10-25-inventory-todoist-mstodo-ticktick.md) (general todo apps)
- [Apple Reminders, Google Tasks, Any.do](./2026-10-25-inventory-reminders-gtasks-anydo.md) (platform todo apps and a family plan)
- [Cozi, FamilyWall, Bring!, AnyList, OurHome, Picniic](./2026-10-25-inventory-family-organisers.md) (family organisers)

The earlier grocery-only survey is [2026-10-18-shared-grocery-list-models.md](./2026-10-18-shared-grocery-list-models.md); its conclusions stand and are not repeated here.

**Method caveat.** The cloud session's network policy refused direct HTTPS to every vendor help centre, so every inventory was built from a vendor-domain-restricted search index of the cited pages (titles, URLs and extracts), not rendered pages. Each file says so and marks topics the vendor does not state as "silent". Nothing below rests on a third-party review.

## Summary

Every todo app surveyed is built from the same five parts: **lists** that hold **items**, each item with a **due date** and optional time, a **repeat rule**, and **sharing** of a list with other people who can be **assigned** items. The apps differ in depth (nesting levels, priority scales, filters) and in rituals (Today, My Day, Upcoming), not in kind. Family organisers add two things the todo apps lack: a **household with named, colour-coded members** that everyone signs into without per-user permission machinery, and **meals as first-class entries on the day**, next to events and due items. Shopping-list apps add **tick as a shared, visible state**, **clear ticked** as the only way lines leave, and **memory of past items** for one-tap re-adding.

Against that, this app already has the hardest part (a dinner plan that knows the kids' lunches and writes the shopping list) and the right surface for the rest (a phone-first Today page as the first screen). What is missing is the generic list layer and the household identity around it.

## The feature table

| Capability | Todoist | MS To Do | TickTick | Apple Reminders | Google Tasks | Any.do | Cozi | FamilyWall | Bring! |
|---|---|---|---|---|---|---|---|---|---|
| Several named lists | project | list, list groups | folder > list | list, groups | list | list / board | shopping + todo lists | shopping + todo lists | list |
| Sections inside a list | yes (20) | no | yes | yes, auto-categorise | no | boards only | ALL-CAPS heading trick | silent | aisle categories |
| Sub-items | 4 levels | 1 level (steps) | 5 levels | yes | 1 level | yes | no | no | no |
| Notes on an item | yes | yes | yes | yes | yes | yes | silent | silent | detail text |
| Due date | yes | yes | yes | yes | yes | yes | silent | yes | no |
| Due time | yes | yes | yes | yes | yes | yes | no | yes | no |
| Repeat rule | grammar; `every` vs `every!` | presets + custom | presets + by-completion | presets + custom | presets | basic (paid: custom) | chores: daily/weekly | Premium | no |
| Priority | p1-p4 | star | 3 levels | 3 levels | star | one colour tag | no | no | urgent / if convenient |
| Tags | yes | `#hashtag` | yes | yes | no | yes | no | category | no |
| Assign to a person | 1 per task | 1 per task | 1 per task | 1 per task | from Chat/Docs only | several | list owner only | yes | no |
| Share a list | yes | yes | yes, with roles | yes | no | boards, roles | whole account | circle, admin vs member | per list |
| Members with a colour | no | no | no | no | no | no | yes, 12 | yes | no |
| Kid accounts without email | no | no | no | Family Sharing | no | no | no sign-in | admin-minted login | no |
| Today / My Day view | Today, Upcoming | My Day (resets nightly) | Today, Next 7 Days | Today, Scheduled | no | My Day, 7 Days | Cozi Today | daily briefing | no |
| Natural-language date typed in title | yes | yes | yes | Apple Intelligence or Siri | no | yes | no | yes (Quick Add) | no |
| Completed items | hidden, toggle | Completed heading | Completed section | hidden, Show Completed, Clear | Completed section, Delete all | struck until archived | struck, Delete checked | silent | removed into Recently Used |
| Recurring completion | next date, Undo, Complete forever | next occurrence | next per rule, skip | next occurrence | next instance | next after done | chores reappear | silent | n/a |
| Who did what | activity log (Reporting) | silent | List Activities | silent | silent | board Activity | silent | silent | Activities (who added/bought) |
| Change notifications | per event | silent | per list | Adding / Completing toggles | per task event | per board | Gold, event changes | per section | list changed, someone is shopping |
| Daily agenda push or email | no | no | no | no | no | 9 AM push | agenda emails | 9am briefing | no |
| Meals on the day | no | no | no | no | no | no | breakfast/lunch/snack/dinner | editable meal types with hours | no |
| Recipe to list | no | no | no | share sheet (AI) | no | no | under recipe heading | yes | recipe templates |
| Offline documented | yes | yes | silent | silent | silent | limited | yes, first write wins | lists usable offline | silent |
| Idempotent writes documented | command uuid | no | no | no | no | no | no | no | no |

## Where the apps converge

1. **A list is a flat, ordered set of items; everything else is optional per item.** Sections, sub-items, priorities and tags exist in most apps but none of the family apps lean on them. Cozi's heading trick (type an item in capitals) shows how little structure a household list needs.
2. **Due date with an optional time, and a Today view that merges overdue and due today.** Every todo app has it. Every date-less item is just a checklist line.
3. **Repeat advances on completion.** Completing a repeating item moves it to its next date and keeps a record of the done occurrence. Two apps distinguish fixed-schedule from from-completion repeats (Todoist `every!`, TickTick "By Completion Date"); the rest offer fixed schedules only.
4. **One assignee per item, on a shared list, with an "assigned to me" surface.** Todoist, To Do, TickTick, Reminders and Any.do all do exactly this. Nobody surveyed does per-item permissions.
5. **Completed items stay visible, struck or collapsed, until a separate clear.** Only Bring! removes on tick. The grocery survey found the same.
6. **Natural-language capture in the title**, with the parsed span highlighted and a tap to revert it to plain text (Todoist, To Do, TickTick, Any.do, FamilyWall).
7. **Change notifications are opt-in per person and never for your own edits** (Reminders, Google Tasks, TickTick, Cozi Gold).
8. **Conflict handling is undocumented everywhere.** Cozi alone states a rule ("the first change sent is saved"), which is first-write-wins per record. Todoist alone documents idempotent commands. The current app's `Idempotency-Key` and last-write-wins per line are already at the documented frontier.

## Where the family organisers differ from the todo apps

- **Household as the tenant.** Cozi: one account, up to twelve members with a name and a colour, one shared password, no permissions. FamilyWall: a circle with an admin who can mint a username and password for a kid without email. Any.do: a Family Space of four. The colour is the identity on screen; it travels onto calendar entries and chores.
- **The day is the unit, and meals are on it.** Cozi and FamilyWall put breakfast, lunch and dinner on the same day view as events and due tasks, and FamilyWall overlays each category in its own colour. Cozi flags busy days so quicker meals land there. This app's Quick Day and Today page are the same idea.
- **Chores are todo lists per member with daily or weekly repeat**, auto-created in Cozi, assignable in FamilyWall. Points and rewards appear only in OurHome.
- **A daily briefing at a set hour** (Cozi agenda email, FamilyWall 9am push, Any.do 9 AM) is the family-organiser version of My Day.

## What this app should recreate, and what it should not

Recommendation, mapped to this app's principles (PRODUCT.md): answer the question first, show the why, degrade loudly, one-handed, household language.

**Recreate**

1. **Lists as a first-class, generic thing.** Any number of named household lists. Two kinds in presentation only: shopping-style (lines, free-text quantity, tick, clear) and todo-style (due date, assignee, repeat). The Shopping List of ADR-0009 becomes the first list, still fed by the Plan Run.
2. **Members with a name and a colour, no login.** "This phone is Pappa's" set once per device, like the language cookie. It gives assignment, a "mine" filter, attribution on done lines ("Pappa 14:02") and a target for per-member notifications later. Kids are members without phones.
3. **Due date, optional time, overdue.** Shown on the list, on Today (overdue plus due today, Cozi Today style) and on each day of the Plan week (FamilyWall overlay style).
4. **Repeat on fixed schedule**, the Microsoft To Do subset: daily, weekdays, weekly on chosen weekdays, every N weeks, monthly on a day, yearly. Completion advances the due date and records the done occurrence. From-completion repeats are a later option.
5. **Done stays visible, struck, below the open items, until Clear**, the same model ADR-0009 chose for the Shopping List. One mental model for every list.
6. **Quick Add with a small deterministic date grammar** in Swedish and English (idag, imorgon, weekday names, dd/mm, kl 17, varje måndag, @Namn), parsed span shown and revertable. The agent can enhance it later; the base must not need an LLM.
7. **Attribution and a per-list activity trail**, Bring!'s Activities: who added, who ticked, who cleared, kept for a few weeks.
8. **A daily brief and due-time reminders through the existing webhook sink** (ntfy): today's lunch and dinner, due todos, how many lines are left to buy. The one notification channel this app already owns, and it reaches phones over the internet without exposing the server.
9. **Recently cleared as a re-add tray** on shopping-style lists, so the weekly staple is one tap, not typing. Favourites and templates can wait.

**Do not recreate (yet)**

- Sub-items, priorities, tags, attachments, comments, sections inside todo lists. None of the family apps lean on them; every one of them is a field to fill on a phone.
- Per-item permissions, kid logins, roles. The household is trusted (DESIGN.md round 2), and Cozi's fully shared account is the precedent.
- Karma, habits, Pomodoro, Eisenhower, kanban, Gantt. Productivity rituals, not household ones.
- Points and rewards for chores. OurHome only; revisit if the kids ask.
- A general calendar with events. Google and Apple calendars already do this; the Plan week with lunch, dinner, Quick Days and due todos is the household's calendar overlay, not a replacement.
- Email-to-task, Siri, share sheet. They need an exposed endpoint or a native app.

## Open questions for the decision record

1. Tabs: keep Inköp as its own tab and add Listor (five tabs), or fold the Shopping List into Listor (four tabs)?
2. Is a Member chosen per device enough, or must a Member be chosen per action ("who ticked this")? Per device is the Cozi model and costs one tap, once.
3. Should todo-style and shopping-style be two kinds of list, or one list with every field optional? The research says one; the question is whether the Shopping List's Shares and sections stay special.
4. Do kids get the app on their devices (then Members need a kid-friendly list page), or are they assignees only?
5. Does the daily brief go to one household topic or one topic per Member?

## Sources

See the three inventory files. All vendor pages were indexed on 2026-10-25.
