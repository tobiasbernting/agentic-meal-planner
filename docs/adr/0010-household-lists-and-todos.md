# The app becomes the household's lists: Lists, Todos and Members beside the dinner plan

---
Status: Proposed (written 2026-10-25 from the owner's direction; confirmed when this PR merges)
---

The household wants one app for everything it writes down together: the shopping list, the things to do, the packing list, who picks up whom. Today the app plans dinners around the kids' school lunches and keeps one Shopping List (ADR-0009, one living list with Shares). Everything else lives in other apps, so the shopping list competes with Apple Reminders and a family chat for attention and loses. We make this app the household's list app: the dinner plan and the school lunches stay, the Shopping List stays the Plan Run's output, and generic household Lists with Todos and Members are added around them. Open source and self-hosted as before; reachability from the internet is a separate, later decision (ADR-0008 covers today's VPN).

Nine popular apps were inventoried from their own docs (`docs/research/2026-10-25-family-todo-apps.md`). They converge on five parts: lists of items, due date with optional time, repeat that advances on completion, one assignee per item on a shared list, and done items that stay struck until a clear. Family organisers add a household of named, colour-coded members without permissions, and meals on the same day view as due items. We recreate exactly that set and nothing more.

## Decisions

- **List.** A named, ordered, household-wide list. Every List is shared; there are no private lists and no permissions, as in Cozi's fully shared account. Two kinds in presentation only: a shopping-style List (lines with a free-text quantity, tick, Clear, a recently-cleared tray) and a todo-style List (Todos with due date, Member, Repeat). The Shopping List of ADR-0009 is the first shopping-style List, cannot be deleted, and remains the only List the Plan Run writes Shares to.
- **Todo.** One thing to do on a todo-style List: title, optional notes, optional due date and time, optional Member, optional Repeat. Done is a state, not a deletion: a done Todo stays struck below the open ones until Cleared, the same lifecycle Checked Off has on the Shopping List. One mental model for every list in the app.
- **Repeat.** Fixed-schedule rules only, the Microsoft To Do subset: daily, weekdays, weekly on chosen weekdays, every N weeks, monthly on a day, yearly. Completing a repeating Todo advances its due date to the next occurrence and records the done occurrence; it never becomes a struck line. Stored as a structured rule, never as free text. From-completion repeats (Todoist `every!`) are a later option.
- **Member.** A person in the household with a name and a colour. Members are data, not accounts: no password, no login. A device chooses its Member once ("Den här telefonen är Pappas"), stored in a cookie like the language. That gives assignment, a "mine" filter, attribution on done lines ("Pappa 14:02") and, later, a notification target. Kids are Members whether or not they hold a phone.
- **Today and the Plan week carry the Todos.** Today shows overdue and due-today Todos under the day's lunch and dinner (Cozi Today). Each day row of the Plan week shows the Todos due that day (FamilyWall's task overlay). The almanac stays the household's day view; there is no separate calendar of events.
- **Quick Add is deterministic first.** One input per List. A small Swedish and English grammar (idag, imorgon, weekday names, dd/mm, kl HH:MM, varje måndag, @Member) sets due, time, Repeat and Member; the parsed span is shown and a tap reverts it to plain text, as every surveyed app does. The LlmAgent may enhance the parse where configured, but the base never needs it (ADR-0001's rule: the deterministic core runs without an LLM).
- **Attribution and activity.** Every add, tick, untick, clear and delete records the device's Member and the time. A List shows who did what for the last 30 days (Bring!'s Activities). Ticks stay last-write-wins per line; the activity row is a record, not a lock.
- **Notifications through the webhook sink.** The one channel this app owns, ntfy over the generic webhook (ADR-0006), gains two messages: a daily brief at a configurable hour (today's lunch and dinner, due Todos, lines left to buy) and a reminder at a Todo's due time. One household topic by default; a Member may have a topic of their own. SPEC.md's "no notifications" non-goal is lifted to this extent only.
- **Tabs.** Idag, Inköp, Listor, Plan, Mer. The Shopping List keeps its own tab because it is the most-used screen; Listor holds every List including the Shopping List at the top. Five tabs fit a phone; a sixth would not.

## Considered and rejected

- **Keep the app a dinner planner and push lists to an external app.** The Trello years (ADR-0006) showed the household wants to add, remove and tick in one place, and no external app can restore Dish-derived lines or know the lunch menu.
- **Sub-items, priorities, tags, attachments, sections inside todo lists.** Present in Todoist, TickTick and Reminders, absent or unused in every family organiser. Each is a field to fill with one thumb in a school corridor. Add one only when the household asks.
- **Accounts, kid logins, roles.** FamilyWall mints child logins and scopes edits to the author; Any.do has board roles. This household is trusted (DESIGN.md round 2) and the app has no auth; adding identity for permission's sake contradicts ADR-0002's single-tenant shape. Members-as-data give the benefits (assignment, attribution, colour) without the login.
- **A calendar with events.** Apple and Google calendars exist on every phone. The Plan week with lunch, dinner, Quick Days and due Todos is the household's overlay, not a replacement.
- **Points and rewards for chores.** OurHome only. A chore is a repeating Todo assigned to a Member; rewards are a later product question.
- **Push via a service worker.** Needs HTTPS, which the household's deployment lacks (ADR-0008). ntfy works today over the internet without exposing the server.
- **Free-text repeat grammar stored as typed.** Todoist's grammar is rich and ambiguous; storing a structured rule keeps the next-occurrence computation pure and testable (NFR-3).

## Consequences

- New tables for Lists, their items (lines and Todos share one table; ADR-0009's Shares reference the Shopping List's items), Members and activity. The old per-week Shopping List tables migrate once via `runOnce`, as ADR-0009 already requires.
- The tab bar gains a tab, the Today page a block, the Plan day rows a line. The almanac visual world (docs/design/VISUAL.md) is extended, not redesigned.
- Every new write route is a plain POST, idempotent under `Idempotency-Key`, and sorted into the offline allowlist or the online-only set (ADR-0007), so the dormant service worker picks the Lists up unchanged when HTTPS arrives.
- PRODUCT.md's purpose widens from "plans dinners and keeps the shopping list" to "the household's lists, with dinner planned around the school lunches". SPEC.md's non-goals on house planning and notifications are amended; dinners-only planning stays.
- The glossary gains List, Todo, Member, Repeat, Done, Clear (generalised), Quick Add and Activity. "Task" stays an avoided word.
- Reach from the internet without the VPN, and any auth that would need, remain outside this decision (ADR-0008, #110).
