/* Pure, exact data operations shared by the UI, workers, and Node verification. */
function createLifeCore() {
  "use strict";
  const localization =
    globalThis.LifeI18n ||
    (typeof module === "object" && module.exports
      ? require("./i18n.js")
      : null);
  const T = localization
    ? localization.t
    : (source, ...values) =>
        Array.isArray(source)
          ? source.reduce(
              (text, part, i) => text + (i ? values[i - 1] : "") + part,
              "",
            )
          : source;
  const TILE = 64,
    WORDS = 128,
    MAX_DIM = 2000000000;
  const key = (x, y) => x + "," + y;
  const popcount = (n) => {
    n = n - ((n >>> 1) & 0x55555555);
    n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
    return (((n + (n >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  };
  function dimensions(w, h, wrap = false) {
    if (
      !Number.isInteger(w) ||
      !Number.isInteger(h) ||
      w < 1 ||
      h < 1 ||
      w > MAX_DIM ||
      h > MAX_DIM
    )
      throw Error(
        T("Dimensions must be integers from 1 to 2,000,000,000."),
      );
    if (typeof wrap !== "boolean") throw Error(T("Wrap must be true or false."));
    if (wrap && (w < 3 || h < 3))
      throw Error(T("A toroidal field needs at least 3 rows and 3 columns."));
  }
  class SparseGrid {
    constructor(width = 4096, height = 4096, wrap = false) {
      dimensions(width, height, wrap);
      this.width = width;
      this.height = height;
      this.wrap = wrap;
      this.tiles = new Map();
      this.population = 0;
      this.revision = 0;
    }
    inside(x, y) {
      return (
        Number.isInteger(x) &&
        Number.isInteger(y) &&
        x >= 0 &&
        y >= 0 &&
        x < this.width &&
        y < this.height
      );
    }
    get(x, y) {
      if (!this.inside(x, y)) return 0;
      const t = this.tiles.get(key(Math.floor(x / 64), Math.floor(y / 64)));
      if (!t) return 0;
      const i = (y % 64) * 64 + (x % 64);
      return (t.bits[i >>> 5] >>> (i & 31)) & 1;
    }
    set(x, y, v) {
      if (!this.inside(x, y)) return false;
      v = v ? 1 : 0;
      const tx = Math.floor(x / 64),
        ty = Math.floor(y / 64),
        k = key(tx, ty);
      let t = this.tiles.get(k);
      if (!t && !v) return false;
      if (!t) {
        t = {
          x: tx,
          y: ty,
          bits: new Uint32Array(WORDS),
          population: 0,
          version: 0,
          lod: new Map(),
        };
        this.tiles.set(k, t);
      }
      const i = (y % 64) * 64 + (x % 64),
        mask = 1 << (i & 31),
        old = (t.bits[i >>> 5] >>> (i & 31)) & 1;
      if (old === v) return false;
      if (v) t.bits[i >>> 5] |= mask;
      else t.bits[i >>> 5] &= ~mask;
      t.population += v - old;
      this.population += v - old;
      t.version++;
      t.lod.clear();
      this.revision++;
      if (!t.population) this.tiles.delete(k);
      return true;
    }
    setTile(k, bits) {
      const old = this.tiles.get(k);
      if (old) this.population -= old.population;
      if (!bits) {
        this.tiles.delete(k);
        this.revision++;
        return;
      }
      const [x, y] = k.split(",").map(Number);
      const copy = new Uint32Array(bits);
      let p = 0;
      for (const n of copy) p += popcount(n);
      if (p)
        this.tiles.set(k, {
          x,
          y,
          bits: copy,
          population: p,
          version: (old?.version || 0) + 1,
          lod: new Map(),
        });
      else this.tiles.delete(k);
      this.population += p;
      this.revision++;
    }
    *visibleTiles(r) {
      const left = Math.max(0, Math.floor(r.x / TILE));
      const top = Math.max(0, Math.floor(r.y / TILE));
      const right = Math.ceil(Math.min(this.width, r.x + r.width) / TILE);
      const bottom = Math.ceil(Math.min(this.height, r.y + r.height) / TILE);
      if (left >= right || top >= bottom) return;
      // A close-up costs only a few lookups, while a sparse whole-world view
      // visits occupied tiles without enumerating an enormous empty rectangle.
      if ((right - left) * (bottom - top) < this.tiles.size) {
        for (let y = top; y < bottom; y++)
          for (let x = left; x < right; x++) {
            const tile = this.tiles.get(key(x, y));
            if (tile) yield tile;
          }
      } else {
        for (const tile of this.tiles.values())
          if (tile.x >= left && tile.y >= top && tile.x < right && tile.y < bottom)
            yield tile;
      }
    }
    *cells(rect) {
      const r = rect || { x: 0, y: 0, width: this.width, height: this.height };
      for (const t of this.visibleTiles(r)) {
        const ox = t.x * 64,
          oy = t.y * 64;
        for (let wi = 0; wi < 128; wi++) {
          let word = t.bits[wi] >>> 0;
          while (word) {
            const bit = 31 - Math.clz32((word & -word) >>> 0),
              i = wi * 32 + bit,
              x = ox + (i % 64),
              y = oy + Math.floor(i / 64);
            if (x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height)
              yield [x, y];
            word = (word & (word - 1)) >>> 0;
          }
        }
      }
    }
    bounds() {
      let x = Infinity,
        y = Infinity,
        right = -1,
        bottom = -1;
      for (const tile of this.tiles.values()) {
        const ox = tile.x * TILE, oy = tile.y * TILE;
        for (let i = 0; i < WORDS; i++) {
          const word = tile.bits[i];
          if (!word) continue;
          const start = ox + (i % 2) * 32, row = oy + Math.floor(i / 2);
          x = Math.min(x, start + 31 - Math.clz32(word & -word));
          right = Math.max(right, start + 31 - Math.clz32(word));
          y = Math.min(y, row);
          bottom = Math.max(bottom, row);
        }
      }
      return right < 0
        ? { x: 0, y: 0, width: 0, height: 0 }
        : { x, y, width: right - x + 1, height: bottom - y + 1 };
    }
    packed() {
      return {
        width: this.width,
        height: this.height,
        wrap: this.wrap,
        tiles: Array.from(this.tiles, ([k, t]) => [k, t.bits.buffer]),
      };
    }
    static unpack(data) {
      const g = new SparseGrid(data.width, data.height, data.wrap);
      for (const [k, b] of data.tiles) g.setTile(k, new Uint32Array(b));
      return g;
    }
  }
  function checkRule(rule) {
    if (typeof rule !== "string" || !["B3/S23", "23/3"].includes(rule.toUpperCase().replaceAll(" ", "")))
      throw Error(T("Only B3/S23 is supported."));
  }
  function generationValue(digits) {
    if (!/^\d{1,20}$/.test(digits) || BigInt(digits) > 0xffffffffffffffffn)
      throw Error(T("Generation must be an unsigned 64-bit integer."));
    const value = Number(digits);
    return Number.isSafeInteger(value) ? value : BigInt(digits);
  }
  function parseRLE(text, options = {}) {
    const maxLive = options.maxLive ?? 5000000;
    let meta = {},
      header = null,
      body = [];
    for (const raw of String(text).split(/\r?\n/)) {
      const l = raw.trim();
      if (!l) continue;
      if (l.startsWith("#")) {
        if (l.startsWith("#C LIFE ")) {
          for (const token of l.slice(8).split(/\s+/)) {
            const m = /^(width|height|origin_x|origin_y|wrap|generation)=(\d+)$/.exec(token);
            if (!m || Object.hasOwn(meta, m[1]))
              throw Error(T("Malformed or duplicate LIFE metadata."));
            meta[m[1]] = m[1] === "generation" ? generationValue(m[2]) : Number(m[2]);
          }
        }
        continue;
      }
      if (!header) {
        const m = l.match(
          /^x\s*=\s*(\d+)\s*,\s*y\s*=\s*(\d+)(?:\s*,\s*rule\s*=\s*([^,]+))?\s*$/i,
        );
        if (!m)
          throw Error(
            T(
              "Invalid RLE header. Expected x = …, y = …, rule = B3/S23.",
            ),
          );
        checkRule(m[3] || "B3/S23");
        header = { width: Number(m[1]), height: Number(m[2]) };
        dimensions(Math.max(1, header.width), Math.max(1, header.height));
      } else body.push(l);
    }
    if (!header) throw Error(T("Empty RLE file."));
    const fieldWidth = meta.width ?? Math.max(1, header.width);
    const fieldHeight = meta.height ?? Math.max(1, header.height);
    if (meta.wrap !== undefined && meta.wrap !== 0 && meta.wrap !== 1)
      throw Error(T("RLE wrap must be 0 or 1."));
    dimensions(fieldWidth, fieldHeight, meta.wrap === 1);
    const originX = meta.origin_x ?? 0, originY = meta.origin_y ?? 0;
    if (originX + header.width > fieldWidth || originY + header.height > fieldHeight)
      throw Error(T("The RLE position extends beyond the field."));
    const placed = options.restoreField === true && Object.keys(meta).length > 0;
    const g = placed
      ? new SparseGrid(fieldWidth, fieldHeight, meta.wrap === 1)
      : new SparseGrid(Math.max(1, header.width), Math.max(1, header.height));
    let x = 0,
      y = 0,
      n = "",
      ended = false;
    const s = body.join("").replace(/\s/g, "");
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (/[0-9]/.test(c)) {
        n += c;
        if (n.length > 10) throw Error(T("RLE run length is too large."));
        continue;
      }
      if (c === "!") {
        if (n) throw Error(T("Invalid RLE run length."));
        ended = true;
        if (s.slice(i + 1).trim())
          throw Error(T("Unexpected data after the end of RLE."));
        break;
      }
      const count = n ? Number(n) : 1;
      n = "";
      if (!Number.isSafeInteger(count) || count < 1)
        throw Error(T("Invalid RLE run length."));
      if (c === "$") {
        y += count;
        x = 0;
        if (y > header.height)
          throw Error(T("RLE exceeds the specified height."));
      } else if (c === "b" || c === "o") {
        if (x + count > header.width || y >= header.height)
          throw Error(T("RLE exceeds the pattern dimensions."));
        if (c === "o") {
          if (g.population + count > maxLive)
            throw Error(
              T(
                "Too many cells for offline import.",
              ),
            );
          const startX = x + (placed ? originX : 0);
          const row = y + (placed ? originY : 0);
          for (let j = 0; j < count; j++) g.set(startX + j, row, 1);
        }
        x += count;
      } else throw Error(T("Unsupported RLE character: ") + c);
    }
    if (!ended || n) throw Error(T("RLE must end with !."));
    return {
      grid: g,
      width: header.width,
      height: header.height,
      metadata: meta,
      placed,
    };
  }
  function parseStateJSON(text) {
    const d = typeof text === "string" ? JSON.parse(text) : text;
    if (!d || typeof d !== "object" || Array.isArray(d))
      throw Error(T("The state must be a JSON object."));
    checkRule(d.rule === undefined ? "B3/S23" : d.rule);
    if (d.version !== undefined && d.version !== 1)
      throw Error(T("Unknown format version."));
    const base = d.coordinate_base === undefined ? 0 : d.coordinate_base;
    if (base !== 0 && base !== 1)
      throw Error(T("coordinate_base must be 0 or 1."));
    dimensions(d.width, d.height, d.wrap);
    const g = new SparseGrid(d.width, d.height, d.wrap);
    let generation = d.generation === undefined ? 0 : d.generation;
    if (!Number.isSafeInteger(generation) || generation < 0) {
      // Re-read the original number token only in the rare case where it
      // cannot be represented exactly by Number. Never accept a rounded value.
      if (typeof text !== "string" || typeof generation !== "number" || generation < 0 || !Number.isInteger(generation))
        throw Error(T("Generation must be an unsigned 64-bit integer."));
      generation = JSON.parse(text, (key, value, context) =>
        key === "generation" ? generationValue(context?.source ?? "") : value,
      ).generation;
    }
    if (!Array.isArray(d.cells))
      throw Error(T("JSON must contain a cells array."));
    if (d.cells.length > 5000000)
      throw Error(T("Too many cells for offline import."));
    for (const cell of d.cells) {
      if (
        !Array.isArray(cell) ||
        cell.length !== 2 ||
        !Number.isInteger(cell[0]) ||
        !Number.isInteger(cell[1])
      )
        throw Error(T("Invalid cell coordinates."));
      const x = cell[0] - base,
        y = cell[1] - base;
      if (!g.inside(x, y)) throw Error(T("Cell coordinates are outside the field."));
      if (!g.set(x, y, 1)) throw Error(T("The state contains a duplicate live cell."));
    }
    return { grid: g, generation };
  }
  function encodeStateJSON(g, generation = 0) {
    if (typeof generation !== "bigint" && !Number.isSafeInteger(generation))
      throw Error(T("Generation must be an unsigned 64-bit integer."));
    const exactGeneration = generationValue(String(generation));
    const header = JSON.stringify({
      format: "exact-life-state",
      version: 1,
      rule: "B3/S23",
      coordinate_base: 1,
      width: g.width,
      height: g.height,
      wrap: g.wrap,
    });
    // Serialize directly from sparse tiles. Millions of temporary [x,y] arrays
    // can otherwise cost several times more memory than the finished file.
    const chunks = [], batch = [];
    for (const [x, y] of g.cells()) {
      batch.push("[" + (x + 1) + "," + (y + 1) + "]");
      if (batch.length === 4096) {
        chunks.push(batch.join(","));
        batch.length = 0;
      }
    }
    if (batch.length) chunks.push(batch.join(","));
    return header.slice(0, -1) + ',"generation":' + exactGeneration + ',"cells":[' + chunks.join(",") + "]}";
  }
  function encodeRLE(g, rect) {
    const b = rect || g.bounds();
    const rows = new Map();
    for (const [x, y] of g.cells(b)) {
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push(x);
    }
    const out = [],
      run = (n, c) => {
        if (n > 0) out.push((n > 1 ? n : "") + c);
      };
    let prevY = b.y;
    for (const y of [...rows.keys()].sort((a, b) => a - b)) {
      run(y - prevY, "$");
      prevY = y;
      const xs = rows.get(y).sort((a, b) => a - b);
      let pos = b.x,
        i = 0;
      while (i < xs.length) {
        const start = xs[i];
        run(start - pos, "b");
        let end = start;
        while (i + 1 < xs.length && xs[i + 1] === end + 1) {
          i++;
          end++;
        }
        run(end - start + 1, "o");
        pos = end + 1;
        i++;
      }
    }
    out.push("!");
    const data = out.join("");
    return (
      "#C LIFE width=" +
      g.width +
      " height=" +
      g.height +
      " origin_x=" +
      b.x +
      " origin_y=" +
      b.y +
      " wrap=" +
      (g.wrap ? 1 : 0) +
      " generation=0\nx = " +
      b.width +
      ", y = " +
      b.height +
      ", rule = B3/S23\n" +
      (data.match(/.{1,70}/g) || ["!"]).join("\n") +
      "\n"
    );
  }
  function aggregate(g, rect, scale = 1) {
    if (scale < 1 || !Number.isInteger(scale) || Math.log2(scale) % 1)
      throw Error(T("scale must be a power of 2."));
    const columns = Math.ceil(rect.width / scale),
      rows = Math.ceil(rect.height / scale);
    if (columns * rows > 2097152)
      throw Error(T("Viewport is too large."));
    const counts = new Float64Array(columns * rows);
    const aligned = rect.x % scale === 0 && rect.y % scale === 0;
    const right = rect.x + rect.width, bottom = rect.y + rect.height;
    for (const t of g.visibleTiles(rect)) {
      const ox = t.x * 64,
        oy = t.y * 64;
      // A cached whole tile or bin is exact only when its live cells cannot
      // cross the requested right or bottom edge. World-edge padding is dead.
      const chunkSize = Math.min(scale, TILE);
      const clipped =
        (right < g.width && right % chunkSize !== 0 && ox + TILE > right) ||
        (bottom < g.height && bottom % chunkSize !== 0 && oy + TILE > bottom);
      if (aligned && !clipped && scale >= TILE) {
        const column = Math.floor((ox - rect.x) / scale);
        const row = Math.floor((oy - rect.y) / scale);
        counts[row * columns + column] += t.population;
        continue;
      }
      if (aligned && !clipped && scale > 1 && scale < TILE) {
        let bins = t.lod.get(scale);
        const side = 64 / scale;
        if (!bins) {
          bins = new Uint16Array(side * side);
          for (let wi = 0; wi < 128; wi++) {
            let word = t.bits[wi] >>> 0;
            while (word) {
              const bit = 31 - Math.clz32((word & -word) >>> 0),
                i = wi * 32 + bit;
              bins[
                Math.floor(Math.floor(i / 64) / scale) * side +
                  Math.floor((i % 64) / scale)
              ]++;
              word = (word & (word - 1)) >>> 0;
            }
          }
          t.lod.set(scale, bins);
        }
        for (let by = 0; by < side; by++)
          for (let bx = 0; bx < side; bx++) {
            const x = ox + bx * scale,
              y = oy + by * scale;
            if (
              x >= rect.x &&
              y >= rect.y &&
              x < rect.x + rect.width &&
              y < rect.y + rect.height
            )
              counts[
                Math.floor((y - rect.y) / scale) * columns +
                  Math.floor((x - rect.x) / scale)
              ] += bins[by * side + bx];
          }
      } else {
        for (let wi = 0; wi < 128; wi++) {
          let word = t.bits[wi] >>> 0;
          while (word) {
            const bit = 31 - Math.clz32((word & -word) >>> 0),
              i = wi * 32 + bit,
              x = ox + (i % 64),
              y = oy + Math.floor(i / 64);
            if (
              x >= rect.x &&
              y >= rect.y &&
              x < rect.x + rect.width &&
              y < rect.y + rect.height
            )
              counts[
                Math.floor((y - rect.y) / scale) * columns +
                  Math.floor((x - rect.x) / scale)
              ]++;
            word = (word & (word - 1)) >>> 0;
          }
        }
      }
    }
    return { ...rect, scale, columns, rows, counts, population: g.population };
  }
  const RANDOM_ALGORITHM = "splitmix64-coordinate-v1";
  const LOCAL_RANDOM_MAX_CELLS = 4194304;
  function randomRoute(mode, width, height) {
    dimensions(width, height);
    // The whole field determines the route, even when the selected area is small.
    return mode === "monitor" ||
      width > Math.floor(LOCAL_RANDOM_MAX_CELLS / height)
      ? "server"
      : "local";
  }
  function randomSeed(seed) {
    if (!["string", "number", "bigint"].includes(typeof seed))
      throw Error(T("Seed must be an integer or a decimal string."));
    if (typeof seed === "number" && (!Number.isSafeInteger(seed) || seed < 0))
      throw Error(
        T(
          "Provide seed as an exact integer or a decimal string.",
        ),
      );
    const text = String(seed).trim();
    if (!/^[0-9]{1,20}$/.test(text) || BigInt(text) > 0xffffffffffffffffn)
      throw Error(
        T("Seed must be an integer from 0 to 18446744073709551615."),
      );
    return BigInt(text).toString();
  }
  // Upper 32 bits of an unsigned 32×32-bit product. Each 16-bit-limb
  // intermediate is exactly representable as a Number; no float rounding.
  function multiplyHigh32(a, b) {
    const al = a & 65535,
      ah = a >>> 16,
      bl = b & 65535,
      bh = b >>> 16;
    const low = al * bl,
      middle = ah * bl + (low >>> 16);
    return (
      (ah * bh + (middle >>> 16) + (((middle & 65535) + al * bh) >>> 16)) >>> 0
    );
  }
  function coordinateRandom(seed) {
    // BigInt is used once for seed parsing, never in the per-cell loop.
    const value = BigInt(randomSeed(seed)),
      seedLow = Number(value & 0xffffffffn),
      seedHigh = Number(value >> 32n);
    return (x, y) => {
      let lo = (seedLow ^ x) >>> 0,
        hi = (seedHigh ^ y) >>> 0;
      const sum = lo + 0x7f4a7c15;
      lo = sum >>> 0;
      hi = (hi + 0x9e3779b9 + (sum >= 4294967296 ? 1 : 0)) >>> 0;
      lo = (lo ^ ((lo >>> 30) | (hi << 2))) >>> 0;
      hi = (hi ^ (hi >>> 30)) >>> 0;
      let nextHigh =
        (Math.imul(hi, 0x1ce4e5b9) +
          Math.imul(lo, 0xbf58476d) +
          multiplyHigh32(lo, 0x1ce4e5b9)) >>>
        0;
      lo = Math.imul(lo, 0x1ce4e5b9) >>> 0;
      hi = nextHigh;
      lo = (lo ^ ((lo >>> 27) | (hi << 5))) >>> 0;
      hi = (hi ^ (hi >>> 27)) >>> 0;
      nextHigh =
        (Math.imul(hi, 0x133111eb) +
          Math.imul(lo, 0x94d049bb) +
          multiplyHigh32(lo, 0x133111eb)) >>>
        0;
      lo = Math.imul(lo, 0x133111eb) >>> 0;
      hi = nextHigh;
      lo = (lo ^ ((lo >>> 31) | (hi << 1))) >>> 0;
      hi = (hi ^ (hi >>> 31)) >>> 0;
      // Exactly the native (word >> 11) / 2^53 threshold, in [0,1).
      return (hi * 2097152 + (lo >>> 11)) / 9007199254740992;
    };
  }
  function randomGrid(width, height, rect, density, seed, progress) {
    dimensions(width, height);
    if (
      typeof density !== "number" ||
      !Number.isFinite(density) ||
      !(density >= 0.01 && density <= 0.99)
    )
      throw Error(T("Density must be 1–99%."));
    if (
      !rect ||
      ![rect.x, rect.y, rect.width, rect.height].every(Number.isSafeInteger) ||
      rect.x < 0 ||
      rect.y < 0 ||
      rect.width < 1 ||
      rect.height < 1 ||
      rect.x + rect.width > width ||
      rect.y + rect.height > height
    )
      throw Error(T("The randomization rectangle must fit inside the field."));
    if (randomRoute("editor", width, height) === "server")
      throw Error(
        T("Fields larger than 4,194,304 cells are randomized on the server."),
      );
    const g = new SparseGrid(width, height);
    const rand = coordinateRandom(seed);
    for (let y = rect.y; y < rect.y + rect.height; y++) {
      for (let x = rect.x; x < rect.x + rect.width; x++)
        if (rand(x, y) < density) g.set(x, y, 1);
      if (progress && (y - rect.y) % 128 === 0)
        progress((y - rect.y) / rect.height);
    }
    if (progress) progress(1);
    return g;
  }
  function transform(cells, width, height, kind) {
    if (kind === "rotate")
      return {
        cells: cells.map(([x, y]) => [height - 1 - y, x]),
        width: height,
        height: width,
      };
    if (kind === "flip")
      return {
        cells: cells.map(([x, y]) => [width - 1 - x, y]),
        width,
        height,
      };
    throw Error(T("Unknown transformation."));
  }
  function shade(count, area, levels = 32, bias = 0.12, gain = 2.5) {
    if (count <= 0) return 0;
    const normalized = Math.min(
      1,
      Math.max(0, bias) + (Math.max(0, gain) * count) / Math.max(1, area),
    );
    return (
      (Math.max(1, Math.round(normalized * (levels - 1))) * 255) / (levels - 1)
    );
  }
  const HEAT_DEFAULTS = {
    heat_stable: 0.08,
    heat_cycle_max: 0.45,
    heat_active: 0.65,
    heat_density_gain: 0.3,
    heat_density_reference: 0.15,
    heat_hotspot_mix: 0.25,
  };
  // A fixed reference keeps the same period the same color across frames/configured search limits.
  const HEAT_PERIOD_REFERENCE = 64;
  function cycleActivityBase(period, options = HEAT_DEFAULTS) {
    const p = Math.max(0, Number(period));
    if (!p) return options.heat_active;
    return (
      options.heat_stable +
      (options.heat_cycle_max - options.heat_stable) *
        Math.min(1, Math.log2(Math.max(1, p)) / 6)
    );
  }
  function thermalValue(
    { count, area, knownLive = 0, periodLog2Sum = 0, periodMax = 0 },
    options = HEAT_DEFAULTS,
  ) {
    if (count <= 0) return 0;
    const known = Math.max(0, Math.min(count, knownLive)),
      unknown = count - known;
    const mean =
      (known * options.heat_stable +
        ((options.heat_cycle_max - options.heat_stable) * periodLog2Sum) / 6 +
        unknown * options.heat_active) /
      count;
    const peak =
      unknown > 0 ? options.heat_active : cycleActivityBase(periodMax, options);
    const activity =
      (1 - options.heat_hotspot_mix) * mean + options.heat_hotspot_mix * peak;
    const density = count / Math.max(1, area);
    return Math.max(
      0,
      Math.min(
        1,
        activity +
          options.heat_density_gain *
            Math.min(1, density / options.heat_density_reference),
      ),
    );
  }
  const THERMAL_PALETTE = [
    [0, [21, 62, 159]],
    [0.2, [29, 155, 209]],
    [0.4, [106, 199, 92]],
    [0.55, [229, 210, 87]],
    [0.72, [245, 147, 56]],
    [0.9, [238, 62, 39]],
    [1, [255, 24, 45]],
  ];
  function thermalColor(value, population = 1) {
    if (population <= 0) return "#000000";
    const v = Math.max(0, Math.min(1, value));
    let index = 1;
    while (index < THERMAL_PALETTE.length - 1 && v > THERMAL_PALETTE[index][0])
      index++;
    const [a, rgbA] = THERMAL_PALETTE[index - 1],
      [b, rgbB] = THERMAL_PALETTE[index];
    const amount = (v - a) / (b - a);
    return (
      "#" +
      rgbA
        .map((x, i) =>
          Math.round(x + (rgbB[i] - x) * amount)
            .toString(16)
            .padStart(2, "0"),
        )
        .join("")
    );
  }
  function viewportRegion(world, view, screenWidth, screenHeight, maxBins = 1500000) {
    if (!Number.isSafeInteger(maxBins) || maxBins < 1 || !Number.isFinite(view.zoom) || view.zoom <= 0)
      throw Error(T("Viewport is too large."));
    let scale = 2 ** Math.max(0, Math.ceil(Math.log2(1 / Math.max(view.zoom, 0.0000001))));
    for (;;) {
      const x = Math.max(0, Math.floor(view.x / scale) * scale);
      const y = Math.max(0, Math.floor(view.y / scale) * scale);
      const right = Math.min(world.width, Math.ceil((view.x + screenWidth / view.zoom) / scale) * scale);
      const bottom = Math.min(world.height, Math.ceil((view.y + screenHeight / view.zoom) / scale) * scale);
      const width = Math.max(0, right - x), height = Math.max(0, bottom - y);
      if (Math.ceil(width / scale) * Math.ceil(height / scale) <= maxBins)
        return { x, y, width, height, scale };
      scale *= 2;
    }
  }
  function viewportCacheKey(data) {
    return [
      data.run_id,
      data.generation,
      data.metadata_revision ?? 0,
      data.layer ?? "life",
      data.x,
      data.y,
      data.width,
      data.height,
      data.scale,
    ].join(":");
  }
  return {
    SparseGrid,
    parseRLE,
    encodeRLE,
    parseStateJSON,
    encodeStateJSON,
    aggregate,
    randomGrid,
    randomSeed,
    coordinateRandom,
    RANDOM_ALGORITHM,
    LOCAL_RANDOM_MAX_CELLS,
    randomRoute,
    transform,
    shade,
    HEAT_DEFAULTS,
    HEAT_PERIOD_REFERENCE,
    cycleActivityBase,
    thermalValue,
    thermalColor,
    viewportCacheKey,
    viewportRegion,
    popcount,
    TILE,
  };
}
const LifeCore = createLifeCore();
if (typeof window !== "undefined") window.LifeCore = LifeCore;
if (typeof module !== "undefined") module.exports = LifeCore;
