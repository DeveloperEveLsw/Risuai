# Original Hypa V3 editor in the entity runtime

The original modal retains summary text, importance, tags, categories, search,
linked messages, bulk edits, deletion, reset, and V2 conversion. Its entity-mode
draft belongs to the character, chat and incarnation captured when opened.
Opening an absent V3 field does not create one. Ordinary browser storage keeps
the original path.

Persistent edits use guarded field commands. Delayed confirmations retain their
original draft and revisions. V2 conversion guards both the V2 read and V3 write
in one transaction. Another device's edits or a replaced conversation cannot
silently overwrite those reads. Offline commands retain the existing durable
outbox and visible conflict choices.

Linked message references use the read-only memory-source endpoint. Membership
queries contain at most 256 stable IDs; individual sources contain only the
requested message or selected greeting. The modal does not hydrate the entire
chat. The reader batches references and bounds its body cache to 16 entries and
2 MiB. Responses from an older source clock are rejected.

Single and bulk re-summary run as durable server jobs. Closing every tab does
not cancel an admitted job. Its generated text stays in the paid preview until
the user applies or dismisses it. Applying can include an explicit edited text;
the server owns the selection, source guards, memos and existing unknown fields.
The original generated text remains available. Immutable command receipts retain
the applied edit across restart. Queued/running admitted jobs expose cancellation.

Completed summary results can be reopened from the existing recent job list.
That list is bounded to 50 recent jobs; an unlimited historical result browser is
still outstanding. Translation retains the original browser handler. Real
translation providers, physical phones, and ordinary-mode functional acceptance
are not covered by the authored loopback browser fixtures.

See `evidence/local-hypa-modal-20261005.json` and the deployment receipt in the
workspace for exact validation and release hashes. The original 15 project
completion conditions remain active; this milestone does not prove that the
entire optimization and compatibility goal is complete.
