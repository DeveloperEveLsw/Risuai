# Original character TTS settings and shared reference files

The original character TTS pane now submits its eleven portable fields through
`RuntimeObjectFields`: provider, speech, VOICEVOX, NovelAI, legacy/advanced OpenAI,
Huggingface, VITS, GPT-SoVITS, Fish Speech and quote-only settings. Provider changes
and speech reset belong to one command; a missing provider configuration is created
only by an explicit change. Opening a partial definition displays the original
defaults without storing them. Unknown nested members survive edits.

`CharacterTtsSettings.svelte` contains the original controls, ranges, voice lists
and upload entry points. Ordinary browser mode uses the same controls and retains
its existing initializers. Entity mode supplies detached character field drafts
with stable IDs, field revisions/incarnations, the durable outbox and explicit
conflict resolution. Provider objects and VITS file maps remain portable field
aggregates, rather than independently normalized settings rows.

## Async ownership and media

Both model ZIP and reference audio actions capture the character field and provider
before the original picker/upload awaits. Confirmation uses fresh clocks: another
device's A→B→A provider changes reject an old picker result. Character navigation
cannot redirect it into the new character. Reference audio keeps unknown metadata
and passes its original filename to asset storage, preserving its media extension.
VITS retains the original ZIP registration logic and resource shape.

The current guard is conservative when earlier edits to the same captured fields
have not been confirmed: their later confirmation can invalidate the upload. The
accepted media checks start after those fields are confirmed. A general pending
picker settlement/retry interaction remains open; its guard was not weakened.
Rejected uploads can leave immutable unreferenced assets under the existing asset
retention policy. Picker cancellation, archive-wide resource accounting and large
model ZIP memory/storage limits are separate remaining work.

## Validation boundaries

An optimized two-profile trial exposed a stale incoming aggregate encoding: the
server stored a new model name while the peer retained the earlier configuration.
Read-model reconciliation preserves object identity, so source identity alone is
insufficient to invalidate that encoding. Each field now observes its confirmed
revision/epoch as well as its value; equal clocks do not re-encode unrelated fields.
The expanded optimized CLI case checks successive model values. It fails with the
previous optimized build and passes with this clock guard. Captures still compare
fresh clocks and reject ABA changes. A separate six-edit diagnostic keeps zero
encodes of the six unchanged 131072-character fields; its timing is not a speedup
claim. The earlier two-encode measurement belongs to the historical `8f31f6d` build.

`server/browser/characterTtsUi.test.cjs` uses actual original controls in desktop,
Android/touch emulation with the ordinary mobile layout and beta mobile layout.
Each case has a second independent desktop browser context. It checks all enabled
provider controls, atomic reset, partial definitions, nested unknown values,
different-field concurrency, same-field conflict resolution, all-tab offline
restoration, owner navigation and reload. Authored PCM WAV bytes and a tiny dummy
ONNX ZIP are uploaded and loaded by the other context; byte fidelity is asserted.
The dummy model is not an ONNX inference or audio synthesis test.

Enumeration is mocked before navigation and other external fetches are rejected.
The native scheduler is stopped; no real provider/model requests run. The negative
control supplies only the previous `8f31f6d` CharConfig source through Vite's main
module loader: the old visible provider edit sends no field command and leaves the
server and peer unchanged. Synthetic fixtures contain no existing save data or keys.

This port covers configuration persistence and media sharing. In the original
generation pipeline, `ttsAutoSpeech` invokes `host.sayTTS`; the current native host
still has no `sayTTS` implementation. Enabling automatic TTS can therefore fail a
native generation with a capability error. Server speech production, browser audio
delivery/playback, real voices, physical mobile suspension and voice availability
across operating systems remain unverified. Ordinary browser TTS code is retained,
but the new automated provider-control matrix exercises entity mode.

Results and failed attempts belong to the milestone receipt; repeats and the
negative control are not added to unique acceptance counts. No latency speedup is
claimed by this settings port. All original requirements in
[the checkpoint](server-runtime-checkpoint-20261005.md) remain in scope.
