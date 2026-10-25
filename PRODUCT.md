# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: the two parents of a household with school-age kids. Either of them opens the app, mostly on a phone: in the kitchen, after work, at the store, or on Sunday evening when the new week's plan arrives. Both read and edit; there are no roles.

Everyone in the household is a Member: a name and a colour, so a Todo can be theirs. Kids are Members whether or not they hold a phone. A Member is data, not an account: there is no login.

Secondary: other households that self-host their own copy (open source, MIT). Most of them are expected to have kids in Swedish schools. Contributors who write School Plugins or Shopping List sinks use the docs, not the UI.

## Product Purpose

The household's lists, with dinner planned around the school lunches ([ADR-0010](docs/adr/0010-household-lists-and-todos.md)). The app plans dinners Monday to Sunday around what the kids already ate for school lunch and keeps the Shopping List that the Plan Run writes. Around them sit every other List the household keeps: the things to do, the packing list, who picks up whom. Success means the household writes things down in one place, and nobody has to think about dinner during the week. Dinner never repeats lunch, Quick Days get quick dishes, the Shopping List is ready on the phone, and today's Todos sit next to today's lunch and dinner.

Two moments matter equally:

- **Sunday review**: look over the generated Weekly Plan with each day's lunch, the selection rationale and the Todos due each day, swap or regenerate, then confirm.
- **Daily glance**: the Today view answers "what's for lunch and dinner today, and what has to be done" at a glance.

## Positioning

Built around the kids' school lunch menus: dinner is planned against what each School actually serves, scraped from its published URL. Hard rules are deterministic (lunch collisions, Quick Days, Weekend Dishes). The LLM only picks among eligible Dishes and handles extraction, and it shows its reasoning. Weekly staples like burgers are welcome; variety is a soft preference. Self-hosted, local first, and agent-agnostic: any prompt-in/JSON-out CLI works.

## Operating Context

- Weekly rhythm: a scheduled Plan Run (default Sunday 18:00) produces next week's plan. The household reviews it and confirms it, which locks it from automatic changes.
- Shopping happens in the app: the Buy and Check pantry sections are ticked on the phone in the store.
- Each phone chooses its Member once ("Den här telefonen är Pappas"), kept in a cookie like the language. That attributes its edits ("Pappa 14:02"), makes "Mina" work and needs no login. A phone with no Member still edits; its edits are unattributed.
- The only messages the app sends go through the configured webhook sink (ntfy): an optional Daily Brief at a chosen hour and a message at a Todo's Due time.
- Runs on the home LAN in one Docker container, reached from outside over a VPN on the phones. No auth; the household is trusted.
- Plan Runs take time and run in Phases; the household can see which Phase a run is in.
- The app must still work in degraded mode when no agent is configured.

## Capabilities and Constraints

- Manages Dishes (Favorite and Suggested), Schools, Pantry Items, Members, and Settings. Shows the Weekly Plan, Shopping List, Today view, and Logs.
- Lists: any number of named household Lists, shopping-style (lines ticked and Cleared like the Shopping List, with a "Nyligen" tray of recently cleared lines) or todo-style (Todos with Due, Member and Repeat; Done Todos stay struck until Cleared). Each List shows its Activity for 30 days.
- Quick Add turns one typed phrase into a Todo with a small deterministic Swedish and English grammar; it never waits on the agent.
- Daily Brief: today's lunch and dinner, the Todos due and the lines left to buy, once a day through the webhook sink.
- Five tabs: Idag, Inköp, Listor, Plan, Mer.
- Server-rendered HTMX UI with no client framework. Must be phone-friendly.
- Swedish and English UI. Swedish is the default and ships first. Main Category labels exist in both languages.
- Terminology follows [GLOSSARY.md](GLOSSARY.md). Use Dish, Lunch Entry, Weekly Plan, Plan Run, and so on, never the listed _Avoid_ terms.
- Product scope and non-goals: [docs/SPEC.md](docs/SPEC.md). Architecture: [docs/DESIGN.md](docs/DESIGN.md). That file is the technical design, not a visual system.

## Evidence on Hand

No screenshots, testimonials, or usage data exist. Future work must not invent them.

## Product Principles

1. **Answer the question first.** Every screen leads with what the parent opened it for: today's meals, the week, the list.
2. **Show the why.** A pick, a swap, or a skipped day carries its rationale or its notice (no lunch data, menu changed, sink failed). Never change things silently.
3. **Degrade loudly, never fail.** A missing agent, a broken scrape, or a failed sink still leaves a usable plan, and the UI says what is missing.
4. **One-handed and quick.** Phone use in the middle of the day comes first. Setup screens can be denser, but they must still work on a phone.
5. **Household language.** Plain Swedish (or English) copy, in the household's own words, never system jargon.
