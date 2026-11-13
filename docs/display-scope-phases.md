# Display scope cost diagnosis

The fresh CBS environment and private mutable shells are small in these authored
fixtures. Optimizing their copy is not supported as a remedy for second-long
settlement. This milestone changes documentation and diagnostic scripts only;
the runtime implementation remains451258e/schema21.

## Observations

One click on desktop and one with page CPU4x for each of three conditions use
the unchanged actual UI helper:100 rows,1 or96 HTML cells per row, and0 or600000
extra Lua loop iterations. A separate copy of the optimized build instruments25
semantic AST locations in the main/database, controller and actual Worker assets.
Original and copied artifact/source fingerprints are checked before and after.
Each actual Worker is identified by name and URL. No source overrides or HMR.

Inclusive diagnostic wall time in milliseconds per click:

| Condition       | Target     | Environment | Fork | Prepare | Scope key | postMessage | Reference parse | Original Lua |
| --------------- | ---------- | ----------: | ---: | ------: | --------: | ----------: | --------------: | -----------: |
| small-idle      | desktop    |         1.7 |  4.6 |     1.3 |      34.9 |        18.4 |             3.4 |         23.1 |
| small-idle      | page CPU4x |         0.8 |  6.9 |     5.9 |      94.1 |        59.1 |             3.8 |         22.0 |
| large-idle      | desktop    |         0.9 |  1.8 |     1.6 |      26.7 |        18.8 |            54.8 |        144.0 |
| large-idle      | page CPU4x |         7.2 | 12.4 |     5.4 |     118.6 |        67.8 |            55.4 |        145.5 |
| large-extra-lua | desktop    |         0.8 |  1.8 |     1.4 |      22.0 |        20.1 |            50.9 |        650.0 |
| large-extra-lua | page CPU4x |         5.8 | 12.5 |     5.2 |     113.0 |        64.8 |            53.9 |        665.7 |

Each click has220 private forks/environment pins/scope key calculations, one
complete body preparation,107 capture packets/Worker Lua calls,106 labelled
computations and94 independent rows. Final values and stable row/body DOM pass
the unchanged helper predicates. The extra unlabelled call is the greeting.

The first already copied private environment per page has6 fields,11 model
metadata fields,8 model flags and480 serialized UTF-8 bytes. Its private database,
character and chat shells have271/32/9 own enumerable keys. This is an initial
fixture shape, not a limit on arbitrary cards/models or later variable maps.
The fixture environment includes model/trigger/platform/version metadata.

## Interpretation and next work

Environment pins take0.8–7.2ms per click; all private forks including those pins
take1.8–12.5ms. Full preparation occurs once and takes1.3–5.9ms. The existing
shared body avoids preparing it for every row. Those observations do not justify
an environment cache as the fix for the remaining stalls.

Scope key encoding takes94.1–118.6ms with page CPU4x; sender encoding including
its nested checks takes150.7–187.8ms, and postMessage takes59.1–67.8ms. Large
captures independently parse116844107 characters over107 calls, around51–55ms,
while small captures parse2808857 characters, around3–4ms. Original Worker Lua
execution goes from roughly144–145ms to650–666ms when the fixture adds loops.
These categories overlap; Lua timings include asynchronous VM/API work.

Next diagnose the scope key's fresh private trigger wrappers. The database,
character and chat forks are bound to their frozen base, whereas individual
shallow trigger copies are presently encoded as ordinary objects. Measure code
length/module-count sensitivity before changing that representation. Preserve
fresh fields, unknown metadata, original callbacks and their stateful ordering;
never skip legacy Lua just because its visible output was unchanged. Receiver
objects remain private. First CBS, DOM/layout, cold/concurrent work and the full
compatibility/storage/mobile/trial contracts remain in scope.

## Verification and limits

Three terminal diagnostic executions and all six clicks pass. Type checking
reports0 errors and0 warnings. The prior971 regressions and144 warm observations
belong to451258e and are referenced without rerunning or counting them again.
The instrumented six clicks are not latency acceptance or speedup evidence.
No product guard, fixture predicate or timeout changed.

The first preparation missed a minified comma return; the second missed the
separate controller asset. Their failure summary/raw log and temporary copies
are preserved. Final semantic AST locations and all artifact hashes are checked.

Nested timing, clock precision and instrumentation overhead prevent CPU/heap
attribution or meaningful addition of the rows. Page CPU4x does not prove Worker
throttling or physical mobile behavior. Initial shape reads happen after copying
private values, once per page, without new reactive source getter reads. No
production access/changes, private content/auth/installed script reads, actual
model calls or remote push. All15 completion conditions remain unchecked with
the exact original hash. Performance is not resolved and the whole goal remains
active. Evidence and reproducible procedures:
[display-scope-phases-validation.json](display-scope-phases-validation.json).
