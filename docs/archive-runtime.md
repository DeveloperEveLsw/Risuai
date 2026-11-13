# Original archive workflows in the local runtime

Later local milestone: [complete original data backup and dataset](original-backup-runtime.md) covers detached coherent history/assets export and a real writer-to-CLI restoration roundtrip. Server operational-state/variant preservation and complete format/restore acceptance remain active.

Original CharX, JPEG-embedded CharX and legacy/current module packaging now use shared server assets in entity mode. This is a local compatibility milestone. All 15 completion requirements remain in scope and the configured user trial remains unfinished.

| Boundary                   | Server-mode contract                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CharX asset extraction     | Pass the ZIP member name to shared storage, preserving useful media extensions. Image MIME still follows actual bytes.                                                                           |
| Legacy `.risum` extraction | Preserve each asset's original format metadata when saving decoded bytes. Validate framing, metadata shape and declared/actual asset count before uploading.                                     |
| Module installation        | Omit optional undefined fields using original JSON persistence semantics, then allocate a new stable ID and issue one durable library command. Unknown JSON data stays intact.                   |
| Modern module export       | Keep the original conversion and CharX writer. An optional provided writer supports synthetic acceptance; the normal picker/download path is unchanged.                                          |
| Failed package             | Missing files, malformed data or rejected uploads must not install an incomplete canonical character/module. Already uploaded unreferenced blobs follow the conservative asset retention policy. |

The earlier shared uploader defaults to a `png` suffix when no filename is supplied. Original CharX and legacy module loaders previously omitted filenames even though the archive metadata contained them. Image signatures still produced appropriate image MIME, but WAV media consequently used the default suffix and download MIME. The supplied synthetic regression fails at the original archive extension assertion before this change. Passing names/formats in server mode fixes that boundary while preserving ordinary browser storage behavior.

Original character-to-module conversion creates optional undefined properties that are legal in upstream memory. Durable JSON commands reject these values. Module installation now performs the same JSON serialization normalization as original persistence before submitting its immutable command. This preserves unknown JSON fields and the meaning of absent optional fields.

For server-mode `.risum`, truncated declared data, malformed asset metadata, fewer/more asset entries or trailing data reject before canonical installation. Null/absent empty asset lists remain valid and null values are preserved. Invalid magic/type results cannot create an empty phantom module.

Server-mode CharX records inflate errors rather than passing null callback data into the buffer. A declared ZIP member larger than the original 50 MiB limit rejects without starting that member. A rejection observer is attached immediately to the original completion promise; the caller's `done()` still reports the failure. This avoids an unhandled rejection while other package processing awaits. Unknown-size streamed members still use original synchronous inflation and post-extraction size policy. This is not a complete archive expansion/memory budget or hostile archive sandbox.

## Actual browser evidence

`server/browser/archiveUi.test.cjs` launches the original app against a temporary server and two independent Chromium device contexts. It uses a newly drawn image, a 0.1-second silent WAV and neutral synthetic card/module definitions.

- Original CharX/JPEG export/import and original legacy/current module workflows preserve encoded image bytes, WAV bytes, Unicode asset names, supported metadata and new canonical IDs. Temporary character conversion for a module creates no canonical character.
- The original image compressor's PNG-to-WebP behavior is retained. Image byte expectations come from that original encoder; the test does not promise unchanged raw PNG bytes through compression.
- The second device reads the same WAV bytes through original `readImage/getFileSrc`, and a real audio element decodes the expected duration. The original module catalog observes imported definitions.
- Unknown character and legacy module fields and nullable empty assets survive. Modern module conversion retains the original mapped fields; complete preservation of unmapped module extensions is not established.
- Missing files, truncated/trailing legacy data, invalid magic, corrupt deflate, declared oversize and an actual HTTP upload failure do not add canonical resources. Browser error/unhandled-rejection collections stay empty.

The first concurrent regression run had one existing lifecycle fixture exceed the 10-second CDP evaluation limit. The unmodified fixture passed alone. The original failed log is retained and the full suite is rerun without changing its assertions, timeouts or test concurrency. Exact final results are recorded in `local-validation.json` and the root archive validation evidence; the isolated pass does not replace full-suite acceptance.

## Remaining scope

Complete backup/history/restore, asset aliases/lifetime/offline policy, file-picker acceptance, alternative asset/native/provider capabilities, unmapped module extensions, unknown-size archive expansion limits and representative mobile/performance checks remain necessary. `.risum` icon portability is not established where original metadata references an external icon rather than embedding its bytes. No production access, private data import, deployment or remote push occurred.
