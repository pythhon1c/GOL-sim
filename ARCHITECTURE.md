# Architecture

## Canonical state

The world is a finite rectangular field of live/dead cells, evaluated with Conway B3/S23 and all eight neighbors. A complete generation commits after all tasks finish reading the preceding state. The default exterior is dead; optional wrapping maps neighbors to the opposite side. The public API requires wrapped dimensions of at least three cells.

Rust (`native/`) stores nonempty bit-packed tiles in a sparse map. Each generation considers active tiles and their immediate neighbors. Rayon calculates independent outputs with halos from the old generation. Integer bit planes evaluate many cells per word. Distant empty tiles need no per-cell work.

Python (`life/`) owns the serialized worker, configuration, pacing, exports, checkpoints and HTTP API. `ctypes` calls the C ABI in `native/include/life_native.h`. Only the documented atomic progress call can read the same native handle concurrently with a step. The controller serializes mutations, rendering and state replacement.

## Reuse and boundary guards

The transition cache records complete tile inputs, required boundary data and exact outputs. Hashes locate candidates; exact comparisons establish matches. Cache hits reuse a correct transition without changing the generation counter or skipping unverified interaction.

Optional cycle helpers begin at a configured generation and search at a configured cadence. Stored phases are reused while the relevant neighborhood satisfies their boundary guards. Incoming changes invalidate the shortcut and normal calculation resumes. Helpers have a separate memory budget and can be evicted. Detection and eviction affect speed, not the rules. This implementation is not HashLife.

## Randomization and resources

A packed coordinate and a 64-bit seed determine random bits for each position. A Bernoulli density threshold selects live cells. Chunking, thread count and tile size do not affect the final state. The server handles large rectangle randomization with progress reporting. Transactional replacement preserves the previous world when a candidate import or randomization fails.

Sparse dimensions are cheap, dense tiles and working buffers are not. Allocation preflight, bounded caches and optional helper eviction limit estimated native memory. Python objects, thread stacks, allocator overhead, compression and browser memory need additional allowance. CPU ceilings use worker selection and pacing; minimum utilization is not manufactured with artificial work.

## Browser and localization

`web/` uses classic scripts, with no bundler or mandatory CDN. The standalone editor opens from a file URL and loads local pattern wrappers on demand. The monitor fetches only the viewport at suitable levels of detail. Display size and zoom determine aggregation, and neighboring results are cached within a budget. Aggregate populations are exact; gray saturation affects visibility only. Empty aggregates stay black.

The thermal view combines observed recurrence period and population. Unknown/active regions are warmer, period-one regions colder, and density raises both. Coarse levels combine occupied children with a configurable hotspot weight. This heuristic is unrelated to transitions and does not claim to measure thermodynamic or Shannon entropy.

`i18n.js`, `config-locales.js` and `catalog-locales.js` supply English, Russian and Ukrainian display text. English is the initial language; a browser preference saves explicit changes. Translations do not change API keys, pattern IDs, coordinates, states, configuration values or checkpoint formats.

## Persistence and deployment

Checkpoint segments carry checksums and a manifest. The writer follows minimum intervals, generation cadence, segment limits, disk quota and byte-rate pacing. Coalescing drops intermediate save opportunities; strict mode waits at the generation threshold. Runtime files remain outside the public source allowlist.

The service defaults to loopback. Non-loopback binding requires a token. Host, origin and request-size checks constrain browser access. Remote deployment needs transport protection supplied by the operator. Tokens belong in environment configuration, not Git.

Explicit task inputs and boundaries can support a future distributed executor. Remote workers, consensus, blockchain, GPU kernels and distributed correctness guarantees are not part of this version.
