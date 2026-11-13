# Original lore editing through server commands

The entity runtime uses the original LoreBookList/LoreBookData controls with
detached drafts for character `globalLore`, chat `localLore`, character
`loreSettings` and `lorePlus`. Character/chat owners are keyed by their stable IDs.
Nested bindings, folder additions/removals and bulk activation submit only changed
fields through the existing durable outbox. Collection fields remain arrays; this
does not normalize every lore entry into its own relational row.

“Always Active (Current Chat)” retains the original parent/child semantics. When
the parent has no ID, assigning its UUID and adding the empty child reference to
the current chat occur in one `change-fields` transaction with separate captured
field revisions/epochs. Deactivation removes the child and retains the parent ID.
Module lore still uses its existing module draft/save contract. The legacy global
lore page whose upstream list was removed is not reinstated by this port.

Captured private values never alias DBState or an outbox payload. Optional absent
fields can be removed without inventing an empty array. Opening the Use Regex,
Full Word Matching or LorePlus checkbox does not persist a default false. Existing
portable IDs, folder keys and unknown JSON fields survive native Risu imports and
exports; external entries continue through the original converter. A file chooser
captures its owner and field clock before waiting. Peer ABA changes are rejected
even when the JSON becomes equal again. Destructive confirmation also captures
the parent/chat fields, so a peer edit during confirmation cannot delete newer
data. Competing writes retain explicit conflict resolution instead of merging
arrays or silently overwriting the winner.

The read model now forwards the complete character body's cursor into field
reconciliation. Previously an unloaded field receipt could establish a clock
whose same-version full body was compared against cursor -1, protecting an empty
placeholder. Fresh complete bodies now hydrate that field; delayed older bodies
still cannot overwrite a newer field. Field admission checks whether the specific
chat metadata is loaded, allowing navigation's last captured edit to target its
old loaded chat while the next chat is opening. Server versions/incarnations and
outbox dependency checks remain in force.

`server/browser/loreEditorsUi.test.cjs` uses actual Vite UI, two independent
Chromium contexts and authored neutral data. It exercises character/chat edits,
peer propagation, independent owners, parent/child atomic admission, settings
creation/removal, optional defaults, real file selection and download, ABA,
folder creation/deletion, bulk activation, confirmation races, competing fields,
all-tab offline replay and both character/chat navigation. The focused read-model
regression also verifies delayed-body protection. These are desktop browser
contexts, not a physical phone or complete SortableJS drag/reorder acceptance.

For direct trials, run `pnpm trial:local` on a fresh unused loopback port and log
in with its separate synthetic password `local-trial`. Select **로컬 구조 시험**,
open Character → Lorebook and edit **합성 로어 편집 시험** in two independent
browser profiles. Enable **Always Active (Current Chat)**, inspect the Chat tab,
then select **독립 채팅** to check separation. Changes should survive closing all
tabs and reopening the same trial origin while its terminal keeps running.

Remaining work includes the other character definition fields (including prompt
configuration, bias and alternate greetings), asset/TTS/plugin editor persistence, complete extension
and read provenance, larger collection storage/budgets, representative latency,
physical mobile lifecycle and human acceptance. No production source/data,
installed scripts, provider credentials or real model is accessed. All fifteen
requirements in `server-runtime-plan.md` remain active.
