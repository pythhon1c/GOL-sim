//! Exact finite Conway B3/S23 engine. Coordinates are zero-based.
//! Every task reads one immutable generation. A step is committed only after
//! all tiles finish. Memoized transitions compare every input word, not hashes.
use rayon::prelude::*;
use std::cell::UnsafeCell;
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::ffi::{c_char, CString};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

type Coord = (u32, u32);
const OVERHEAD: u64 = 128;
const WORK_BATCH_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Tile {
    words: Vec<u64>,
    population: u64,
}
impl Tile {
    fn empty(size: usize) -> Self {
        Self {
            words: vec![0; size * (size / 64)],
            population: 0,
        }
    }
    fn recount(&mut self) {
        self.population = self.words.iter().map(|w| w.count_ones() as u64).sum();
    }
}
struct CacheEntry {
    id: u64,
    input: Vec<u64>,
    valid: (usize, usize),
    output: Option<Arc<Tile>>,
    bytes: u64,
}
struct Cache {
    entries: HashMap<u64, Vec<CacheEntry>>,
    order: VecDeque<(u64, u64)>,
    bytes: u64,
    limit: u64,
    sequence: u64,
}

// A phase records a proven one-step transition: its complete local state and
// every external cell that can affect it. Hashes only start speculative captures.
struct CyclePhase {
    state: Arc<Tile>,
    halo: Vec<u64>,
}
struct GuardedCycle {
    phases: Vec<CyclePhase>,
    index: usize,
    charge: u64,
    replayed_last: bool,
}
struct CycleCapture {
    phases: Vec<CyclePhase>,
    charge: u64,
}
struct CycleProbe {
    recent: VecDeque<(u64, u64)>,
    charge: u64,
}
struct Cycles {
    enabled: bool,
    start: u64,
    max_period: usize,
    budget: u64,
    interval: u64,
    runtime_limit: u64,
    bytes: u64,
    // B-trees release nodes on removal; discarded helpers do not retain large
    // hash table capacities outside the accounting ledger.
    active: BTreeMap<Coord, GuardedCycle>,
    captures: BTreeMap<Coord, CycleCapture>,
    probes: BTreeMap<Coord, CycleProbe>,
}
impl Default for Cycles {
    fn default() -> Self {
        Self {
            enabled: true,
            start: 128,
            max_period: 16,
            budget: 128 << 20,
            interval: 8,
            runtime_limit: 128 << 20,
            bytes: 0,
            active: BTreeMap::new(),
            captures: BTreeMap::new(),
            probes: BTreeMap::new(),
        }
    }
}
impl Cycles {
    fn clear(&mut self) {
        self.active.clear();
        self.captures.clear();
        self.probes.clear();
        self.bytes = 0;
    }
    fn remove_active(&mut self, coord: Coord) {
        if let Some(c) = self.active.remove(&coord) {
            self.bytes -= c.charge;
        }
    }
    fn remove_capture(&mut self, coord: Coord) {
        if let Some(c) = self.captures.remove(&coord) {
            self.bytes -= c.charge;
        }
    }
    fn remove_probe(&mut self, coord: Coord) {
        if let Some(c) = self.probes.remove(&coord) {
            self.bytes -= c.charge;
        }
    }
    fn trim(&mut self, limit: u64) {
        self.runtime_limit = limit.min(self.budget);
        while self.bytes > self.runtime_limit {
            if let Some((&coord, _)) = self.probes.first_key_value() {
                self.remove_probe(coord);
            } else if let Some((&coord, _)) = self.captures.first_key_value() {
                self.remove_capture(coord);
            } else if let Some((&coord, _)) = self.active.first_key_value() {
                self.remove_active(coord);
            } else {
                break;
            }
        }
    }
    fn admit(&mut self, bytes: u64, priority: bool) -> bool {
        if bytes > self.runtime_limit {
            return false;
        }
        if priority {
            while self.bytes + bytes > self.runtime_limit {
                if let Some((&coord, _)) = self.probes.first_key_value() {
                    self.remove_probe(coord);
                } else if let Some((&coord, _)) = self.captures.first_key_value() {
                    self.remove_capture(coord);
                } else {
                    break;
                }
            }
        }
        self.bytes + bytes <= self.runtime_limit
    }
}

struct CyclePixels<'a> {
    known: &'a mut [u64],
    logsum: &'a mut [f64],
    maximum: &'a mut [u32],
}
fn add_pixel(
    out: &mut [u64],
    meta: &mut Option<CyclePixels<'_>>,
    i: usize,
    n: u64,
    period: u32,
    log_period: f64,
) {
    out[i] += n;
    if period != 0 && n != 0 {
        if let Some(m) = meta {
            m.known[i] += n;
            m.logsum[i] += n as f64 * log_period;
            m.maximum[i] = m.maximum[i].max(period);
        }
    }
}
impl Cache {
    fn new(limit: u64) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            limit,
            sequence: 0,
        }
    }
    #[cfg(test)]
    fn get(&self, hash: u64, input: &[u64], valid: (usize, usize)) -> Option<Option<Arc<Tile>>> {
        self.get_entry(hash, input, valid).map(|e| e.output.clone())
    }
    fn get_entry(&self, hash: u64, input: &[u64], valid: (usize, usize)) -> Option<&CacheEntry> {
        self.entries
            .get(&hash)?
            .iter()
            .find(|e| e.valid == valid && e.input == input)
    }
    fn evict(&mut self) {
        if let Some((hash, id)) = self.order.pop_front() {
            if let Some(bucket) = self.entries.get_mut(&hash) {
                if let Some(i) = bucket.iter().position(|e| e.id == id) {
                    self.bytes -= bucket.remove(i).bytes;
                }
                if bucket.is_empty() {
                    self.entries.remove(&hash);
                }
            }
        }
    }
    fn trim(&mut self) {
        while self.bytes > self.limit {
            self.evict();
        }
    }
    fn insert(
        &mut self,
        hash: u64,
        input: Vec<u64>,
        valid: (usize, usize),
        output: Option<Arc<Tile>>,
    ) -> Option<u64> {
        if let Some(entry) = self.get_entry(hash, &input, valid) {
            return Some(entry.id);
        }
        let bytes = input.len() as u64 * 8
            + output
                .as_ref()
                .map_or(0, |t| t.words.len() as u64 * 8 + OVERHEAD)
            + OVERHEAD;
        if bytes > self.limit {
            return None;
        }
        while self.bytes + bytes > self.limit {
            self.evict();
        }
        self.sequence += 1;
        let id = self.sequence;
        self.entries.entry(hash).or_default().push(CacheEntry {
            id,
            input,
            valid,
            output,
            bytes,
        });
        self.order.push_back((hash, id));
        self.bytes += bytes;
        Some(id)
    }
}

pub struct Engine {
    width: u32,
    height: u32,
    size: usize,
    wrap: bool,
    tiles: HashMap<Coord, Arc<Tile>>,
    generation: u64,
    population: u64,
    pool: rayon::ThreadPool,
    cache: Cache,
    cache_budget: u64,
    cycles: Cycles,
    memory_limit: u64,
    stats: [u64; 28],
    error: CString,
    progress: Arc<Progress>,
    export_index: Option<Vec<(Coord, u64)>>,
    histories: BTreeMap<Coord, History>,
    work_batch_bytes: u64,
}
const HISTORY_LENGTH: usize = 16;
const HISTORY_BYTES: u64 = (HISTORY_LENGTH * 16 + 128) as u64;
struct History {
    recent: VecDeque<(u64, u64)>,
    period: u64,
}
#[derive(Default)]
struct Progress {
    completed: AtomicU64,
    total: AtomicU64,
    phase: AtomicU64,
}
pub struct Handle {
    inner: UnsafeCell<Engine>,
    progress: Arc<Progress>,
}
struct ResultTile {
    coord: Coord,
    valid: (usize, usize),
    hash: u64,
    input: Vec<u64>,
    output: Option<Arc<Tile>>,
    hit: bool,
    unchanged: bool,
    cache_id: Option<u64>,
    replay: bool,
    wake: bool,
    halo: Option<Vec<u64>>,
    state_hash: u64,
}

