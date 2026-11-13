# Original module application, conversion and activation

The original advanced-character actions now persist in entity mode. Ordinary
mode retains the original conversion/application algorithm. These controls use
public original code and authored fixtures; no installed module or saved card was
opened.

## Application and conversion

`applyModule()` captures the original character's three collection values and
revision/epoch before opening the selector. Its catalog fetches summaries in
pages of 50 and can search/load more. Choosing a row fetches only that module's
full body. Original lorebook/regex/trigger items append in their original order,
including their unknown portable members. One `change-fields` command persists
all affected collections atomically. Applying copies a selected detached module;
it does not create a live activation link or copy its image/assets/background.
Those omissions are the original apply action's semantics.

The captured owner cannot follow a different character selection. A changed
collection, including a peer A→B→A with the original value restored, rejects an
old picker. A later server conflict rejects the whole group and retains the
explicit pending conflict. `commitFields()` exposes immediate intent through the
existing field overlays/outbox but registers its completion waiter before
admission and waits for projection before displaying success. IDB/admission
errors reject the waiter; tab exit leaves the durable command for replay.

Character conversion reads only the sixteen source fields used by the original
`convertCharacterToModule()`. It snapshots pending field overlays and passes an
independent copy to the unchanged converter, including original indicator lore
for description, first/alternate greetings and global-note replacement. Chat
histories and unrelated character fields are excluded. Optional undefined object
members use the original portable JSON omission; mapped arrays/assets retain
unknown nested/tuple members. The resulting new UUID module and membership are
saved through the existing library transaction. Source character values stay
unchanged and success appears only after confirmation.

## Activation and acceptance

The same popup now shows the bounded server catalog in chat mode. A normal click
toggles the captured chat's module IDs; the original context-menu action toggles
the captured character's IDs. Pending values/color update immediately and use the
durable field outbox. Globally enabled modules remain disabled in this popup.
Merely opening it does not initialize missing arrays or originate commands.

`server/browser/characterModuleUi.test.cjs` exercises desktop and both emulated
mobile layouts against an independent desktop profile. It checks a61-module
catalog without body reads, the chosen body and three-field atomic save, original
conversion markers/assets, source preservation, peer ABA and post-staging
conflicts, navigation, global/chat/character activation, offline all-tab exit and
replay of both membership and staged application. The baseline public components
show local mutations with no server/peer persistence. The optimized original
CLI case additionally converts its authored native-script character and discovers
it in the peer picker.

The copied module is a selected snapshot; subsequent resource edits do not mutate
the copied script arrays. Initial catalog/body reads require server availability.
An earlier edit to the same collection confirming while its picker is open can
also conservatively reject the selection; settle that edit before applying again.
This is not full offline initial startup or physical-phone/OS suspension proof.
The original context-menu character activation remains awkward on touch devices;
an explicit touch control and wider mobile acceptance are still open. The copied
reference tuples are preserved; this port does not newly validate referenced
asset bytes or add missing files. Arrays remain aggregate fields, so concurrent
edits to the same collection conflict explicitly rather than merge itemwise.

Native TTS, memory/asset/plugin editing and capability coverage, complete read
provenance/resource budgets, large HTML/Worker/cold latency and actual human
acceptance remain required. All15 original checklist items and their hash remain
unchanged. No production access, private data, real provider call, deployment or
remote push is included.
