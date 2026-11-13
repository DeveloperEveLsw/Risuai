# Original script editors and server field commands

The character Scripts page and Global Regex settings now edit detached field
drafts in entity mode. Their original regex, flag, import/export and Lua/V1/V2
components remain in use. The character `customscript` and `triggerscript`
fields and settings `globalscript` go through durable `change-fields` commands.
The ordinary browser mode keeps its existing data binding path.

`RuntimeObjectField.svelte` gives nested bindings a private reactive copy, never
the confirmed DBState or pending outbox object. It watches only that field, keeps
the revision and incarnation of the visible value, and forwards changed values
to the existing controller/outbox. A peer projection cannot erase an edited draft
before its flush or replace its read revision. Confirmed and pending values update
the editor without originating another write. A keyed stable character owner and
destruction flush preserve the old target when navigation occurs in the input
event. Server and outbox conflict resolution remain authoritative.

An import captures a detached field, stable target and version before the file
chooser. A changed draft or field clock rejects the obsolete import visibly. It
does not overwrite a peer's newer script. Original JSON import/export retains
unknown fields. This is a field aggregate boundary: nested rules/effects are
portable arrays, not individually normalized rows or separately mergeable edits.
Two edits of different rules within the same array can still conflict. Each
mutation serializes that changed field; large script arrays still need sizing and
latency measurement. There is no whole-archive save or automatic command replay
from arbitrary DBState mutation.

The Custom Flag checkbox renders a missing optional flag as false without writing
that default on binding initialization. This prevents opening the editor on two
devices from creating conflicting field changes. The conditional setter also
applies to original/browser and module drafts; actual flag changes retain their
original behavior.

The browser fixture `server/browser/scriptEditorsUi.test.cjs` uses authored neutral
regex/Lua, two independent browser contexts and an isolated loopback database.
It covers nested fields, unknown data, real JSON file chooser/download, stale
import rejection, same-field conflict and server selection, an offline edit that
survives every tab closing, reload, and navigation during an edit. Its negative
control observes local changes that never reached the database before this port.
Fresh gate results and all failed intermediate logs belong to the milestone
receipt, not this source description. This fixture exercises desktop Chromium;
physical mobile, every V1/V2 operation, huge arrays and provider combinations are
not established by it.

To try the current source, run `pnpm trial:local`, select the synthetic character,
open Character → Scripts and edit its regex or Lua. Open the same local trial in
a second independent browser to observe the confirmed change. For global rules,
open Settings → Global Regex. Trial responses use its loopback provider; there is
no real-model charge. Keep the authored trial Lua functional when testing native
generation. See [local-user-trial.md](local-user-trial.md) for startup, the fresh
synthetic password, lifecycle checks and limitations.

[Lorebook editors now have their own field port](server-lore-editors.md).
Remaining character definition/asset/TTS fields, plugin management, wider
extension/read contracts and representative mobile performance still require
their own command ports and validation. Existing module/preset resource ports
are not replaced. All fifteen requirements in `server-runtime-plan.md` remain
active; this storage/edit milestone does not declare the entire goal complete.
