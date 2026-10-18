# Shared grocery list models: living list, line lifecycle, two shoppers

Research for [#118](https://github.com/tobiasbernting/agentic-meal-planner/issues/118), step 1. All sources fetched 2026-10-18.

Summary. Of the seven apps, the ones whose docs state a model all treat a grocery list as one long-lived list that is reused trip after trip. AnyList's help centre recommends exactly that. None offers a list that resets per week or per trip. You get a per-trip list only by copying a list or unchecking everything. Ticking a line is a soft state in five of the seven: the line stays, struck through or greyed, sorted down or hidden, until someone runs an explicit "clear crossed off" action. Bring! is the outlier: a tap removes the line into a "Recently Used" tray. Every app keeps a memory of past items (history, favourites, recents) separate from the list, and clearing ticked lines never erases that memory. AnyList is the closest match to a planner that appends to a list: recipe and meal-plan ingredients merge into one line per item, show the total quantity, keep each recipe's share, and can lose one recipe's share without losing the line. No vendor documents how it resolves two people editing the same line at once. Listonic and Todoist document offline editing with later sync. The others say nothing about offline, or say changes are not visible until the device reconnects.

## Question and scope

How do shared grocery list apps model:

1. One living list versus per-period lists.
2. The line lifecycle: add, tick, what happens to ticked lines, clearing ticked lines, re-adding through recurring items, favourites or recents, and quantity merging when the same item is added twice.
3. Two people using the list in a store aisle: real-time sync, conflict handling, offline editing.

Apps covered: Bring!, AnyList, Google Keep, Apple Reminders (Groceries list type, iOS 17 and later), Listonic, OurGroceries, Todoist. I left out Microsoft To Do and Cozi because I found nothing distinct enough to justify them.

Sources: vendor help centres, vendor feature pages, App Store listings written by the vendor, and vendor developer docs. Where a vendor's docs are silent, the table says "silent". Feature pages are marketing copy written by the vendor. They count as primary sources for what the vendor claims, not for how edge cases behave.

## Comparison

| App | List model | What tick does | Clear ticked | Recurring / favourites / recent | Quantity merge | Sync | Offline | Conflict |
|---|---|---|---|---|---|---|---|---|
| Bring! | Living lists, several per user, shared per list | Tap removes the item into "Recently Used" (no checked state) | Not needed: tick is removal. "Recently Used" can be pruned by hand | Recently Used (last few removed); shopping suggestions learned from purchase intervals, top 400 items; list templates | Silent on merge; same item can appear twice if descriptions differ | Vendor claims real-time; pull-down for manual sync; activity log of who added or bought what | Silent | Silent |
| AnyList | One list reused weekly (vendor recommendation) | Crossed off; stays visible by default, can be hidden with the eye icon; undo by shake (iOS) or banner (Android) | Manual "Delete Crossed Off Items" action | Favourites (per list), Recent Items (crossed off or deleted), starter lists, autocomplete from all three | Recipe ingredients combine into one line with total quantity; per-recipe share visible and removable; adding an item already on the list scrolls to it and uncrosses it instead of duplicating | "Changes to shared lists show up instantly" | Silent for phones; Apple Watch keeps its own copy and syncs later | Silent |
| Google Keep | A note with checkboxes, reused | Item checked; setting moves checked items to the bottom | Silent in help centre (no "delete checked" documented) | None documented beyond the note itself | None: free text lines | Collaborators edit the same note | Silent | Silent |
| Apple Reminders (Groceries) | Living list; auto-categorised | Completed items are hidden; "Show Completed" reveals them | "Clear" deletes completed items | Silent for groceries (no favourites or recents documented) | Silent | iCloud; "all the participants can see everyone's changes"; optional alerts on add and complete | Silent | Silent |
| Listonic | Several living lists; copy a list to start from last week | Checked; greys out on other members' screens | "Delete purchased items"; "Uncheck all items" to reuse the list (Android) | Recent (from product history; rarely bought items age out); popular and catalogue suggestions | Quantity per item; tapping an item again while adding increases quantity | Vendor claims real-time; notifications name item and person | Documented: view, check off, edit offline; sync on reconnect | Silent |
| OurGroceries | Living lists, usually one per store | Crossed off and moved below the "Add an item" row; tap again to uncross | "Delete all crossed-off items" button | Master list of every item ever entered, sorted by frequency; survives deletion | Quantity is part of the item name text ("Potatoes (2)"); silent on duplicates | "Instantly synchronized"; app contacts server every 20 seconds while open | Changes are not visible to others until the device reaches the server | Silent |
| Todoist | Projects of tasks; a shared grocery project is a living list | Task completed; hidden from active list, viewable via "Completed tasks" | Bulk select and delete; no one-tap clear documented | Recurring tasks move to next date on completion | None: tasks are free text | Shared projects; collaborators have edit rights | Documented: edit offline, sync on reconnect; unsynced changes lost if you log out | Silent in help; Sync API documents idempotent commands by UUID, no conflict rule |

## Per-app notes

### Bring!

- Ticking is removal. "To delete an item, tap on it. It will then move to 'Recently Used'." The tap can be switched to a double tap. ([Items & Lists](https://www.getbring.com/help-center-main-categories/items-lists))
- "You can find the last few items you deleted in 'Recently Used' and you can put them back on your list by tapping on them." Entries can be removed from that section in bulk. (same page)
- Details go under the item name ("2 kg apples"). "An item can be added to the list twice if it has different descriptions." The page says nothing about what happens when the same item is added twice with the same description. (same page)
- Several lists, each shared with different people. Moving an item to another list removes it from the original. (same page)
- Suggestions: "the app learns the intervals at which you buy items" and suggests ones likely due. "Shopping suggestions are only calculated for the 400 most-used items." List templates hold items and optional items. ([Inspirations & suggestions](https://www.getbring.com/help-center-main-categories/inspirations-suggestions))
- Sync: the App Store listing says "Share your grocery shopping list in real time" and "automatic notifications" keep the household informed. ([App Store](https://apps.apple.com/us/app/bring-grocery-shopping-list/id580669177)) Troubleshooting suggests pulling down to "synchronize the list manually". ([If nothing else helps](https://www.getbring.com/help-center-main-categories/if-nothing-else-helps))
- Activity log: "see at a glance who added bread to the list or who bought chocolate". ([Blog: Your activities at a glance](https://www.getbring.com/blog-posts/your-activities-at-a-glance))
- Offline and conflicts: I found nothing in the help centre or on the [devices page](https://www.getbring.com/en/features/anywhere-anytime).

### AnyList

- Model: "keeping a single grocery shopping list and using it over and over" rather than starting a new one each week. Workflow: review favourites, add during the week, cross off in the store, then delete the crossed-off items. "Deleting the crossed-off items does not remove them from your favorite items." ([Weekly shopping](https://help.anylist.com/articles/weekly-shopping/))
- Crossed-off items are "visible by default", and the eye icon hides them. ([Show/hide](https://help.anylist.com/articles/show-hide-completed-items/)) Clearing them is a manual action: More Actions, then "Delete Crossed Off Items". ([Delete crossed off](https://help.anylist.com/articles/delete-crossed-off-items/))
- Undo: iOS "supports Shake to Undo" for the last cross-off. Android "shows an Undo banner for a few seconds". Recent Items also restores lines. ([Restore crossed off](https://help.anylist.com/articles/restore-crossed-off-item/)) An optional double-tap setting guards against accidental cross-off. ([Cross off items](https://help.anylist.com/articles/cross-off-items/))
- Recent Items sit behind the clock icon. "Tap on a recent item to add it to your list." Swiping one away also removes it from autocomplete. The title says the tray holds items "recently crossed off or deleted". ([Recent items](https://help.anylist.com/articles/recent-items/))
- Favourites: "Favorites are stored on a list-by-list basis" and remember edits such as photo, price and store. ([Favorites](https://help.anylist.com/articles/favorites/)) Starter lists are named sets of items you can add one at a time or all at once. ([Starter lists](https://help.anylist.com/articles/starter-lists/))
- No duplicate lines. Picking an autocomplete suggestion that is already on the list "will scroll you to the item in your list (it won't create a duplicate)", and "If the item was crossed off, it will now be uncrossed." A gray icon means the line is crossed off, blue means it is active. ([Autocomplete icons](https://help.anylist.com/articles/autocomplete-icons/))
- Recipe merge: "Similar ingredients are combined into a single list item which shows the total quantity needed." The page is silent on units. ([Add recipe ingredients](https://help.anylist.com/articles/add-recipe-ingredients-to-list/)) Item Details lists each contributing ingredient. "Swipe from right to left across the ingredient you wish to remove" removes one recipe's share. ([Remove single ingredient](https://help.anylist.com/articles/remove-single-ingredient-from-list/))
- Meal plan: pick dates, or press and hold to select a whole week, and the ingredients go to a chosen list. The page does not say whether ingredients already on the list are skipped or combined. ([Meal plan ingredients](https://help.anylist.com/articles/meal-planning-calendar-add-recipe-ingredients/))
- Sync: "Changes to shared lists show up instantly for everyone sharing the list." ([Share list](https://help.anylist.com/articles/share-list/)) The device sync article says only that changes "will sync". It says nothing on offline or conflicts. ([Sync devices](https://help.anylist.com/articles/sync-devices/))

### Google Keep

- A list is a note with checkboxes. New items go to the top or bottom (setting). ([Make a list](https://support.google.com/keep/answer/6395451?hl=en&co=GENIE.Platform%3DAndroid))
- Setting: "Move checked items to the bottom of a list." ([List & sharing settings](https://support.google.com/keep/answer/6358550?hl=en&co=GENIE.Platform%3DAndroid))
- Collaborators "can edit text, lists, images…". Deleting a shared note you own deletes it for everyone. ([Share notes](https://support.google.com/keep/answer/6101196?hl=en&co=GENIE.Platform%3DAndroid))
- Data model: a list item has `text`, `checked` ("Whether this item has been checked off or not") and one level of `childListItems`. The public API has create, get, list and delete, with no update. ([Keep API: notes](https://developers.google.com/workspace/keep/api/reference/rest/v1/notes))
- The help centre does not document "delete checked items" or "uncheck all". Those menu items may exist in the app, but I could not verify them from a primary source.

### Apple Reminders (Groceries list type)

- "In iOS 17 and later, you can choose Groceries as a list type". Items are auto-categorised, and moving an item to another category is remembered for next time. Requires iCloud for Reminders. ([HT213830](https://support.apple.com/HT213830))
- Current guide: items are "automatically sorted into categories such as Produce and Seafood", and the list "remembers your preferences". With Apple Intelligence it can build suggested items from text such as a recipe in Safari. ([Make a grocery list](https://support.apple.com/guide/iphone/make-a-grocery-list-iph80ba26e1f/ios))
- "Completed items are hidden on your list. To unhide completed items, tap [More], then tap Show Completed. To delete the completed items, tap Clear." ([Complete items](https://support.apple.com/guide/iphone/complete-items-iph3fb74d597/ios))
- Sharing: "People who accept the invitation can add and edit items, mark items as completed, and all the participants can see everyone's changes." Per-list alerts for "Adding Items" and "Completing Items". Activity updates appear in Messages if the invite went that way. ([Share lists](https://support.apple.com/guide/iphone/share-and-collaborate-iph2a8f9121e/ios))
- Silent on favourites or recents for groceries, on duplicate merging, offline, and conflicts.

### Listonic

- Several lists ("Weekend shopping", "Birthday party"). "Start from last week's list and change only what's different" by copying. "Mark the whole list done in one go, or uncheck it all to use it again." ([Features](https://listonic.com/features))
- On a shared list a checked item "goes gray on everyone else's screen instead of getting bought twice." Notifications cover add, edit and check off, and name the person. Sharing "doesn't merge two lists you already have". ([Share lists](https://listonic.com/features/share-lists))
- Offline: "the shared list opens, items check off, and edits hold. The moment the connection comes back, everything you did syncs out to everyone else, and everything they did syncs in." (same page) The page does not say what happens when both sides changed the same line.
- Checked versus deleted: "Unlike checked-off items, the deleted items are permanently removed from the list". Bulk action: "Delete purchased items". Deleting an item drops its notes and photos. ([Delete an item](https://helpcenter.listonic.com/how-to-delete-an-item/))
- Reuse: "uncheck all the items on your lists with two taps to quickly reuse your shopping list during the next shopping trip" (Android only). ([Uncheck all](https://helpcenter.listonic.com/how-to-uncheck-all-items-at-once/))
- Recents: "More than half of products on a weekly shopping lists are usually the same", so Listonic suggests recent items from product history. "The items you don't buy regularly will disappear from your purchasing history after some time." ([Recent searches](https://helpcenter.listonic.com/how-do-recent-searches-work/))
- Quantity: each item has a quantity. While adding, "tap again on the added item to increase its quantity". ([Add an item](https://helpcenter.listonic.com/how-to-add-an-item-to-a-list/), [Add quantities](https://helpcenter.listonic.com/how-to-add-quantities/))

### OurGroceries

All from the [User Guide](https://www.ourgroceries.com/user-guide):

- "Most people create one shopping list per store that they visit."
- Tapping crosses an item off and moves it "to the bottom of the list, below the 'Add an item...' row". Tapping again uncrosses it and brings it back to the top. Crossed-off sort options include "Recently crossed-off at top" (default) and "Common items first".
- "Delete all crossed-off items..." clears them. "It won't remove them from other shopping lists or recipes, or remove them from your item history."
- The master list holds "all the items you've ever entered", ordered by how often each was added.
- Quantity is text: the number in "Potatoes (2)" is "just part of the name like the rest of it". Silent on adding an item that is already present.
- Recipes: tap recipe items to add them, or use "Add recipe to shopping list".
- Sync: "any change made to a list by either person will be seen by the other instantly". "The app tries to contact the server every 20 seconds when the app is open". "If your device can't reach our server, then your changes won't be visible to others, and others' changes won't be visible to you."
- Silent on conflict resolution.

### Todoist

- Completing a task hides it from the active list. Turn on "Completed tasks" in Display to see completed tasks at the bottom, and uncomplete them to restore. Bulk delete is possible. ([View completed tasks](https://www.todoist.com/help/todoist/features/view-completed-tasks-in-todoist-J19h2s))
- Recurring: completion "moves it to its next date automatically", and the task "stays in its project rather than disappearing". "Complete forever" ends the recurrence. ([Complete a recurring task](https://www.todoist.com/help/todoist/features/complete-a-task-with-a-recurring-date-dmI6SVqdP)) This is the only app here where a ticked line comes back by itself.
- Shared projects give everyone "full access". The vendor names a grocery list with a spouse as a use case. ([Collaborate with family](https://www.todoist.com/help/articles/collaborate-with-friends-or-family-in-todoist-tzkGUy))
- Offline: changes "sync automatically as soon as you're back online". Do not log out or clear data first, or "those changes are deleted". ([Use Todoist offline](https://www.todoist.com/help/todoist/features/use-todoist-while-offline-4rbaZw))
- Sync API: "Todoist will not execute a command that has same UUID as a previously executed command", so clients can retry safely. Commands in a request run in order. The page has no conflict rule. ([Todoist API v1](https://developer.todoist.com/api/v1/))

## Patterns observed

### Where the apps converge

1. **One living list per household (or per store) is the default.** AnyList says so outright, and the others offer no per-week list at all. Per-trip behaviour is built on top: Listonic's copy list and uncheck all, Keep's reusable note.
2. **Ticked lines persist until an explicit clear.** AnyList, OurGroceries, Listonic, Keep and Reminders keep ticked lines in a struck, greyed, bottom-sorted or hidden state. Clearing is a separate, manual, whole-list action ("Delete Crossed Off Items", "Delete all crossed-off items", "Delete purchased items", "Clear"). No vendor documents automatic clearing on a schedule or on a trigger.
3. **Item memory lives outside the list.** History, master list, recents and favourites survive clearing. Re-adding is a tap on remembered items, not retyping.
4. **Undo for an accidental tick is cheap.** Tap again to uncross (OurGroceries), shake or banner (AnyList), restore from Recently Used (Bring!).
5. **Sync is presented as instant, and edits are attributed.** Bring!, Listonic and Reminders tell the other person who added or ticked what.

### Where they split

1. **Tick as state versus tick as removal.** Most keep a checked flag on the line. Bring! deletes the line into a tray. State gives a visible "already in the basket" signal to the other shopper, which Listonic sells as the point of greying. Removal keeps the aisle view short but leaves nothing on screen to show what the other person already took.
2. **Duplicate handling.** AnyList refuses duplicates: re-adding an existing line uncrosses it. Bring! allows a second line if the description differs. Listonic increments quantity while adding. OurGroceries and Keep treat quantity as text and are silent on duplicates.
3. **Merging from recipes.** Only AnyList documents merging several sources into one line with a summed quantity and per-source shares you can remove. OurGroceries adds recipe items but is silent on merging.
4. **Offline.** Listonic and Todoist document local edits with sync on reconnect. OurGroceries documents that edits stay invisible to others until the device reconnects. Bring!, AnyList, Keep and Reminders say nothing.
5. **Conflicts.** Every vendor is silent. Todoist documents only idempotent retries.

### Options for a household list that a weekly planner appends to

These map the patterns onto the current model, in which Checked Off, Extra Item and Removed Line are keyed per Weekly Plan and a Plan Run rebuilds the list.

**A. One living list; a Plan Run appends lines with provenance (the AnyList recipe model).**
Each line carries the Dishes or weeks it came from, plus manual additions. A Plan Run adds or raises lines and never wipes ticks.
- For: matches how both parents already think ("the list"). Lines added mid-week survive. Ticks survive a re-run. Per-Dish shares make a Swap a subtraction rather than a rebuild.
- Against: Removed Line and Checked Off lose their week key and need a new meaning. A merged line needs rules for a tick when a new Dish adds more of the same Ingredient: uncross it, as AnyList does on re-add, or leave it ticked. Units must sum (AnyList is silent on this).

**B. Keep per-week lists; carry unticked lines forward.**
The week stays the unit. Starting a new week copies over what was not bought, like Listonic's "start from last week's list".
- For: smallest change to the current keys. "Done shopping" is the week boundary.
- Against: no app here models a grocery list this way. Mid-week extras, and a shop on Sunday for Monday, fall across the boundary. Two lists can be live at once around the boundary.

**C. Living list, lines tagged with the week that wanted them (hybrid).**
One list on screen. Each line remembers the Weekly Plan it serves, so a Plan Run for week N touches only week-N lines.
- For: re-runs stay safe and the history stays legible. Manual lines are untagged and live until cleared.
- Against: the same Ingredient for two weeks becomes either two lines or one merged line with two tags. That means the merge rules of A plus the tag bookkeeping.

Choices that hold whichever list model you pick:

- **Tick fate:** stays visible and struck until cleared (majority) versus vanishes into a "recently used" tray (Bring!). With two shoppers in different aisles, a visible struck line tells the other one it is in the basket.
- **Clear:** manual "clear ticked" (every app that documents clearing), versus automatic on the next Plan Run, versus automatic after a time. Automatic clearing has no documented precedent here.
- **Re-add memory:** whether item memory comes from Dish Ingredients only, or the app also keeps a recents or favourites store for Extra Items. The "Check pantry" section already plays a role close to Bring!'s purchase-interval suggestions and AnyList's favourites.
- **Offline in the aisle:** ADR-0008 leaves this household with no service worker over plain HTTP, so every tick is a round trip over the tunnel. Listonic and Todoist queue edits locally. OurGroceries accepts invisible edits until it reconnects. No vendor documents conflict resolution, which suggests last-write-wins per line is the unstated norm, but I could not verify that.

## Open questions for the grilling session

1. Is the Shopping List one living list (A), per week (B) or a tagged hybrid (C)?
2. What does a Plan Run do to a line already on the list: add to its quantity, leave it, or uncross it if it was ticked?
3. What does a Swap or a re-run do to a ticked line whose Dish is gone? Does it stay ticked, vanish, or become a manual line?
4. Does Removed Line survive, and keyed to what? In a living list "removed" may just mean deleted, with a guard so the next Plan Run does not add it back.
5. What is "done shopping"? An explicit clear-ticked action, the next Plan Run, or nothing (ticked lines age out)?
6. Do ticked lines stay in place, sink to the bottom, hide, or leave the list as in Bring!?
7. Does the app need item memory for Extra Items (recents or favourites), or is free-text entry enough?
8. Should the other parent see who ticked a line (Bring! activity, Listonic and Reminders notifications), or only that it is ticked?
9. With no offline copy over HTTP, is a failed tick in a dead zone acceptable, or does store use need HTTPS and the dormant offline code (#110) first?
10. Two parents tick the same line, or one ticks while the other deletes it: is last write wins per line enough?
11. How do quantities merge across Dishes when units differ, given the "same Ingredient merges into one line" rule in GLOSSARY.md?

## Sources

All fetched 2026-10-18.

Bring!
- https://www.getbring.com/help-center-main-categories/items-lists
- https://www.getbring.com/help-center-main-categories/inspirations-suggestions
- https://www.getbring.com/help-center-main-categories/if-nothing-else-helps
- https://www.getbring.com/en/features/anywhere-anytime
- https://www.getbring.com/blog-posts/your-activities-at-a-glance
- https://apps.apple.com/us/app/bring-grocery-shopping-list/id580669177

AnyList
- https://help.anylist.com/articles/weekly-shopping/
- https://help.anylist.com/articles/show-hide-completed-items/
- https://help.anylist.com/articles/delete-crossed-off-items/
- https://help.anylist.com/articles/restore-crossed-off-item/
- https://help.anylist.com/articles/cross-off-items/
- https://help.anylist.com/articles/recent-items/
- https://help.anylist.com/articles/favorites/
- https://help.anylist.com/articles/starter-lists/
- https://help.anylist.com/articles/autocomplete-icons/
- https://help.anylist.com/articles/add-recipe-ingredients-to-list/
- https://help.anylist.com/articles/remove-single-ingredient-from-list/
- https://help.anylist.com/articles/meal-planning-calendar-add-recipe-ingredients/
- https://help.anylist.com/articles/share-list/
- https://help.anylist.com/articles/sync-devices/

Google Keep
- https://support.google.com/keep/answer/6395451?hl=en&co=GENIE.Platform%3DAndroid
- https://support.google.com/keep/answer/6358550?hl=en&co=GENIE.Platform%3DAndroid
- https://support.google.com/keep/answer/6101196?hl=en&co=GENIE.Platform%3DAndroid
- https://developers.google.com/workspace/keep/api/reference/rest/v1/notes

Apple Reminders
- https://support.apple.com/HT213830
- https://support.apple.com/guide/iphone/make-a-grocery-list-iph80ba26e1f/ios
- https://support.apple.com/guide/iphone/complete-items-iph3fb74d597/ios
- https://support.apple.com/guide/iphone/share-and-collaborate-iph2a8f9121e/ios

Listonic
- https://listonic.com/features
- https://listonic.com/features/share-lists
- https://helpcenter.listonic.com/how-to-delete-an-item/
- https://helpcenter.listonic.com/how-to-uncheck-all-items-at-once/
- https://helpcenter.listonic.com/how-do-recent-searches-work/
- https://helpcenter.listonic.com/how-to-add-an-item-to-a-list/
- https://helpcenter.listonic.com/how-to-add-quantities/

OurGroceries
- https://www.ourgroceries.com/user-guide

Todoist
- https://www.todoist.com/help/todoist/features/view-completed-tasks-in-todoist-J19h2s
- https://www.todoist.com/help/todoist/features/complete-a-task-with-a-recurring-date-dmI6SVqdP
- https://www.todoist.com/help/articles/collaborate-with-friends-or-family-in-todoist-tzkGUy
- https://www.todoist.com/help/todoist/features/use-todoist-while-offline-4rbaZw
- https://developer.todoist.com/api/v1/