impl Engine {
    fn new(
        width: u32,
        height: u32,
        size: u32,
        threads: u32,
        cache_mb: u32,
    ) -> Result<Self, String> {
        if width == 0 || height == 0 {
            return Err("Field dimensions must be positive".into());
        }
        if !(64..=1024).contains(&size) || !size.is_power_of_two() {
            return Err("Tile size must be 64, 128, 256, 512 or 1024".into());
        }
        let threads = if threads == 0 {
            std::thread::available_parallelism().map_or(1, |n| n.get())
        } else {
            threads as usize
        };
        if threads > 4096 {
            return Err("Too many worker threads".into());
        }
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            width,
            height,
            size: size as usize,
            wrap: false,
            tiles: HashMap::new(),
            generation: 0,
            population: 0,
            pool,
            cache: Cache::new(cache_mb as u64 * 1024 * 1024),
            cache_budget: cache_mb as u64 * 1024 * 1024,
            cycles: Cycles::default(),
            memory_limit: 1024 * 1024 * 1024,
            stats: [0; 28],
            error: CString::default(),
            progress: Arc::new(Progress::default()),
            export_index: None,
            histories: BTreeMap::new(),
            work_batch_bytes: WORK_BATCH_BYTES,
        })
    }
    fn fail(&mut self, message: impl AsRef<str>) {
        self.error = CString::new(message.as_ref().replace('\0', " ")).unwrap_or_default();
    }
    fn tile_bytes(&self) -> u64 {
        (self.size * self.size / 8) as u64 + OVERHEAD
    }
    fn memory(&self) -> u64 {
        self.tiles.len() as u64 * self.tile_bytes()
            + self.cache.bytes
            + self.histories.len() as u64 * HISTORY_BYTES
            + self.cycles.bytes
            + self
                .export_index
                .as_ref()
                .map_or(0, |i| i.capacity() as u64 * 16)
            + 4096
    }
    fn room(&self, additional: u64) -> Result<(), String> {
        if self.memory().saturating_add(additional) > self.memory_limit {
            Err("Native memory budget exceeded; increase the budget or reduce the active field/cache".into())
        } else {
            Ok(())
        }
    }
    fn batch_len(&self, item_bytes: u64, total: u64) -> usize {
        (self.work_batch_bytes / item_bytes.max(1))
            .max(1)
            .min(total.max(1)) as usize
    }
    fn step_workspace(&self, max_candidates: u64) -> (usize, u64) {
        let input_bytes = ((self.size + 2) * (self.size / 64 + 2) * 8) as u64;
        let per_job = input_bytes + self.tile_bytes() + 640;
        let batch_len = self.batch_len(per_job, max_candidates);
        let batch_bytes = (batch_len as u64)
            .min(max_candidates)
            .saturating_mul(per_job);
        // The full next state must coexist with the immutable old generation.
        // Candidate hash/index storage is bounded separately; only inputs and
        // results of the current batch are retained. Count output storage twice
        // for this batch, conservatively covering its transient allocations.
        let next_and_index = max_candidates.saturating_mul(self.tile_bytes() + 64);
        (batch_len, next_and_index.saturating_add(batch_bytes))
    }
    fn valid(&self, coord: Coord) -> (usize, usize) {
        (
            (self.width as u64 - coord.0 as u64 * self.size as u64).min(self.size as u64) as usize,
            (self.height as u64 - coord.1 as u64 * self.size as u64).min(self.size as u64) as usize,
        )
    }
    fn get(&self, x: u32, y: u32) -> bool {
        if x >= self.width || y >= self.height {
            return false;
        }
        let size = self.size as u32;
        self.tiles.get(&(x / size, y / size)).is_some_and(|t| {
            t.words[(y % size) as usize * (self.size / 64) + (x % size / 64) as usize]
                & (1u64 << (x % 64))
                != 0
        })
    }
    fn set(&mut self, x: u32, y: u32, alive: bool) -> Result<(), String> {
        if x >= self.width || y >= self.height {
            return Err("Cell coordinate is outside the field".into());
        }
        if self.get(x, y) == alive {
            return Ok(());
        }
        // Clear once before copy-on-write. Repeated bulk-import set calls have
        // empty maps here, so invalidation is constant time after the first.
        self.cycles.clear();
        let size = self.size as u32;
        let coord = (x / size, y / size);
        if !self.tiles.contains_key(&coord) {
            if !alive {
                return Ok(());
            }
            self.room(self.tile_bytes())?;
            self.tiles.insert(coord, Arc::new(Tile::empty(self.size)));
        }
        let tile = Arc::make_mut(self.tiles.get_mut(&coord).unwrap());
        let word =
            &mut tile.words[(y % size) as usize * (self.size / 64) + (x % size / 64) as usize];
        let bit = 1u64 << (x % 64);
        let old = *word & bit != 0;
        if old != alive {
            self.export_index = None;
            self.histories.remove(&coord);
            if alive {
                *word |= bit;
                tile.population += 1;
                self.population += 1;
            } else {
                *word &= !bit;
                tile.population -= 1;
                self.population -= 1;
            }
        }
        if tile.population == 0 {
            self.tiles.remove(&coord);
        }
        Ok(())
    }
    fn aligned_word(&self, x: u64, y: u32) -> u64 {
        if x >= self.width as u64 {
            return 0;
        }
        let coord = ((x / self.size as u64) as u32, y / self.size as u32);
        self.tiles.get(&coord).map_or(0, |t| {
            t.words[(y as usize % self.size) * (self.size / 64) + (x as usize % self.size) / 64]
        })
    }
    fn bounded_word(&self, x: u64, y: u32) -> u64 {
        let shift = (x % 64) as u32;
        let base = x - x % 64;
        let a = self.aligned_word(base, y);
        if shift == 0 {
            a
        } else {
            (a >> shift) | (self.aligned_word(base + 64, y) << (64 - shift))
        }
    }
    fn world_word(&self, x: i64, y: i64) -> u64 {
        if !self.wrap {
            if y < 0 || y >= self.height as i64 || x < 0 || x >= self.width as i64 {
                return 0;
            }
            return self.bounded_word(x as u64, y as u32);
        }
        let y = y.rem_euclid(self.height as i64) as u32;
        let mut x = x.rem_euclid(self.width as i64) as u64;
        let mut result = 0u64;
        let mut done = 0u32;
        while done < 64 {
            let count = (self.width as u64 - x).min((64 - done) as u64) as u32;
            result |= (self.bounded_word(x, y) & mask(count as usize)) << done;
            done += count;
            x = 0;
        }
        result
    }
    fn input(&self, coord: Coord) -> Vec<u64> {
        let tile_size = self.size as u32;
        let words_per_row = self.size / 64;
        let stride = words_per_row + 2;
        let x = i64::from(coord.0) * i64::from(tile_size);
        let y = i64::from(coord.1) * i64::from(tile_size);
        if self.wrap {
            // A partial tile at the seam can put the wrapped row or word in
            // the middle of a tile. Read that neighborhood in world coordinates.
            let crosses_partial_x = self.width % tile_size != 0
                && (x < 64 || x + i64::from(tile_size) + 64 > i64::from(self.width));
            let crosses_partial_y = self.height % tile_size != 0
                && (y == 0 || y + i64::from(tile_size) >= i64::from(self.height));
            if crosses_partial_x || crosses_partial_y {
                let mut words = Vec::with_capacity((self.size + 2) * stride);
                for row in -1..=i64::from(tile_size) {
                    for col in -1..=words_per_row as i64 {
                        words.push(self.world_word(x + col * 64, y + row));
                    }
                }
                return words;
            }
        }

        let columns = i64::from(self.width.div_ceil(tile_size));
        let rows = i64::from(self.height.div_ceil(tile_size));
        let neighbor = |dx: i64, dy: i64| {
            let mut tx = i64::from(coord.0) + dx;
            let mut ty = i64::from(coord.1) + dy;
            if self.wrap {
                tx = tx.rem_euclid(columns);
                ty = ty.rem_euclid(rows);
            }
            self.tiles
                .get(&(u32::try_from(tx).ok()?, u32::try_from(ty).ok()?))
        };
        // Resolve the nine possible source tiles once. Each destination row
        // contains the west word, the complete center row and the east word.
        let mut input = vec![0; (self.size + 2) * stride];
        for (dy, first_source_row, first_dest_row, count) in [
            (-1, self.size - 1, 0, 1),
            (0, 0, 1, self.size),
            (1, 0, self.size + 1, 1),
        ] {
            let west = neighbor(-1, dy);
            let center = neighbor(0, dy);
            let east = neighbor(1, dy);
            if west.is_none() && center.is_none() && east.is_none() {
                continue;
            }
            for row in 0..count {
                let at = (first_source_row + row) * words_per_row;
                let dest = &mut input[(first_dest_row + row) * stride..][..stride];
                if let Some(tile) = center {
                    dest[1..1 + words_per_row].copy_from_slice(&tile.words[at..at + words_per_row]);
                }
                if let Some(tile) = west {
                    dest[0] = tile.words[at + words_per_row - 1];
                }
                if let Some(tile) = east {
                    dest[stride - 1] = tile.words[at];
                }
            }
        }
        input
    }
    fn world_cell(&self, mut x: i64, mut y: i64) -> bool {
        if self.wrap {
            x = x.rem_euclid(self.width as i64);
            y = y.rem_euclid(self.height as i64);
        }
        x >= 0
            && y >= 0
            && x < self.width as i64
            && y < self.height as i64
            && self.get(x as u32, y as u32)
    }
    fn halo(&self, coord: Coord) -> Vec<u64> {
        let (w, h) = self.valid(coord);
        let (x, y) = (
            coord.0 as i64 * self.size as i64,
            coord.1 as i64 * self.size as i64,
        );
        let mut result = Vec::with_capacity(2 * w.div_ceil(64) + 2 * h.div_ceil(64) + 1);
        for cy in [y - 1, y + h as i64] {
            for col in 0..w.div_ceil(64) {
                result.push(
                    self.world_word(x + col as i64 * 64, cy) & mask(w.saturating_sub(col * 64)),
                );
            }
        }
        for mut cx in [x - 1, x + w as i64] {
            if self.wrap {
                cx = cx.rem_euclid(self.width as i64);
            }
            let neighbor = if cx >= 0 && cx < self.width as i64 {
                self.tiles.get(&((cx / self.size as i64) as u32, coord.1))
            } else {
                None
            };
            for row in (0..h).step_by(64) {
                let mut word = 0;
                if let Some(tile) = neighbor {
                    let col = cx as usize % self.size / 64;
                    let bit = cx as usize % 64;
                    for offset in 0..64.min(h - row) {
                        word |= ((tile.words[(row + offset) * (self.size / 64) + col] >> bit) & 1)
                            << offset;
                    }
                }
                result.push(word);
            }
        }
        let mut corners = 0;
        for (i, (cx, cy)) in [
            (x - 1, y - 1),
            (x + w as i64, y - 1),
            (x - 1, y + h as i64),
            (x + w as i64, y + h as i64),
        ]
        .into_iter()
        .enumerate()
        {
            corners |= (self.world_cell(cx, cy) as u64) << i;
        }
        result.push(corners);
        result
    }
    fn certified_period(&self, coord: Coord) -> u32 {
        let Some(cycle) = self.cycles.active.get(&coord) else {
            return 0;
        };
        let Some(current) = self.tiles.get(&coord) else {
            return 0;
        };
        let phase = &cycle.phases[cycle.index];
        if (Arc::ptr_eq(current, &phase.state) || current.words == phase.state.words)
            && self.halo(coord) == phase.halo
        {
            cycle.phases.len() as u32
        } else {
            0
        }
    }
    fn configure_cycles(
        &mut self,
        enabled: u32,
        start: u64,
        max_period: u32,
        memory_mb: u32,
        interval: u32,
    ) -> Result<(), String> {
        if enabled > 1
            || !(1..=64).contains(&max_period)
            || memory_mb > 1_048_576
            || !(1..=65535).contains(&interval)
        {
            return Err("Invalid cycle detector settings".into());
        }
        self.cycles.clear();
        self.cycles.enabled = enabled != 0;
        self.cycles.start = start;
        self.cycles.max_period = max_period as usize;
        self.cycles.budget = (memory_mb as u64) << 20;
        self.cycles.runtime_limit = self
            .cycles
            .budget
            .min(self.memory_limit.saturating_sub(self.memory()));
        self.cycles.interval = interval as u64;
        self.stats[19] = 0;
        self.stats[20] = 0;
        Ok(())
    }
    fn learn_cycle(&mut self, result: &mut ResultTile) {
        let coord = result.coord;
        if result.replay {
            self.stats[19] += 1;
            if let Some(cycle) = self.cycles.active.get_mut(&coord) {
                cycle.index = (cycle.index + 1) % cycle.phases.len();
                cycle.replayed_last = true;
            }
            return;
        }
        if result.wake {
            self.stats[20] += 1;
            self.cycles.remove_active(coord);
        }
        if !self.cycles.enabled
            || self.generation < self.cycles.start
            || self.cycles.runtime_limit == 0
        {
            return;
        }
        let (Some(current), Some(output)) =
            (self.tiles.get(&coord).cloned(), result.output.as_ref())
        else {
            self.cycles.remove_capture(coord);
            self.cycles.remove_probe(coord);
            return;
        };
        let eligible = self.generation % self.cycles.interval == 0;
        if result.unchanged && eligible {
            self.cycles.remove_capture(coord);
            self.cycles.remove_probe(coord);
            let halo = result.halo.take().unwrap_or_else(|| self.halo(coord));
            let charge = halo.len() as u64 * 8 + 256;
            if self.cycles.admit(charge, true) {
                self.cycles.bytes += charge;
                self.cycles.active.insert(
                    coord,
                    GuardedCycle {
                        phases: vec![CyclePhase {
                            state: current.clone(),
                            halo,
                        }],
                        index: 0,
                        charge,
                        replayed_last: false,
                    },
                );
                result.output = Some(current);
            }
            return;
        }
        if let Some(mut capture) = self.cycles.captures.remove(&coord) {
            let halo = result.halo.take().unwrap_or_else(|| self.halo(coord));
            capture.phases.push(CyclePhase {
                state: current.clone(),
                halo,
            });
            // Test closure at EVERY generation, independently of the probe
            // interval. No hash ever certifies a phase or its period.
            if output.words == capture.phases[0].state.words {
                self.cycles.bytes -= capture.charge;
                let period = capture.phases.len();
                let charge = (period as u64 - 1) * self.tile_bytes()
                    + capture
                        .phases
                        .iter()
                        .map(|p| p.halo.len() as u64 * 8 + 64)
                        .sum::<u64>()
                    + 256;
                if self.cycles.admit(charge, true) {
                    self.cycles.bytes += charge;
                    result.output = Some(capture.phases[0].state.clone());
                    // Shrink a speculative max-period allocation before using
                    // the smaller active-cycle accounting charge.
                    capture.phases.shrink_to_fit();
                    self.cycles.active.insert(
                        coord,
                        GuardedCycle {
                            phases: capture.phases,
                            index: 0,
                            charge,
                            replayed_last: false,
                        },
                    );
                }
                self.cycles.remove_probe(coord);
                return;
            }
            if capture.phases.len() < self.cycles.max_period {
                self.cycles.captures.insert(coord, capture);
            } else {
                self.cycles.bytes -= capture.charge;
            }
        }
        if self.cycles.captures.contains_key(&coord) {
            return;
        }
        let repeated = self.cycles.probes.get(&coord).is_some_and(|p| {
            p.recent.iter().any(|&(h, g)| {
                h == result.state_hash && self.generation - g <= self.cycles.max_period as u64
            })
        });
        if repeated && eligible && self.cycles.max_period > 1 {
            let halo = result.halo.take().unwrap_or_else(|| self.halo(coord));
            let charge = self.cycles.max_period as u64
                * (self.tile_bytes() + halo.len() as u64 * 8 + 64)
                + 256;
            self.cycles.remove_probe(coord);
            if self.cycles.admit(charge, false) {
                let mut phases = Vec::with_capacity(self.cycles.max_period);
                phases.push(CyclePhase {
                    state: current,
                    halo,
                });
                self.cycles.bytes += charge;
                self.cycles
                    .captures
                    .insert(coord, CycleCapture { phases, charge });
                return;
            }
        }
        if !self.cycles.probes.contains_key(&coord) {
            let charge = self.cycles.max_period as u64 * 16 + 256;
            if !self.cycles.admit(charge, false) {
                return;
            }
            self.cycles.bytes += charge;
            self.cycles.probes.insert(
                coord,
                CycleProbe {
                    recent: VecDeque::with_capacity(self.cycles.max_period),
                    charge,
                },
            );
        }
        let probe = self.cycles.probes.get_mut(&coord).unwrap();
        if probe.recent.len() == self.cycles.max_period {
            probe.recent.pop_front();
        }
        probe.recent.push_back((result.state_hash, self.generation));
    }
    fn candidates(&self) -> HashSet<Coord> {
        let cols = (self.width as u64).div_ceil(self.size as u64) as i64;
        let rows = (self.height as u64).div_ceil(self.size as u64) as i64;
        let mut result = HashSet::new();
        for &(x, y) in self.tiles.keys() {
            for dy in -1i64..=1 {
                for dx in -1i64..=1 {
                    let mut nx = x as i64 + dx;
                    let mut ny = y as i64 + dy;
                    if self.wrap {
                        nx = nx.rem_euclid(cols);
                        ny = ny.rem_euclid(rows);
                    }
                    if nx >= 0 && nx < cols && ny >= 0 && ny < rows {
                        result.insert((nx as u32, ny as u32));
                    }
                }
            }
        }
        result
    }
    fn step(&mut self) -> Result<u64, String> {
        let start = Instant::now();
        if self.generation == u64::MAX {
            return Err("Generation counter overflow".into());
        }
        // Preflight the entire next generation before allocating or changing
        // anything; helper-cache growth is reserved even when initially empty.
        let max_candidates = (self.tiles.len() as u64).saturating_mul(9).min(
            (self.width as u64).div_ceil(self.size as u64)
                * (self.height as u64).div_ceil(self.size as u64),
        );
        let (batch_len, workspace) = self.step_workspace(max_candidates);
        let authoritative = self.memory()
            - self.cache.bytes
            - self.histories.len() as u64 * HISTORY_BYTES
            - self.cycles.bytes;
        if authoritative.saturating_add(workspace) > self.memory_limit {
            return Err(
                "Native memory budget exceeded by immutable old and next generation".into(),
            );
        }
        let helper_room = self.memory_limit - authoritative - workspace;
        // An insertion may temporarily fill the transition cache before the
        // end-of-batch combined history/cache trim. Reserve both allocations.
        let cache_limit = self.cache_budget.min(helper_room / 9 * 8);
        if cache_limit < self.cache.limit {
            self.cache = Cache::new(cache_limit);
            self.histories.clear();
        } else {
            self.cache.limit = cache_limit;
        }
        if self.histories.len() as u64 * HISTORY_BYTES > self.cache.limit / 8 {
            self.histories = BTreeMap::new();
        }
        while self.cache.bytes + self.histories.len() as u64 * HISTORY_BYTES > self.cache.limit
            && !self.cache.order.is_empty()
        {
            self.cache.evict();
        }
        self.cycles.trim(
            if self.cycles.enabled && self.generation >= self.cycles.start {
                helper_room.saturating_sub(self.cache.limit + self.cache.limit / 8)
            } else {
                0
            },
        );
        let candidates: Vec<_> = self.candidates().into_iter().collect();
        self.progress
            .total
            .store(candidates.len() as u64, Ordering::Relaxed);
        self.progress.phase.store(2, Ordering::Release);
        let mut next = HashMap::with_capacity(candidates.len());
        let mut population = 0;
        self.stats[1] = 0;
        self.stats[2] = 0;
        self.stats[4] = 0;
        self.stats[5] = 0;
        self.stats[14] = 0;
        self.stats[15] = 0;
        self.stats[16] = 0;
        self.stats[19] = 0;
        self.stats[20] = 0;
        for cycle in self.cycles.active.values_mut() {
            cycle.replayed_last = false;
        }
        for batch in candidates.chunks(batch_len) {
            let results: Vec<ResultTile> = self.pool.install(|| {
                batch
                    .par_iter()
                    .map(|&coord| {
                        if let Some(cycle) = self.cycles.active.get(&coord) {
                            let phase = &cycle.phases[cycle.index];
                            if self.tiles.get(&coord).is_some_and(|tile| {
                                Arc::ptr_eq(tile, &phase.state) || tile.words == phase.state.words
                            }) && self.halo(coord) == phase.halo
                            {
                                self.progress.completed.fetch_add(1, Ordering::Relaxed);
                                return ResultTile {
                                    coord,
                                    valid: self.valid(coord),
                                    hash: 0,
                                    input: Vec::new(),
                                    output: Some(
                                        cycle.phases[(cycle.index + 1) % cycle.phases.len()]
                                            .state
                                            .clone(),
                                    ),
                                    hit: false,
                                    unchanged: cycle.phases.len() == 1,
                                    cache_id: None,
                                    replay: true,
                                    wake: false,
                                    halo: None,
                                    state_hash: 0,
                                };
                            }
                        }
                        let input = self.input(coord);
                        let valid = self.valid(coord);
                        let hash = hash_input(&input, valid);
                        let cached = self.cache.get_entry(hash, &input, valid);
                        let hit = cached.is_some();
                        let cache_id = cached.map(|e| e.id);
                        let output = cached
                            .map(|e| e.output.clone())
                            .unwrap_or_else(|| compute(&input, self.size, valid));
                        let unchanged = match (&output, self.tiles.get(&coord)) {
                            (Some(a), Some(b)) => a.words == b.words,
                            _ => false,
                        };
                        self.progress.completed.fetch_add(1, Ordering::Relaxed);
                        let detecting = self.cycles.enabled
                            && self.generation >= self.cycles.start
                            && self.cycles.runtime_limit > 0;
                        let state_hash = if detecting {
                            self.tiles
                                .get(&coord)
                                .map_or(0, |t| hash_input(&t.words, valid))
                        } else {
                            0
                        };
                        ResultTile {
                            coord,
                            valid,
                            hash,
                            input,
                            output,
                            hit,
                            unchanged,
                            cache_id,
                            replay: false,
                            wake: self.cycles.active.contains_key(&coord),
                            halo: None,
                            state_hash,
                        }
                    })
                    .collect()
            });
            for mut result in results {
                self.learn_cycle(&mut result);
                if !result.replay {
                    self.stats[if result.hit { 1 } else { 2 }] += 1;
                }
                self.stats[4] += result.unchanged as u64;
                if let Some(tile) = &result.output {
                    population += tile.population;
                    next.insert(result.coord, tile.clone());
                } else {
                    self.stats[5] += 1;
                }
                let present = result.output.is_some();
                let id = if result.replay {
                    None
                } else if result.hit {
                    result.cache_id
                } else {
                    self.cache
                        .insert(result.hash, result.input, result.valid, result.output)
                };
                if present {
                    if let Some(id) = id {
                        if self.histories.contains_key(&result.coord)
                            || (self.histories.len() as u64 + 1) * HISTORY_BYTES
                                <= self.cache.limit / 8
                        {
                            let history =
                                self.histories
                                    .entry(result.coord)
                                    .or_insert_with(|| History {
                                        recent: VecDeque::with_capacity(HISTORY_LENGTH),
                                        period: 0,
                                    });
                            history.period = history
                                .recent
                                .iter()
                                .rev()
                                .find(|&&(seen, _)| seen == id)
                                .map_or(0, |&(_, generation)| self.generation - generation);
                            if history.recent.len() == HISTORY_LENGTH {
                                history.recent.pop_front();
                            }
                            history.recent.push_back((id, self.generation));
                            if history.period == 2 {
                                self.stats[14] += 1;
                            }
                            if history.period > 2 {
                                self.stats[15] += 1;
                            }
                            self.stats[16] = self.stats[16].max(history.period);
                        }
                    } else {
                        self.histories.remove(&result.coord);
                    }
                } else {
                    self.histories.remove(&result.coord);
                }
            }
            // Cache reuse between batches is safe: every key still includes the
            // complete old-generation input and halo; self.tiles is unchanged.
            while self.cache.bytes + self.histories.len() as u64 * HISTORY_BYTES > self.cache.limit
                && !self.cache.order.is_empty()
            {
                self.cache.evict();
            }
        }
        self.progress.phase.store(3, Ordering::Release);
        self.histories.retain(|coord, _| next.contains_key(coord));
        self.tiles = next;
        self.population = population;
        self.generation += 1;
        self.export_index = None;
        self.stats[7] = candidates.len() as u64;
        self.stats[11] = start.elapsed().as_micros().min(u64::MAX as u128) as u64;
        // Cache is disposable; evict it first when state growth needs memory.
        while (self.memory() > self.memory_limit
            || self.cache.bytes + self.histories.len() as u64 * HISTORY_BYTES > self.cache.limit)
            && !self.cache.order.is_empty()
        {
            self.cache.evict();
        }
        Ok(population)
    }
    fn import(&mut self, cells: &[u64]) -> Result<(), String> {
        let mut fresh = HashSet::new();
        for &cell in cells {
            let x = cell as u32;
            let y = (cell >> 32) as u32;
            if x >= self.width || y >= self.height {
                return Err("Imported cell lies outside the field".into());
            }
            let coord = (x / self.size as u32, y / self.size as u32);
            if !self.tiles.contains_key(&coord) {
                fresh.insert(coord);
            }
        }
        self.room(fresh.len() as u64 * self.tile_bytes())?;
        for &cell in cells {
            self.set(cell as u32, (cell >> 32) as u32, true)?;
        }
        Ok(())
    }
    fn export_range(&mut self, mut offset: u64, output: &mut [u64]) -> usize {
        if self.export_index.is_none() {
            let mut index: Vec<_> = self.tiles.keys().map(|&coord| (coord, 0u64)).collect();
            index.sort_unstable_by_key(|&((x, y), _)| (y, x));
            let mut cumulative = 0;
            for (coord, end) in &mut index {
                cumulative += self.tiles[coord].population;
                *end = cumulative;
            }
            self.export_index = Some(index);
        }
        let index = self.export_index.as_ref().unwrap();
        let first = index.partition_point(|&(_, end)| end <= offset);
        if first > 0 {
            offset -= index[first - 1].1;
        }
        let mut count = 0;
        for &(coord, _) in &index[first..] {
            let tile = &self.tiles[&coord];
            if offset >= tile.population {
                offset -= tile.population;
                continue;
            }
            for (i, &original) in tile.words.iter().enumerate() {
                if offset >= original.count_ones() as u64 {
                    offset -= original.count_ones() as u64;
                    continue;
                }
                let mut word = original;
                while word != 0 {
                    let bit = word.trailing_zeros();
                    word &= word - 1;
                    if offset > 0 {
                        offset -= 1;
                        continue;
                    }
                    if count == output.len() {
                        return count;
                    }
                    let x = coord.0 as u64 * self.size as u64
                        + (i % (self.size / 64)) as u64 * 64
                        + bit as u64;
                    let y = coord.1 as u64 * self.size as u64 + (i / (self.size / 64)) as u64;
                    output[count] = (y << 32) | x;
                    count += 1;
                }
            }
        }
        count
    }
    fn render(&self, x: u32, y: u32, width: u32, height: u32, scale: u32, out: &mut [u64]) {
        self.render_impl(
            x,
            y,
            width,
            (width as u64 * scale as u64, height as u64 * scale as u64),
            scale,
            out,
            None,
        );
    }
    fn render_impl(
        &self,
        x: u32,
        y: u32,
        width: u32,
        extent: (u64, u64),
        scale: u32,
        out: &mut [u64],
        mut meta: Option<CyclePixels<'_>>,
    ) {
        out.fill(0);
        if let Some(m) = &mut meta {
            m.known.fill(0);
            m.logsum.fill(0.0);
            m.maximum.fill(0);
        }
        let right = (x as u64 + extent.0).min(self.width as u64);
        let bottom = (y as u64 + extent.1).min(self.height as u64);
        if x as u64 >= right || y as u64 >= bottom {
            return;
        }
        let first_x = x / self.size as u32;
        let first_y = y / self.size as u32;
        let last_x = ((right - 1) / self.size as u64) as u32;
        let last_y = ((bottom - 1) / self.size as u64) as u32;
        let visible_tiles = (last_x - first_x + 1) as u64 * (last_y - first_y + 1) as u64;
        // A close-up on an enormous world touches only its visible leaf keys.
        // For a sparse overview, walking the resident map is cheaper than
        // probing every empty coordinate in the visible rectangle.
        let visible: Box<dyn Iterator<Item = (&Coord, &Arc<Tile>)> + '_> =
            if visible_tiles < self.tiles.len() as u64 {
                Box::new(
                    (first_y..=last_y)
                        .flat_map(move |ty| (first_x..=last_x).map(move |tx| (tx, ty)))
                        .filter_map(|coord| self.tiles.get_key_value(&coord)),
                )
            } else {
                Box::new(self.tiles.iter())
            };
        for (&(tx, ty), tile) in visible {
            let left = tx as u64 * self.size as u64;
            let top = ty as u64 * self.size as u64;
            let tr = (left + self.size as u64).min(self.width as u64);
            let tb = (top + self.size as u64).min(self.height as u64);
            if left >= right || top >= bottom || tr <= x as u64 || tb <= y as u64 {
                continue;
            }
            let period = if meta.is_some() {
                self.certified_period((tx, ty))
            } else {
                0
            };
            let log_period = if period > 0 {
                (period as f64).log2()
            } else {
                0.0
            };
            if left >= x as u64 && top >= y as u64 && tr <= right && tb <= bottom {
                let px = (left - x as u64) / scale as u64;
                let py = (top - y as u64) / scale as u64;
                if (tr - 1 - x as u64) / scale as u64 == px
                    && (tb - 1 - y as u64) / scale as u64 == py
                {
                    add_pixel(
                        out,
                        &mut meta,
                        (py * width as u64 + px) as usize,
                        tile.population,
                        period,
                        log_period,
                    );
                    continue;
                }
            }
            let row_begin = (y as u64).saturating_sub(top) as usize;
            let row_end = (bottom - top).min(self.size as u64) as usize;
            if scale >= 64 {
                // Horizontal bin boundaries repeat on every row. Split each
                // visible machine word once, then count entire fragments with
                // integer popcount. This avoids visiting every living bit at
                // overview scales, including unaligned origins and scales.
                let visible_left = left.max(x as u64);
                let visible_right = tr.min(right);
                let first_word = ((visible_left - left) / 64) as usize;
                let end_word = ((visible_right - left).div_ceil(64)) as usize;
                let mut spans = Vec::with_capacity((end_word - first_word) * 2);
                for col in first_word..end_word {
                    let word_left = left + col as u64 * 64;
                    let mut start = word_left.max(visible_left);
                    let end = (word_left + 64).min(visible_right);
                    while start < end {
                        let px = (start - x as u64) / scale as u64;
                        let stop = end.min(x as u64 + (px + 1) * scale as u64);
                        let fragment = mask((stop - start) as usize) << (start - word_left);
                        spans.push((col, fragment, px as usize));
                        start = stop;
                    }
                }
                for row in row_begin..row_end {
                    let py = (top + row as u64 - y as u64) / scale as u64;
                    let output_row = py as usize * width as usize;
                    let input_row = row * (self.size / 64);
                    for &(col, fragment, px) in &spans {
                        add_pixel(
                            out,
                            &mut meta,
                            output_row + px,
                            (tile.words[input_row + col] & fragment).count_ones() as u64,
                            period,
                            log_period,
                        );
                    }
                }
                continue;
            }
            for row in row_begin..row_end {
                for col in 0..self.size / 64 {
                    let mut word = tile.words[row * (self.size / 64) + col];
                    while word != 0 {
                        let bit = word.trailing_zeros() as u64;
                        word &= word - 1;
                        let cx = left + col as u64 * 64 + bit;
                        if cx < x as u64 || cx >= right {
                            continue;
                        }
                        let px = (cx - x as u64) / scale as u64;
                        let py = (top + row as u64 - y as u64) / scale as u64;
                        add_pixel(
                            out,
                            &mut meta,
                            (py * width as u64 + px) as usize,
                            1,
                            period,
                            log_period,
                        );
                    }
                }
            }
        }
    }
    fn randomize(
        &mut self,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        density: f64,
        seed: u64,
    ) -> Result<(), String> {
        if !density.is_finite() || !(0.0..=1.0).contains(&density) {
            return Err("Density must be between 0 and 1".into());
        }
        let right = x as u64 + width as u64;
        let bottom = y as u64 + height as u64;
        if right > self.width as u64 || bottom > self.height as u64 {
            return Err("Random rectangle lies outside the field".into());
        }
        if width == 0 || height == 0 {
            return Ok(());
        }
        let sx = x as usize / self.size;
        let ex = (right as usize - 1) / self.size;
        let sy = y as usize / self.size;
        let ey = (bottom as usize - 1) / self.size;
        let tile_count = (ex - sx + 1) as u64 * (ey - sy + 1) as u64;
        let existing = self
            .tiles
            .keys()
            .filter(|&&(tx, ty)| {
                tx as usize >= sx && tx as usize <= ex && ty as usize >= sy && ty as usize <= ey
            })
            .count() as u64;
        let growth = tile_count.saturating_sub(existing);
        let item_bytes = self.tile_bytes() + 64;
        let batch_len = self.batch_len(item_bytes, tile_count);
        // Reject the complete operation before modifying ANY cells. Replacing
        // existing tiles needs only bounded copies; only new tiles add resident
        // state. Include temporary map expansion alongside batch scratch.
        let workspace = growth
            .saturating_mul(item_bytes)
            .saturating_add(batch_len as u64 * item_bytes)
            .saturating_add(if growth > 0 {
                self.tiles.len() as u64 * 32
            } else {
                0
            });
        self.room(workspace)?;
        self.cycles.clear();
        self.progress.total.store(tile_count, Ordering::Relaxed);
        self.progress.phase.store(2, Ordering::Release);
        let columns = (ex - sx + 1) as u64;
        for first in (0..tile_count).step_by(batch_len) {
            let end = (first + batch_len as u64).min(tile_count);
            let coords: Vec<_> = (first..end)
                .map(|i| {
                    (
                        (sx as u64 + i % columns) as u32,
                        (sy as u64 + i / columns) as u32,
                    )
                })
                .collect();
            let updates: Vec<_> = self.pool.install(|| {
                coords
                    .par_iter()
                    .map(|&coord| {
                        let mut tile = self
                            .tiles
                            .get(&coord)
                            .map_or_else(|| Tile::empty(self.size), |t| (**t).clone());
                        let left = coord.0 as u64 * self.size as u64;
                        let top = coord.1 as u64 * self.size as u64;
                        for cy in (y as u64).max(top)..bottom.min(top + self.size as u64) {
                            for cx in (x as u64).max(left)..right.min(left + self.size as u64) {
                                let random = splitmix64(seed ^ ((cy << 32) | cx));
                                let alive =
                                    (random >> 11) as f64 * (1.0 / 9007199254740992.0) < density;
                                let word = &mut tile.words[(cy - top) as usize * (self.size / 64)
                                    + ((cx - left) / 64) as usize];
                                let bit = 1u64 << (cx % 64);
                                if alive {
                                    *word |= bit;
                                } else {
                                    *word &= !bit;
                                }
                            }
                        }
                        tile.recount();
                        self.progress.completed.fetch_add(1, Ordering::Relaxed);
                        (coord, tile)
                    })
                    .collect()
            });
            for (coord, tile) in updates {
                self.histories.remove(&coord);
                if let Some(old) = self.tiles.remove(&coord) {
                    self.population -= old.population;
                }
                self.population += tile.population;
                if tile.population != 0 {
                    self.tiles.insert(coord, Arc::new(tile));
                }
            }
        }
        self.progress.phase.store(3, Ordering::Release);
        self.export_index = None;
        Ok(())
    }
    fn stat(&self, code: u32) -> u64 {
        match code {
            0 => self.tiles.len() as u64,
            3 => self.cache.bytes,
            6 => self.memory(),
            8 => self.size as u64,
            9 => self.pool.current_num_threads() as u64,
            10 => self.memory_limit,
            12 => self.cache.order.len() as u64,
            13 => ((self.width as u64).div_ceil(self.size as u64)
                * (self.height as u64).div_ceil(self.size as u64))
            .saturating_sub(self.stats[7]),
            17 => self.histories.len() as u64 * HISTORY_BYTES,
            18 => self.cycles.active.len() as u64,
            21 => self.cycles.captures.len() as u64,
            22 => self.cycles.bytes,
            23 => self.cycles.start,
            24 => self.cycles.enabled as u64,
            25 => self.cycles.probes.len() as u64,
            26 => self.cycles.max_period as u64,
            27 => self.cycles.runtime_limit,
            n if n < 28 => self.stats[n as usize],
            _ => 0,
        }
    }
}

