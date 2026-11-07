# GOL sim native engine

Rust `cdylib` / C ABI for a Python `ctypes` controller. CPU only. The engine is
finite rectangular Conway B3/S23 with dead exterior by default and optional
periodic wrapping. All eight neighbor offsets, including diagonals, are counted.
For widths/heights below three, wrapping can map distinct offsets onto the same
cell; each offset is still counted, as in the usual periodic stencil.

The state is a sparse map of square bit-packed tiles (64, 128, 256, 512 or 1024
cells per edge). Every generation computes the old active tiles and their eight
neighbor tiles. Output is committed only after every Rayon task finishes.
Within words, integer bit planes count the eight neighbors for 64 cells at once.
There are no floating-point state calculations. Rectangle randomization alone
uses a floating-point probability against 53 deterministic random bits derived
from SplitMix64(seed XOR packed_coordinate). Seeds are independent of worker
count and tile layout; percentages are Bernoulli probabilities, not guaranteed
exact population percentages.

A bounded memoization cache stores the complete old tile input, surrounding
rows and words, valid finite dimensions, and exact output. Hash equality only
locates candidates: full word equality is mandatory before reuse. These extra
halo words are conservative (more than the necessary one-cell neighborhood).
Matching transitions are replayed one generation at a time, so every incoming
boundary change is checked. This is not HashLife and never jumps blindly over
generations.

Optional cycle helpers (`life_configure_cycles`) add guarded phase replay for
periods up to 64. Their start generation, detection interval and memory budget
are independent configuration settings. Stored phases are reused only while
the relevant boundary guards match; incoming interaction wakes the affected
tile. Reconfiguration discards helper proofs without changing authoritative
cells. Helpers can be evicted under memory pressure. The older bounded period
history described below is separate from these guarded cycle helpers.

Period observability keeps at most 16 prior exact cache identities for a tile.
The identities correspond to full input comparisons. A reported period is an
observed recurrence conditional on its boundary; it is not an unconditional
proof of an isolated oscillator. Histories use at most one eighth of the cache
budget, and cache plus history bytes are bounded by that budget. Cache eviction
can lose a recurrence, causing extra computation rather than incorrect state.

The memory limit is a conservative engine allocation budget, not an operating
system RSS limit. Preflight includes resident state/cache and maximum candidate
inputs/results/metadata; cache eviction is permitted. Thread stacks, allocator
overhead, Python, frontend, compression and operating-system memory need their
own allowance. Failed preflight leaves the generation and cell state intact.

`include/life_native.h` specifies the ABI. All calls on a handle must be serialized
except atomic `life_progress`, which is safe while `life_step` runs. Never destroy
a handle concurrently. A nonzero status is success; `life_step` returns
`UINT64_MAX` on failure. Read `life_last_error` immediately after a failed call;
subsequent successful calls clear it. A null creation result means invalid
parameters or failure creating the worker pool. Invalid non-null raw pointers
are caller errors.

## Stats

| Code | Meaning |
| --- | --- |
| 0 | Currently materialized nonempty tiles |
| 1 | Last generation's memoized transition hits |
| 2 | Last generation's newly computed tiles |
| 3 | Transition cache byte accounting |
| 4 | Nonempty outputs identical to their tile's previous state |
| 5 | Empty outputs among candidate tiles |
| 6 | Estimated resident native bytes including histories/export index |
| 7 | Last generation's candidate count |
| 8 | Tile edge size |
| 9 | Worker thread count |
| 10 | Engine memory budget |
| 11 | Last step duration in microseconds |
| 12 | Cached transition count |
| 13 | Total finite tile positions minus last candidate count |
| 14 | Tiles with observed input period 2 on last step |
| 15 | Tiles with observed input period greater than 2 on last step |
| 16 | Maximum observed input period on last step (0 unknown) |
| 17 | Bounded history byte accounting |

Additional guarded-cycle counters and rendering metadata are documented in
`include/life_native.h`. `life_cluster_info` reports current proof state and
`life_render_cycles` aggregates population and recurrence information for the
thermal view. Rendering does not influence simulation transitions.

Counts in `life_render` are exact. The native renderer visits intersecting
nonempty tiles, adding a full tile population directly when one output pixel
contains it; otherwise it enumerates living bits in the visible part. It does
not allocate a full world bitmap. Its current tile scan is linear in the number
of allocated tiles. Viewport output is capped at 16,777,216 pixels; the controller
should set a much smaller display-sized limit and manage rendering cache/LOD.

Chunked exports sort tile coordinates and cache cumulative populations once per
state revision, then binary-search the first tile for each chunk. The exported
cell order is deterministic but is tile-major, not global row-major.

## Build and validation

`cargo test --release` and `cargo build --release` produce
`target/release/life_native.dll` on Windows. The local Windows GNU configuration
uses the Rust-distributed `rust-lld` linker. Other platforms produce the usual
`.so`/`.dylib` artifact and use their default linker.

The tests compare against an independent scalar implementation: exhaustive
3-by-3 states, random partial tiles, both boundary modes, 1/2-cell dimensions,
multiple worker counts, cache invalidation, exact hash collision checks,
observed period reporting, rendering, segmented export, random rectangles,
cross-tile-size equivalence, and transactional budget/import failures.
