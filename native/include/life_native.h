#ifndef LIFE_NATIVE_H
#define LIFE_NATIVE_H
#include <stdint.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Opaque handle. Serialize all calls per handle except life_progress.
   Never destroy a handle while ANY call (including progress) is running. */
typedef struct LifeHandle LifeHandle;
LifeHandle *life_create(uint32_t width, uint32_t height, uint32_t tile_size, uint32_t threads, uint32_t cache_mb);
void life_destroy(LifeHandle *);
uint8_t life_set_cell(LifeHandle *, uint32_t x, uint32_t y, uint8_t alive);
uint8_t life_get_cell(LifeHandle *, uint32_t x, uint32_t y);
/* Returns population, or UINT64_MAX on error. */
uint64_t life_step(LifeHandle *);
uint64_t life_generation(LifeHandle *);
uint64_t life_population(LifeHandle *);
void life_set_generation(LifeHandle *, uint64_t generation);
void life_clear(LifeHandle *);
uint8_t life_set_wrap(LifeHandle *, uint8_t wrap);
uint8_t life_set_memory_limit(LifeHandle *, uint64_t bytes);
const char *life_last_error(const LifeHandle *);
/* Zero-based packed coordinates: ((uint64_t)y << 32) | x.
   Import adds living cells; it does not clear the prior state. */
uint8_t life_import_cells(LifeHandle *, const uint64_t *coordinates, size_t count);
/* Returns required population, writes at most capacity. */
size_t life_export_cells(LifeHandle *, uint64_t *out, size_t capacity);
/* Returns actual number written. Order: tile y, tile x, local y, local x.
   Do not change the simulation between chunks of a single snapshot. */
size_t life_export_range(LifeHandle *, uint64_t offset, uint64_t *out, size_t capacity);
/* Overwrites only the rectangle. Density is a probability in [0,1]. */
uint8_t life_randomize(LifeHandle *, uint32_t x, uint32_t y, uint32_t width, uint32_t height, double density, uint64_t seed);
/* out has output_width * output_height uint64_t elements.
   Exact living counts per scale-by-scale square, clipped to finite board.
   Rendering does not repeat the world when wrap is enabled. */
uint8_t life_render(LifeHandle *, uint32_t x, uint32_t y, uint32_t output_width, uint32_t output_height, uint32_t scale, uint64_t *out);
/* Render only cells in the requested rectangle. Each buffer has
   ceil(width_cells / scale) * ceil(height_cells / scale) elements.
   Pass NULL for all three metadata buffers for counts alone. */
uint8_t life_render_region(LifeHandle *, uint32_t x, uint32_t y,
                           uint32_t width_cells, uint32_t height_cells, uint32_t scale,
                           uint64_t *counts, uint64_t *known_live,
                           double *period_log2_sum, uint32_t *period_max);
/* Optional exact cycle replay. Reconfiguration clears proofs, never cells.
   enabled: 0/1; max_period: 1..64; memory_mb: 0..1048576;
   interval: 1..65535 (new searches only; active guards run every step).
   Helpers may be evicted under memory pressure before authoritative cells. */
uint8_t life_configure_cycles(LifeHandle *, uint32_t enabled, uint64_t start_generation, uint32_t max_period, uint32_t memory_mb, uint32_t interval);
/* Zero-based leaf tile coordinates, not cell coordinates.
   code: 0 population; 1 currently guard-certified period (0 unknown);
   2 replay used in last transition; 3 state (0 empty, 1 unknown, 2 period1, 3 periodic).
   A currently valid proof does not promise that future neighbors stay unchanged. */
uint64_t life_cluster_info(LifeHandle *, uint32_t tile_x, uint32_t tile_y, uint32_t code);
/* Same clipped counts as life_render, with cycle metadata from this generation.
   Each distinct, nonoverlapping output buffer has output_width*output_height
   elements, at most 524288. known_live counts live cells in currently certified
   tiles; period_log2_sum sums live_count*log2(period); period_max is the largest
   certified period among live contributors. Unknown contributors remain in
   out_counts but are excluded from the other arrays. Empty bins are all zero. */
uint8_t life_render_cycles(LifeHandle *, uint32_t x, uint32_t y, uint32_t output_width, uint32_t output_height, uint32_t scale, uint64_t *out_counts, uint64_t *out_known_live, double *out_period_log2_sum, uint32_t *out_period_max);
/* Cycle statistics appended to existing codes:
   18 registered cycles; 19 last step replays; 20 last step wakes;
   21 captures in progress; 22 helper bytes; 23 start generation;
   24 enabled; 25 probes; 26 max period; 27 effective helper budget bytes.
   Historical transition-cache recurrence codes 14..16 retain their meaning. */
uint64_t life_stat(LifeHandle *, uint32_t code);
/* Last observed exact input recurrence of the containing tile (up to 16).
   Zero means unknown. This is conditional on checked boundaries, not a
   prediction that an external disturbance can never arrive. */
uint64_t life_period(LifeHandle *, uint32_t x, uint32_t y);
/* Concurrent-safe: 0 completed jobs; 1 total jobs; 2 phase
   (0 idle, 1 prepare, 2 compute, 3 commit). Separate reads are approximate. */
uint64_t life_progress(const LifeHandle *, uint32_t code);
#ifdef __cplusplus
}
#endif
#endif