fn mask(bits: usize) -> u64 {
    if bits >= 64 {
        u64::MAX
    } else {
        (1u64 << bits) - 1
    }
}
fn splitmix64(mut n: u64) -> u64 {
    n = n.wrapping_add(0x9e3779b97f4a7c15);
    n = (n ^ (n >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
    n = (n ^ (n >> 27)).wrapping_mul(0x94d049bb133111eb);
    n ^ (n >> 31)
}
fn hash_input(words: &[u64], valid: (usize, usize)) -> u64 {
    let mut h = splitmix64(((valid.0 as u64) << 32) | valid.1 as u64);
    for &w in words {
        h = (h ^ w).wrapping_mul(0x100000001b3);
    }
    h
}
fn compute(input: &[u64], size: usize, valid: (usize, usize)) -> Option<Arc<Tile>> {
    let words_per_row = size / 64;
    let stride = words_per_row + 2;
    let mut tile = Tile::empty(size);
    for row in 0..valid.1 {
        for col in 0..valid.0.div_ceil(64) {
            let i = (row + 1) * stride + col + 1;
            let a = input[i - stride];
            let b = input[i];
            let c = input[i + stride];
            let neighbors = [
                (a << 1) | (input[i - stride - 1] >> 63),
                a,
                (a >> 1) | (input[i - stride + 1] << 63),
                (b << 1) | (input[i - 1] >> 63),
                (b >> 1) | (input[i + 1] << 63),
                (c << 1) | (input[i + stride - 1] >> 63),
                c,
                (c >> 1) | (input[i + stride + 1] << 63),
            ];
            let (mut ones, mut twos, mut fours, mut eights) = (0u64, 0u64, 0u64, 0u64);
            for n in neighbors {
                let c1 = ones & n;
                ones ^= n;
                let c2 = twos & c1;
                twos ^= c1;
                let c3 = fours & c2;
                fours ^= c2;
                eights ^= c3;
            }
            let result =
                twos & !fours & !eights & (ones | b) & mask(valid.0.saturating_sub(col * 64));
            tile.words[row * words_per_row + col] = result;
        }
    }
    tile.recount();
    if tile.population == 0 {
        None
    } else {
        Some(Arc::new(tile))
    }
}

// C ABI calls must be serialized by the caller for each engine instance.
// Invalid non-null pointers remain caller errors, as in conventional C APIs.
fn guard<T: Copy>(
    ptr: *mut Handle,
    fallback: T,
    f: impl FnOnce(&mut Engine) -> Result<T, String>,
) -> T {
    if ptr.is_null() {
        return fallback;
    }
    let engine = unsafe { &mut *(*ptr).inner.get() };
    match catch_unwind(AssertUnwindSafe(|| f(engine))) {
        Ok(Ok(value)) => {
            engine.error = CString::default();
            value
        }
        Ok(Err(error)) => {
            engine.fail(error);
            fallback
        }
        Err(_) => {
            engine.fail("Native engine panic; operation aborted");
            fallback
        }
    }
}
#[no_mangle]
pub extern "C" fn life_create(
    width: u32,
    height: u32,
    tile_size: u32,
    threads: u32,
    cache_mb: u32,
) -> *mut Handle {
    catch_unwind(|| {
        Engine::new(width, height, tile_size, threads, cache_mb)
            .ok()
            .map_or(std::ptr::null_mut(), |e| {
                Box::into_raw(Box::new(Handle {
                    progress: e.progress.clone(),
                    inner: UnsafeCell::new(e),
                }))
            })
    })
    .unwrap_or(std::ptr::null_mut())
}
#[no_mangle]
pub unsafe extern "C" fn life_destroy(ptr: *mut Handle) {
    if !ptr.is_null() {
        let _ = catch_unwind(AssertUnwindSafe(|| drop(Box::from_raw(ptr))));
    }
}
#[no_mangle]
pub extern "C" fn life_set_cell(ptr: *mut Handle, x: u32, y: u32, alive: u8) -> u8 {
    guard(ptr, 0, |e| {
        e.set(x, y, alive != 0)?;
        Ok(1)
    })
}
#[no_mangle]
pub extern "C" fn life_get_cell(ptr: *mut Handle, x: u32, y: u32) -> u8 {
    guard(ptr, 0, |e| Ok(e.get(x, y) as u8))
}
#[no_mangle]
pub extern "C" fn life_step(ptr: *mut Handle) -> u64 {
    let result = guard(ptr, u64::MAX, |e| {
        e.progress.completed.store(0, Ordering::Relaxed);
        e.progress.total.store(0, Ordering::Relaxed);
        e.progress.phase.store(1, Ordering::Release);
        e.step()
    });
    if !ptr.is_null() {
        unsafe {
            (&(*ptr).progress).phase.store(0, Ordering::Release);
        }
    }
    result
}
#[no_mangle]
pub unsafe extern "C" fn life_progress(ptr: *const Handle, code: u32) -> u64 {
    if ptr.is_null() {
        return 0;
    }
    let progress = &(*ptr).progress;
    match code {
        0 => progress.completed.load(Ordering::Relaxed),
        1 => progress.total.load(Ordering::Relaxed),
        2 => progress.phase.load(Ordering::Acquire),
        _ => 0,
    }
}
#[no_mangle]
pub extern "C" fn life_generation(ptr: *mut Handle) -> u64 {
    guard(ptr, 0, |e| Ok(e.generation))
}
#[no_mangle]
pub extern "C" fn life_population(ptr: *mut Handle) -> u64 {
    guard(ptr, 0, |e| Ok(e.population))
}
#[no_mangle]
pub extern "C" fn life_set_generation(ptr: *mut Handle, generation: u64) {
    guard(ptr, (), |e| {
        e.generation = generation;
        e.histories.clear();
        e.cycles.clear();
        Ok(())
    });
}
#[no_mangle]
pub extern "C" fn life_clear(ptr: *mut Handle) {
    guard(ptr, (), |e| {
        e.tiles.clear();
        e.population = 0;
        e.generation = 0;
        e.stats = [0; 28];
        e.histories.clear();
        e.cycles.clear();
        e.export_index = None;
        e.cache = Cache::new(e.cache.limit);
        Ok(())
    });
}
#[no_mangle]
pub extern "C" fn life_set_wrap(ptr: *mut Handle, wrap: u8) -> u8 {
    guard(ptr, 0, |e| {
        e.wrap = wrap != 0;
        e.histories.clear();
        e.cycles.clear();
        Ok(1)
    })
}
#[no_mangle]
pub extern "C" fn life_stat(ptr: *mut Handle, code: u32) -> u64 {
    guard(ptr, 0, |e| Ok(e.stat(code)))
}
#[no_mangle]
pub extern "C" fn life_period(ptr: *mut Handle, x: u32, y: u32) -> u64 {
    guard(ptr, 0, |e| {
        Ok(e.histories
            .get(&(x / e.size as u32, y / e.size as u32))
            .map_or(0, |h| h.period))
    })
}
#[no_mangle]
pub extern "C" fn life_configure_cycles(
    ptr: *mut Handle,
    enabled: u32,
    start_generation: u64,
    max_period: u32,
    memory_mb: u32,
    interval: u32,
) -> u8 {
    guard(ptr, 0, |e| {
        e.configure_cycles(enabled, start_generation, max_period, memory_mb, interval)?;
        Ok(1)
    })
}
#[no_mangle]
pub extern "C" fn life_cluster_info(ptr: *mut Handle, tx: u32, ty: u32, code: u32) -> u64 {
    guard(ptr, 0, |e| {
        let coord = (tx, ty);
        let population = e.tiles.get(&coord).map_or(0, |t| t.population);
        Ok(match code {
            0 => population,
            1 => e.certified_period(coord) as u64,
            2 => e.cycles.active.get(&coord).is_some_and(|c| c.replayed_last) as u64,
            3 => {
                if population == 0 {
                    0
                } else {
                    match e.certified_period(coord) {
                        0 => 1,
                        1 => 2,
                        _ => 3,
                    }
                }
            }
            _ => 0,
        })
    })
}
#[no_mangle]
pub extern "C" fn life_set_memory_limit(ptr: *mut Handle, bytes: u64) -> u8 {
    guard(ptr, 0, |e| {
        if bytes < e.tiles.len() as u64 * e.tile_bytes() + 4096 {
            return Err("Budget is smaller than current cell state".into());
        }
        e.memory_limit = bytes;
        e.export_index = None;
        e.cycles
            .trim(bytes.saturating_sub(e.tiles.len() as u64 * e.tile_bytes() + 4096));
        e.cache_budget = e.cache_budget.min(bytes / 4);
        if e.cache_budget < e.cache.limit {
            e.cache = Cache::new(e.cache_budget);
            e.histories.clear();
        } else {
            e.cache.limit = e.cache_budget;
        }
        e.cache.trim();
        if e.histories.len() as u64 * HISTORY_BYTES > e.cache.limit / 8 {
            e.histories = BTreeMap::new();
        }
        while e.memory() > bytes && !e.cache.order.is_empty() {
            e.cache.evict();
        }
        if e.memory() > bytes {
            e.histories = BTreeMap::new();
        }
        e.cycles
            .trim(bytes.saturating_sub(e.memory() - e.cycles.bytes));
        Ok(1)
    })
}
#[no_mangle]
pub unsafe extern "C" fn life_last_error(ptr: *const Handle) -> *const c_char {
    if ptr.is_null() {
        c"Invalid engine handle".as_ptr()
    } else {
        (*(*ptr).inner.get()).error.as_ptr()
    }
}
#[no_mangle]
pub unsafe extern "C" fn life_import_cells(
    ptr: *mut Handle,
    cells: *const u64,
    count: usize,
) -> u8 {
    guard(ptr, 0, |e| {
        if count == 0 {
            return Ok(1);
        }
        if cells.is_null() || count > isize::MAX as usize / 8 {
            return Err("Invalid import buffer".into());
        }
        e.import(std::slice::from_raw_parts(cells, count))?;
        Ok(1)
    })
}
#[no_mangle]
pub unsafe extern "C" fn life_export_cells(
    ptr: *mut Handle,
    out: *mut u64,
    capacity: usize,
) -> usize {
    guard(ptr, 0, |e| {
        if !out.is_null() && capacity > 0 {
            if capacity > isize::MAX as usize / 8 {
                return Err("Invalid export capacity".into());
            }
            if e.export_index.is_none() {
                e.room(e.tiles.len() as u64 * 16)?;
            }
            e.export_range(0, std::slice::from_raw_parts_mut(out, capacity));
        }
        Ok(e.population as usize)
    })
}
#[no_mangle]
pub unsafe extern "C" fn life_export_range(
    ptr: *mut Handle,
    offset: u64,
    out: *mut u64,
    capacity: usize,
) -> usize {
    guard(ptr, 0, |e| {
        if capacity == 0 {
            return Ok(0);
        }
        if out.is_null() || capacity > isize::MAX as usize / 8 {
            return Err("Invalid export buffer".into());
        }
        if e.export_index.is_none() {
            e.room(e.tiles.len() as u64 * 16)?;
        }
        Ok(e.export_range(offset, std::slice::from_raw_parts_mut(out, capacity)))
    })
}
#[no_mangle]
pub unsafe extern "C" fn life_render(
    ptr: *mut Handle,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    scale: u32,
    out: *mut u64,
) -> u8 {
    guard(ptr, 0, |e| {
        let length = width as u64 * height as u64;
        if scale == 0 || length > 16_777_216 || (length > 0 && out.is_null()) {
            return Err("Invalid viewport, scale or output buffer (maximum 16M pixels)".into());
        }
        if length > 0 {
            e.render(
                x,
                y,
                width,
                height,
                scale,
                std::slice::from_raw_parts_mut(out, length as usize),
            );
        }
        Ok(1)
    })
}
/// All four outputs describe exactly the same completed generation and bins.
/// As with other non-progress calls, the caller must hold its engine lock.
#[no_mangle]
pub unsafe extern "C" fn life_render_cycles(
    ptr: *mut Handle,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    scale: u32,
    out_counts: *mut u64,
    out_known_live: *mut u64,
    out_period_log2_sum: *mut f64,
    out_period_max: *mut u32,
) -> u8 {
    render_region_buffers(
        ptr,
        x,
        y,
        width,
        height,
        scale,
        (width as u64 * scale as u64, height as u64 * scale as u64),
        out_counts,
        Some((out_known_live, out_period_log2_sum, out_period_max)),
    )
}

/// Render a rectangle measured in cells, clipping the final row and column of bins.
#[no_mangle]
pub unsafe extern "C" fn life_render_region(
    ptr: *mut Handle,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    scale: u32,
    counts: *mut u64,
    known: *mut u64,
    logs: *mut f64,
    maximum: *mut u32,
) -> u8 {
    let cycles = if known.is_null() && logs.is_null() && maximum.is_null() {
        None
    } else {
        Some((known, logs, maximum))
    };
    // render_region_buffers rejects a zero scale before touching any buffers.
    let divisor = scale.max(1);
    render_region_buffers(
        ptr,
        x,
        y,
        width.div_ceil(divisor),
        height.div_ceil(divisor),
        scale,
        (width as u64, height as u64),
        counts,
        cycles,
    )
}

unsafe fn render_region_buffers(
    ptr: *mut Handle,
    x: u32,
    y: u32,
    columns: u32,
    rows: u32,
    scale: u32,
    extent: (u64, u64),
    counts: *mut u64,
    cycles: Option<(*mut u64, *mut f64, *mut u32)>,
) -> u8 {
    guard(ptr, 0, |e| {
        let length = columns as u64 * rows as u64;
        let limit = if cycles.is_some() {
            524_288
        } else {
            16_777_216
        };
        if scale == 0 || length > limit {
            return Err("Invalid viewport size or scale".into());
        }
        if length == 0 {
            return Ok(1);
        }
        if counts.is_null() {
            return Err("Missing viewport buffer".into());
        }
        let length = length as usize;
        let meta = if let Some((known, logs, maximum)) = cycles {
            if known.is_null() || logs.is_null() || maximum.is_null() {
                return Err("Missing cycle viewport buffer".into());
            }
            Some(CyclePixels {
                known: std::slice::from_raw_parts_mut(known, length),
                logsum: std::slice::from_raw_parts_mut(logs, length),
                maximum: std::slice::from_raw_parts_mut(maximum, length),
            })
        } else {
            None
        };
        e.render_impl(
            x,
            y,
            columns,
            extent,
            scale,
            std::slice::from_raw_parts_mut(counts, length),
            meta,
        );
        Ok(1)
    })
}
#[no_mangle]
pub extern "C" fn life_randomize(
    ptr: *mut Handle,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
    density: f64,
    seed: u64,
) -> u8 {
    let result = guard(ptr, 0, |e| {
        e.progress.completed.store(0, Ordering::Relaxed);
        e.progress.total.store(0, Ordering::Relaxed);
        e.progress.phase.store(1, Ordering::Release);
        e.randomize(x, y, width, height, density, seed)?;
        Ok(1)
    });
    if !ptr.is_null() {
        unsafe {
            (&(*ptr).progress).phase.store(0, Ordering::Release);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn place_rle(e: &mut Engine, x0: u32, y0: u32, body: &str) {
        let (mut x, mut y, mut run) = (x0, y0, 0u32);
        for c in body.chars() {
            if c.is_ascii_digit() {
                run = run * 10 + c.to_digit(10).unwrap();
                continue;
            }
            let n = run.max(1);
            run = 0;
            match c {
                'o' => {
                    for dx in 0..n {
                        e.set(x + dx, y, true).unwrap();
                    }
                    x += n;
                }
                'b' => x += n,
                '$' => {
                    y += n;
                    x = x0;
                }
                '!' => break,
                _ => (),
            }
        }
    }
    fn snapshot(e: &Engine) -> Vec<bool> {
        (0..e.height)
            .flat_map(|y| (0..e.width).map(move |x| e.get(x, y)))
            .collect()
    }
    #[test]
    fn guarded_cycles_exact_periods_delay_and_real_compute_reduction() {
        let mut e = Engine::new(256, 64, 64, 3, 0).unwrap();
        e.configure_cycles(1, 8, 16, 8, 8).unwrap();
        place_rle(&mut e, 20, 20, "2o$2o!");
        place_rle(&mut e, 84, 20, "3o!");
        place_rle(&mut e,145,20,"2b3o3b3o2$o4bobo4bo$o4bobo4bo$o4bobo4bo$2b3o3b3o2$2b3o3b3o$o4bobo4bo$o4bobo4bo$o4bobo4bo2$2b3o3b3o!");
        place_rle(&mut e, 210, 20, "2bo4bo$2ob4ob2o$2bo4bo!");
        let mut scalar = snapshot(&e);
        for generation in 1..=80 {
            scalar = reference(&scalar, 256, 64, false);
            e.step().unwrap();
            assert_state(&e, &scalar);
            if generation <= 8 {
                assert_eq!(e.stat(18), 0);
                assert_eq!(e.stat(19), 0);
            }
            assert!(e.cycles.bytes <= e.cycles.runtime_limit);
        }
        for (x, period) in [1, 2, 3, 15].into_iter().enumerate() {
            assert_eq!(e.certified_period((x as u32, 0)), period);
        }
        assert_eq!(e.stat(19), 4);
        assert_eq!(e.stat(2), 0);
        let stable = &e.cycles.active[&(0, 0)];
        assert!(Arc::ptr_eq(&stable.phases[0].state, &e.tiles[&(0, 0)]));
        assert!(stable.charge < e.tile_bytes());
    }
    #[test]
    fn guarded_halos_cover_every_external_edge_corner_and_partial_torus() {
        for wrap in [false, true] {
            for coord in [(0, 0), (1, 1), (2, 2)] {
                let mut base = Engine::new(131, 135, 64, 1, 0).unwrap();
                base.wrap = wrap;
                base.configure_cycles(1, 0, 16, 4, 1).unwrap();
                let (w, h) = base.valid(coord);
                let (x, y) = (coord.0 * 64, coord.1 * 64);
                place_rle(
                    &mut base,
                    x + (w as u32 - 2) / 2,
                    y + (h as u32 - 2) / 2,
                    "2o$2o!",
                );
                base.step().unwrap();
                assert_eq!(base.certified_period(coord), 1);
                let original = snapshot(&base);
                let edges = [
                    (x as i64 - 1, y as i64 + h as i64 / 2),
                    (x as i64 + w as i64, y as i64 + h as i64 / 2),
                    (x as i64 + w as i64 / 2, y as i64 - 1),
                    (x as i64 + w as i64 / 2, y as i64 + h as i64),
                    (x as i64 - 1, y as i64 - 1),
                    (x as i64 + w as i64, y as i64 - 1),
                    (x as i64 - 1, y as i64 + h as i64),
                    (x as i64 + w as i64, y as i64 + h as i64),
                ];
                for (mut cx, mut cy) in edges {
                    if wrap {
                        cx = cx.rem_euclid(131);
                        cy = cy.rem_euclid(135);
                    }
                    if cx < 0 || cy < 0 || cx >= 131 || cy >= 135 {
                        continue;
                    }
                    // Preserve a trained watcher while changing a neighboring
                    // tile, as a neighboring generation commit would do.
                    let changed = (cx as u32 / 64, cy as u32 / 64);
                    if changed == coord {
                        continue;
                    }
                    let mut e = Engine::new(131, 135, 64, 1, 0).unwrap();
                    e.wrap = wrap;
                    e.configure_cycles(1, 0, 16, 4, 1).unwrap();
                    for yy in 0..135 {
                        for xx in 0..131 {
                            if original[yy * 131 + xx] {
                                e.set(xx as u32, yy as u32, true).unwrap();
                            }
                        }
                    }
                    e.step().unwrap();
                    let tile = e
                        .tiles
                        .entry(changed)
                        .or_insert_with(|| Arc::new(Tile::empty(64)));
                    let tile = Arc::make_mut(tile);
                    tile.words[cy as usize % 64] |= 1u64 << (cx as usize % 64);
                    tile.recount();
                    e.population = e.tiles.values().map(|t| t.population).sum();
                    assert_eq!(
                        e.certified_period(coord),
                        0,
                        "coord {coord:?} at {cx},{cy},wrap {wrap}"
                    );
                    let expected = reference(&snapshot(&e), 131, 135, wrap);
                    e.step().unwrap();
                    assert_state(&e, &expected);
                    assert!(e.stat(20) >= 1);
                }
            }
        }
    }
    #[test]
    fn cycle_hash_collisions_only_start_untrusted_prospective_capture() {
        let mut e = Engine::new(64, 64, 64, 1, 0).unwrap();
        e.configure_cycles(1, 0, 4, 4, 1).unwrap();
        place_rle(&mut e, 20, 20, "bo$2bo$3o!"); // translating glider, not a local oscillator
        e.step().unwrap();
        let hash = hash_input(&e.tiles[&(0, 0)].words, (64, 64));
        let probe = e.cycles.probes.get_mut(&(0, 0)).unwrap();
        probe.recent.clear();
        probe.recent.push_back((hash, 0)); // force a hash collision
        let mut scalar = snapshot(&e);
        for _ in 0..20 {
            scalar = reference(&scalar, 64, 64, false);
            e.step().unwrap();
            assert_state(&e, &scalar);
            assert_eq!(e.certified_period((0, 0)), 0);
        }
    }
    #[test]
    fn cycle_helpers_evict_before_authoritative_memory_and_edits_invalidate() {
        let mut e = Engine::new(512, 512, 64, 2, 0).unwrap();
        e.configure_cycles(1, 0, 16, 8, 1).unwrap();
        for ty in 0..8 {
            for tx in 0..8 {
                place_rle(&mut e, tx * 64 + 20, ty * 64 + 20, "3o!");
            }
        }
        for _ in 0..8 {
            e.step().unwrap();
        }
        assert!(e.stat(18) > 0);
        assert!(e.cycles.bytes > 0);
        let before = snapshot(&e);
        let (_, workspace) = e.step_workspace(64);
        let authoritative = e.tiles.len() as u64 * e.tile_bytes() + 4096;
        e.memory_limit = authoritative + workspace + 100;
        e.step().unwrap();
        assert_state(&e, &reference(&before, 512, 512, false));
        assert!(e.memory() <= e.memory_limit);
        assert_eq!(e.cycles.bytes, 0);
        e.memory_limit = 8 << 20;
        for _ in 0..8 {
            e.step().unwrap();
        }
        assert!(e.stat(18) > 0);
        e.set(0, 0, true).unwrap();
        assert_eq!(e.cycles.bytes, 0);
        let cells = snapshot(&e);
        let generation = e.generation;
        assert!(e.configure_cycles(2, 0, 16, 4, 1).is_err());
        assert_eq!(snapshot(&e), cells);
        assert_eq!(e.generation, generation);
        e.configure_cycles(0, 0, 16, 4, 1).unwrap();
        assert_eq!(e.stat(18), 0);
    }
    #[test]
    fn cycles_mixed_random_differential_and_exact_metadata() {
        for wrap in [false, true] {
            let mut a = Engine::new(195, 137, 64, 3, 0).unwrap();
            let mut b = Engine::new(195, 137, 64, 1, 0).unwrap();
            a.wrap = wrap;
            b.wrap = wrap;
            a.configure_cycles(1, 2, 16, 2, 8).unwrap();
            b.configure_cycles(0, 0, 16, 0, 1).unwrap();
            for e in [&mut a, &mut b] {
                e.randomize(112, 0, 83, 137, 0.12, 29).unwrap();
                place_rle(e, 20, 20, "2o$2o!");
                place_rle(e, 80, 20, "3o!");
            }
            for _ in 0..100 {
                a.step().unwrap();
                b.step().unwrap();
                assert_eq!(snapshot(&a), snapshot(&b));
            }
            for (x, y, scale) in [
                (0, 0, 1),
                (17, 19, 3),
                (63, 0, 64),
                (0, 0, 128),
                (194, 136, 200),
            ] {
                let (columns, rows) = (7, 5);
                let n = (columns * rows) as usize;
                let (mut counts, mut known, mut logs, mut maximum) =
                    (vec![0; n], vec![0; n], vec![0.; n], vec![0; n]);
                a.render_impl(
                    x,
                    y,
                    columns,
                    (columns as u64 * scale as u64, rows as u64 * scale as u64),
                    scale,
                    &mut counts,
                    Some(CyclePixels {
                        known: &mut known,
                        logsum: &mut logs,
                        maximum: &mut maximum,
                    }),
                );
                let (mut ec, mut ek, mut el, mut em) =
                    (vec![0; n], vec![0; n], vec![0.; n], vec![0; n]);
                for cy in y..(y + rows * scale).min(a.height) {
                    for cx in x..(x + columns * scale).min(a.width) {
                        if !a.get(cx, cy) {
                            continue;
                        }
                        let i = ((cy - y) / scale * columns + (cx - x) / scale) as usize;
                        ec[i] += 1;
                        let p = a.certified_period((cx / 64, cy / 64));
                        if p > 0 {
                            ek[i] += 1;
                            el[i] += (p as f64).log2();
                            em[i] = em[i].max(p);
                        }
                    }
                }
                assert_eq!(counts, ec);
                assert_eq!(known, ek);
                assert_eq!(maximum, em);
                for i in 0..n {
                    assert!((logs[i] - el[i]).abs() < 1e-8);
                }
            }
        }
    }
    fn reference(old: &[bool], w: usize, h: usize, wrap: bool) -> Vec<bool> {
        let mut next = vec![false; old.len()];
        for y in 0..h {
            for x in 0..w {
                let mut n = 0;
                for dy in -1isize..=1 {
                    for dx in -1isize..=1 {
                        if dx == 0 && dy == 0 {
                            continue;
                        }
                        let mut nx = x as isize + dx;
                        let mut ny = y as isize + dy;
                        if wrap {
                            nx = nx.rem_euclid(w as isize);
                            ny = ny.rem_euclid(h as isize);
                        }
                        if nx >= 0 && nx < w as isize && ny >= 0 && ny < h as isize {
                            n += old[ny as usize * w + nx as usize] as u32;
                        }
                    }
                }
                next[y * w + x] = n == 3 || n == 2 && old[y * w + x];
            }
        }
        next
    }
    fn assert_state(e: &Engine, state: &[bool]) {
        assert_eq!(e.population, state.iter().filter(|&&x| x).count() as u64);
        for y in 0..e.height {
            for x in 0..e.width {
                assert_eq!(
                    e.get(x, y),
                    state[y as usize * e.width as usize + x as usize],
                    "generation {} cell {},{} wrap {}",
                    e.generation,
                    x,
                    y,
                    e.wrap
                );
            }
        }
    }
    #[test]
    fn exhaustive_three_by_three() {
        for wrap in [false, true] {
            let mut e = Engine::new(3, 3, 64, 1, 2).unwrap();
            e.wrap = wrap;
            for bits in 0u64..512 {
                e.tiles.clear();
                e.population = 0;
                let mut old = vec![false; 9];
                for i in 0..9 {
                    old[i] = bits & (1 << i) != 0;
                    if old[i] {
                        e.set((i % 3) as u32, (i / 3) as u32, true).unwrap();
                    }
                }
                e.step().unwrap();
                assert_state(&e, &reference(&old, 3, 3, wrap));
            }
        }
    }
    #[test]
    fn padded_tile_rows_match_world_words_at_partial_and_aligned_seams() {
        for size in [64u32, 128, 512, 1024] {
            for (width, height) in [
                (3 * size, 3 * size),
                (3 * size + 63, 3 * size + 1),
                (2 * size + 64, 2 * size),
                (size, size - 1),
                (3, 5),
            ] {
                let mut e = Engine::new(width, height, size, 1, 0).unwrap();
                let columns = width.div_ceil(size);
                let rows = height.div_ceil(size);
                for ty in 0..rows {
                    for tx in 0..columns {
                        if (tx + 2 * ty) % 4 == 1 {
                            continue; // Missing source tiles must supply zeroes.
                        }
                        let x = tx * size;
                        let y = ty * size;
                        let w = size.min(width - x);
                        let h = size.min(height - y);
                        for dy in [0, h / 2, h.saturating_sub(2), h - 1] {
                            for dx in [0, 1.min(w - 1), w / 2, w.saturating_sub(2), w - 1] {
                                e.set(x + dx, y + dy, true).unwrap();
                            }
                        }
                    }
                }
                for wrap in [false, true] {
                    e.wrap = wrap;
                    for ty in 0..rows {
                        for tx in 0..columns {
                            let x = i64::from(tx * size);
                            let y = i64::from(ty * size);
                            let input = e.input((tx, ty));
                            let mut words = input.into_iter();
                            for row in -1..=i64::from(size) {
                                for column in -1..=i64::from(size / 64) {
                                    assert_eq!(
                                        words.next(),
                                        Some(e.world_word(x + 64 * column, y + row)),
                                        "world {width}x{height}, tile {size} ({tx},{ty}), wrap {wrap}, word ({column},{row})"
                                    );
                                }
                            }
                            assert_eq!(words.next(), None);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn random_fields_partial_tiles_and_threads() {
        for (w, h) in [
            (1, 1),
            (1, 5),
            (2, 7),
            (63, 65),
            (65, 67),
            (130, 129),
            (257, 131),
        ] {
            for wrap in [false, true] {
                for threads in [1, 3] {
                    let mut e = Engine::new(w, h, 64, threads, 4).unwrap();
                    e.wrap = wrap;
                    e.randomize(0, 0, w, h, 0.36, 18245).unwrap();
                    let mut state: Vec<bool> = (0..h)
                        .flat_map(|y| (0..w).map(move |x| (x, y)))
                        .map(|(x, y)| e.get(x, y))
                        .collect();
                    for _ in 0..12 {
                        state = reference(&state, w as usize, h as usize, wrap);
                        e.step().unwrap();
                        assert_state(&e, &state);
                    }
                }
            }
        }
    }
    #[test]
    fn stable_and_oscillating_cache_wakes_on_border_change() {
        let mut e = Engine::new(192, 128, 64, 2, 8).unwrap();
        for (x, y) in [
            (62, 62),
            (63, 62),
            (64, 62),
            (100, 100),
            (101, 100),
            (100, 101),
            (101, 101),
        ] {
            e.set(x, y, true).unwrap();
        }
        for _ in 0..8 {
            e.step().unwrap();
        }
        assert!(e.stats[1] > 0);
        e.set(64, 61, true).unwrap();
        let state: Vec<bool> = (0..128)
            .flat_map(|y| (0..192).map(move |x| (x, y)))
            .map(|(x, y)| e.get(x, y))
            .collect();
        e.step().unwrap();
        assert_state(&e, &reference(&state, 192, 128, false));
    }
    #[test]
    fn cache_hash_collision_requires_full_equality() {
        let mut cache = Cache::new(10000);
        cache.insert(42, vec![1], (1, 1), None);
        assert!(cache.get(42, &[2], (1, 1)).is_none());
        assert!(cache.get(42, &[1], (2, 1)).is_none());
        assert!(cache.get(42, &[1], (1, 1)).is_some());
    }
    #[test]
    fn render_export_and_random_rectangle() {
        let mut e = Engine::new(133, 99, 64, 2, 2).unwrap();
        e.set(0, 0, true).unwrap();
        e.randomize(60, 60, 70, 30, 0.5, 123).unwrap();
        assert!(e.get(0, 0));
        let mut all = vec![0; e.population as usize];
        assert_eq!(e.export_range(0, &mut all), all.len());
        let mut segmented = vec![];
        for offset in (0..all.len()).step_by(7) {
            let mut chunk = [0; 7];
            let n = e.export_range(offset as u64, &mut chunk);
            segmented.extend_from_slice(&chunk[..n]);
        }
        assert_eq!(all, segmented);
        for scale in [1, 3, 64, 200] {
            let mut out = vec![0; 20 * 20];
            e.render(55, 50, 20, 20, scale, &mut out);
            for py in 0..20 {
                for px in 0..20 {
                    let mut count = 0;
                    for y in (50 + py * scale)..(50 + (py + 1) * scale).min(e.height) {
                        for x in (55 + px * scale)..(55 + (px + 1) * scale).min(e.width) {
                            count += e.get(x, y) as u64;
                        }
                    }
                    assert_eq!(out[(py * 20 + px) as usize], count);
                }
            }
        }
        let mut clone = Engine::new(133, 99, 128, 1, 0).unwrap();
        clone.import(&all).unwrap();
        for _ in 0..5 {
            e.step().unwrap();
            clone.step().unwrap();
            let mut a = vec![0; e.population as usize];
            let mut b = vec![0; clone.population as usize];
            e.export_range(0, &mut a);
            clone.export_range(0, &mut b);
            a.sort_unstable();
            b.sort_unstable();
            assert_eq!(a, b);
        }
    }
    #[test]
    fn memory_failure_does_not_advance_generation() {
        let mut e = Engine::new(1000, 1000, 64, 1, 0).unwrap();
        e.set(500, 500, true).unwrap();
        e.memory_limit = e.memory();
        assert!(e.step().is_err());
        assert_eq!(e.generation, 0);
        assert!(e.get(500, 500));
    }
    #[test]
    fn blinker_reports_observed_period_and_restoring_generation_clears_it() {
        let mut e = Engine::new(256, 256, 64, 2, 8).unwrap();
        for x in 20..23 {
            e.set(x, 20, true).unwrap();
        }
        for _ in 0..8 {
            e.step().unwrap();
        }
        assert_eq!(e.histories[&(0, 0)].period, 2);
        assert_eq!(e.stats[14], 1);
        let handle = Box::into_raw(Box::new(Handle {
            progress: e.progress.clone(),
            inner: UnsafeCell::new(e),
        }));
        life_set_generation(handle, 0);
        assert_eq!(life_period(handle, 20, 20), 0);
        assert_ne!(life_step(handle), u64::MAX);
        unsafe {
            life_destroy(handle);
        }
    }
    #[test]
    fn cache_limits_and_import_are_transactional() {
        let mut e = Engine::new(129, 131, 64, 2, 1).unwrap();
        e.randomize(0, 0, 129, 131, 0.4, 77).unwrap();
        for _ in 0..25 {
            e.step().unwrap();
            assert!(e.cache.bytes + e.histories.len() as u64 * HISTORY_BYTES <= e.cache.limit);
        }
        let population = e.population;
        assert!(e
            .import(&[(10u64 << 32) | 10, (500u64 << 32) | 500])
            .is_err());
        assert_eq!(e.population, population);
    }
    #[test]
    fn many_batches_preserve_global_synchronous_rules() {
        for wrap in [false, true] {
            let mut e = Engine::new(385, 259, 64, 3, 4).unwrap();
            e.work_batch_bytes = 4096; // one tile per step batch
            e.wrap = wrap;
            e.randomize(0, 0, 385, 259, 0.31, 876).unwrap();
            let mut expected: Vec<bool> = (0..259)
                .flat_map(|y| (0..385).map(move |x| (x, y)))
                .map(|(x, y)| e.get(x, y))
                .collect();
            assert!(e.candidates().len() > e.batch_len(2864, e.candidates().len() as u64));
            for _ in 0..10 {
                expected = reference(&expected, 385, 259, wrap);
                e.step().unwrap();
                assert_state(&e, &expected);
            }
        }
    }
    #[test]
    fn bounded_step_fits_where_all_inputs_would_exceed_budget() {
        let mut e = Engine::new(1024, 1024, 64, 3, 0).unwrap();
        e.work_batch_bytes = 8192;
        e.randomize(0, 0, 1024, 1024, 0.25, 42).unwrap();
        let candidate_count = e.candidates().len() as u64;
        let (_, workspace) = e.step_workspace(candidate_count);
        let old_full_batch = candidate_count * ((66 * 3 * 8) as u64 + e.tile_bytes() + 640);
        assert!(workspace < old_full_batch);
        e.memory_limit = e.memory() + workspace;
        assert!(e.memory() + old_full_batch > e.memory_limit);
        e.step().unwrap();
        assert_eq!(e.generation, 1);
        assert!(e.population > 0);
        assert!(e.memory() <= e.memory_limit);
    }
    #[test]
    fn random_batches_equal_reordered_rectangle_partition() {
        let mut a = Engine::new(1_000_000, 1_000_000, 64, 3, 0).unwrap();
        let mut b = Engine::new(1_000_000, 1_000_000, 128, 1, 0).unwrap();
        a.work_batch_bytes = 2048;
        b.work_batch_bytes = 4096;
        for e in [&mut a, &mut b] {
            e.set(7, 8, true).unwrap();
            e.generation = 17;
        }
        a.randomize(700_013, 600_027, 257, 259, 0.27, 938).unwrap();
        // Reversed order and an unaligned partition exercise partial tiles.
        b.randomize(700_114, 600_027, 156, 259, 0.27, 938).unwrap();
        b.randomize(700_013, 600_027, 101, 259, 0.27, 938).unwrap();
        let mut ac = vec![0; a.population as usize];
        let mut bc = vec![0; b.population as usize];
        a.export_range(0, &mut ac);
        b.export_range(0, &mut bc);
        ac.sort_unstable();
        bc.sort_unstable();
        assert_eq!(ac, bc);
        assert!(a.get(7, 8));
        assert_eq!(a.generation, 17);
    }
    #[test]
    fn random_budget_rejection_preserves_complete_original_state() {
        let mut e = Engine::new(1024, 1024, 64, 2, 0).unwrap();
        e.work_batch_bytes = 4096;
        e.randomize(1, 2, 130, 129, 0.41, 99).unwrap();
        e.generation = 23;
        let population = e.population;
        let mut before = vec![0; population as usize];
        e.export_range(0, &mut before);
        e.memory_limit = e.memory() + 1024;
        assert!(e.randomize(0, 0, 1024, 1024, 0.5, 14).is_err());
        let mut after = vec![0; e.population as usize];
        e.export_range(0, &mut after);
        assert_eq!(before, after);
        assert_eq!(e.population, population);
        assert_eq!(e.generation, 23);
    }
    #[test]
    fn word_popcount_viewports_match_scalar_for_aligned_and_split_bins() {
        let mut e = Engine::new(1099, 777, 512, 2, 0).unwrap();
        e.randomize(0, 0, 1099, 777, 0.37, 3814).unwrap();
        let mut cells = vec![0; e.population as usize];
        e.export_range(0, &mut cells);
        for scale in [3u32, 64, 128, 200, 256, 512, 1024] {
            for (x, y) in [
                (0, 0),
                (1, 7),
                (63, 65),
                (64, 128),
                (65, 63),
                (511, 509),
                (1090, 770),
            ] {
                let width = 19u32;
                let height = 17u32;
                let mut actual = vec![0; (width * height) as usize];
                let mut expected = actual.clone();
                e.render(x, y, width, height, scale, &mut actual);
                for &cell in &cells {
                    let cx = cell as u32;
                    let cy = (cell >> 32) as u32;
                    if cx < x || cy < y {
                        continue;
                    }
                    let px = (cx - x) / scale;
                    let py = (cy - y) / scale;
                    if px < width && py < height {
                        expected[(py * width + px) as usize] += 1;
                    }
                }
                assert_eq!(actual, expected, "origin={x},{y}, scale={scale}");
                if x == 0 && y == 0 && width * scale >= e.width && height * scale >= e.height {
                    assert_eq!(actual.iter().sum::<u64>(), e.population);
                }
            }
        }
    }
}
