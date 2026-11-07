/* Configuration schema and exact serializers are usable in Node without a DOM. */
(function (global) {
  "use strict";
  const i18n = typeof module !== "undefined" ? require("./i18n.js") : global.LifeI18n;
  const T = (source, ...values) => i18n.t(source, ...values);
  const DEFAULTS = {
    server: { host: "127.0.0.1", port: 8765 },
    grid: { width: 4096, height: 4096, wrap: false },
    engine: {
      tile_size: "auto",
      threads: "auto",
      memory_mb: "auto",
      cache_mb: 128,
      cpu_max_percent: 90,
      cpu_min_percent: 0,
      gpu: "off",
      gpu_max_percent: 100,
      gpu_min_percent: 0,
      max_generations_per_second: 0,
      cycles_enabled: true,
      cycles_start_generation: 128,
      cycles_max_period: 16,
      cycles_memory_mb: 128,
      cycles_detection_interval: 8,
    },
    initial: { path: "", random: false, seed: "42", density: 0.15 },
    checkpoints: {
      directory: "checkpoints",
      every_generations: 1000,
      min_interval_seconds: 1800,
      mode: "coalesce",
      segment_mb: 256,
      quota_mb: 10240,
      write_mb_per_second: 32,
      disk_min_percent: 0,
      disk_max_percent: 100,
    },
    display: {
      gradient_levels: 32,
      first_level_saturation: 4,
      upper_level_saturation: 1.5,
      tile_cache_mb: 64,
      heat_stable: 0.08,
      heat_cycle_max: 0.45,
      heat_active: 0.65,
      heat_density_gain: 0.3,
      heat_density_reference: 0.15,
      heat_hotspot_mix: 0.25,
    },
  };
  const SECTIONS = [
    {
      id: "grid",
      title: "Field",
      description:
        "Dimensions and topology for the next startup. Use New field or import to replace the current field.",
    },
    {
      id: "initial",
      title: "Initial state",
      description:
        "A file takes priority over random initialization. Without either, the initial field is empty.",
    },
    {
      id: "engine",
      title: "Computation",
      description:
        "Exact B3/S23 CPU engine. Automatic settings account for available resources; this version does not support GPU computation.",
    },
    {
      id: "checkpoints",
      title: "Checkpoints",
      description:
        "Periodic checkpoints with limits on write rate, segment size, and total storage.",
    },
    {
      id: "display",
      title: "Display",
      description:
        "Initial monitor settings. Applying them here also updates this tab; saved browser settings take priority when the page opens.",
    },
    {
      id: "server",
      title: "Connection",
      description:
        "Address and port for the next startup. Remote access requires LIFE_ACCESS_TOKEN with at least 24 characters.",
    },
  ];
  const FIELDS = [
    {
      path: "grid.width",
      label: "Columns",
      type: "integer",
      min: 1,
      max: 2000000000,
      mode: "restart",
      description:
        "Width of the finite field. Empty areas use sparse storage.",
    },
    {
      path: "grid.height",
      label: "Rows",
      type: "integer",
      min: 1,
      max: 2000000000,
      mode: "restart",
      description:
        "Height of the field. Setting its size does not allocate memory for every cell immediately.",
    },
    {
      path: "grid.wrap",
      label: "Join opposite edges",
      type: "boolean",
      mode: "restart",
      description:
        "Enabled: a torus. Disabled: cells outside the field are dead. Both dimensions must be at least 3 for a torus.",
    },
    {
      path: "initial.path",
      label: "Initial-state file",
      type: "text",
      mode: "restart",
      description:
        "Path on the server to JSON, RLE, or a checkpoint manifest. The file restores its saved dimensions and topology, replacing the field settings. Leave empty to start without a file.",
    },
    {
      path: "initial.random",
      label: "Random initialization",
      type: "boolean",
      mode: "restart",
      description:
        "Applied at startup when the file path is empty. Cells outside the selected area remain dead.",
    },
    {
      path: "initial.seed",
      label: "Seed — reproducible random state",
      type: "seed",
      mode: "restart",
      description:
        "An integer from 0 to 18446744073709551615. Stored exactly, without browser rounding of large numbers.",
    },
    {
      path: "initial.density",
      label: "Live-cell probability, %",
      type: "percent",
      min: 1,
      max: 99,
      mode: "restart",
      description:
        "From 1 to 99%. Each cell is selected independently; the actual live-cell proportion may vary slightly.",
    },
    {
      path: "engine.tile_size",
      label: "Compute tile side length",
      type: "select",
      options: [
        ["auto", "Automatic"],
        [64, "64 × 64"],
        [128, "128 × 128"],
        [256, "256 × 256"],
        [512, "512 × 512"],
        [1024, "1024 × 1024"],
      ],
      mode: "restart",
      description:
        "One level of compute tiles. Automatic selection compares 64, 128, and 256; powers of two up to 1024 are available manually.",
    },
    {
      path: "engine.threads",
      label: "CPU threads",
      type: "auto",
      min: 1,
      max: 256,
      mode: "restart",
      description:
        "Automatic: the number of logical processors, up to 256. Set manually to leave some resources for other programs.",
    },
    {
      path: "engine.memory_mb",
      label: "Memory budget, MiB",
      type: "auto",
      min: 64,
      max: 1048576,
      mode: "restart",
      description:
        "Automatic: half of available RAM, within 128–4096 MiB. Some is reserved for Python and requests. This is a budget with RSS monitoring, not an OS-enforced limit.",
    },
    {
      path: "engine.cache_mb",
      label: "Computation cache, MiB",
      type: "integer",
      min: 0,
      max: 1048576,
      mode: "restart",
      description:
        "Zero disables the cache. Its effective size is also capped at one quarter of the native engine's memory budget.",
    },
    {
      path: "engine.cpu_min_percent",
      label: "Minimum CPU usage, %",
      type: "number",
      min: 0,
      max: 100,
      mode: "advisory",
      description:
        "A saved target. The engine does not create unnecessary work to reach this minimum artificially.",
    },
    {
      path: "engine.cpu_max_percent",
      label: "Maximum CPU usage, %",
      type: "number",
      min: 0,
      max: 100,
      mode: "live",
      description:
        "Must be greater than zero. Average usage is controlled by pausing after a complete generation; momentary peaks may be higher.",
    },
    {
      path: "engine.max_generations_per_second",
      label: "Maximum generations per second",
      type: "number",
      min: 0,
      max: 1000000,
      mode: "live",
      description:
        "Zero means unlimited speed. Changing the pace does not change simulation rules or states.",
    },
    {
      path: "engine.gpu",
      label: "GPU mode",
      type: "select",
      options: [["off", "Off — CPU only"]],
      mode: "advisory",
      description:
        "This version has no GPU engine. It cannot be enabled; this setting is reserved for future support.",
    },
    {
      path: "engine.gpu_min_percent",
      label: "Minimum GPU usage, %",
      type: "number",
      min: 0,
      max: 100,
      mode: "advisory",
      description:
        "A reserved setting. It has no effect while GPU computation is disabled.",
    },
    {
      path: "engine.gpu_max_percent",
      label: "Maximum GPU usage, %",
      type: "number",
      min: 0,
      max: 100,
      mode: "advisory",
      description:
        "A reserved setting; must be greater than zero and no lower than the minimum. Not applied in this version.",
    },
    {
      path: "checkpoints.directory",
      label: "Checkpoint directory",
      type: "text",
      mode: "live",
      description:
        "A nonempty path on the server. Relative paths are resolved from the project directory.",
    },
    {
      path: "checkpoints.every_generations",
      label: "Save every N generations",
      type: "integer",
      min: 1,
      max: 1000000000000000,
      mode: "live",
      description:
        "Target spacing between checkpoints. The minimum time interval also applies.",
    },
    {
      path: "checkpoints.min_interval_seconds",
      label: "Minimum write interval, seconds",
      type: "number",
      min: 0,
      mode: "live",
      description:
        "1800 seconds = 30 minutes. Prevents excessive file creation even when generations advance quickly.",
    },
    {
      path: "checkpoints.mode",
      label: "Checkpoint mode",
      type: "select",
      options: [
        ["coalesce", "Latest current state"],
        ["strict", "Every target checkpoint, with waiting"],
      ],
      mode: "live",
      description:
        "Latest state: both N generations and the time interval must elapse. Strict mode: the simulation waits at the target generation until writing is allowed.",
    },
    {
      path: "checkpoints.segment_mb",
      label: "Maximum file segment, MiB",
      type: "integer",
      min: 1,
      max: 256,
      mode: "live",
      description:
        "Large states are split into compressed segments no larger than this size. Available range: 1–256 MiB.",
    },
    {
      path: "checkpoints.quota_mb",
      label: "Total directory quota, MiB",
      type: "integer",
      min: 1,
      max: 1000000000,
      mode: "live",
      description:
        "At least one segment. Must hold both old and new snapshots for safe replacement; verified old checkpoints are removed to stay within the quota.",
    },
    {
      path: "checkpoints.write_mb_per_second",
      label: "Write rate, MiB/s",
      type: "number",
      min: 0,
      mode: "live",
      description:
        "A positive value. Limits actual write throughput; short, small bursts are possible.",
    },
    {
      path: "checkpoints.disk_min_percent",
      label: "Minimum disk usage, %",
      type: "number",
      min: 0,
      max: 100,
      mode: "advisory",
      description:
        "A saved target without forced disk activity. The interval, quota, and MiB/s rate are the effective controls.",
    },
    {
      path: "checkpoints.disk_max_percent",
      label: "Maximum disk usage, %",
      type: "number",
      min: 0,
      max: 100,
      mode: "advisory",
      description:
        "A saved target, not a device utilization limit. Use MiB/s to limit writes.",
    },
    {
      path: "display.gradient_levels",
      label: "Grayscale levels",
      type: "integer",
      min: 2,
      max: 256,
      mode: "live",
      description:
        "Number of shades when zoomed out. At cell level, live cells remain white and dead cells black.",
    },
    {
      path: "display.first_level_saturation",
      label: "First-level saturation",
      type: "number",
      min: 0,
      max: 1000,
      mode: "live",
      description:
        "Boosts visibility of nonempty blocks up to 64 × 64 cells. Affects the image only.",
    },
    {
      path: "display.upper_level_saturation",
      label: "Upper-level saturation",
      type: "number",
      min: 0,
      max: 1000,
      mode: "live",
      description:
        "A visibility boost for larger blocks when zoomed out. Calculations always use exact live-cell counts.",
    },
    {
      path: "display.tile_cache_mb",
      label: "Monitor cache, MiB",
      type: "integer",
      min: 1,
      max: 1024,
      mode: "live",
      description:
        "Browser cache budget for neighboring regions. The current frame and the browser's own memory are not included.",
    },
    {
      path: "server.host",
      label: "Listen address",
      type: "text",
      mode: "restart",
      description:
        "127.0.0.1: this computer only. 0.0.0.0: all network interfaces; requires an access token in the server environment.",
    },
    {
      path: "server.port",
      label: "Port",
      type: "integer",
      min: 1,
      max: 65535,
      mode: "restart",
      description: "Local web server port. The default is 8765.",
    },
  ];
  FIELDS.push(
    {
      path: "engine.cycles_enabled",
      label: "Cycle detection and replay",
      type: "boolean",
      mode: "live",
      description:
        "Enables an auxiliary search for exact repetitions. The tile state and external neighbor border are checked before every saved-phase replay; a border change resumes normal computation.",
    },
    {
      path: "engine.cycles_start_generation",
      label: "Start detection at generation",
      type: "integer",
      min: 0,
      max: 1000000000000000,
      mode: "live",
      description:
        "Before this generation, detection does not spend resources on initial chaos. An unknown period on the heatmap does not prove that no cycle exists.",
    },
    {
      path: "engine.cycles_max_period",
      label: "Maximum cycle period to detect",
      type: "integer",
      min: 1,
      max: 64,
      mode: "live",
      description:
        "From 1 to 64 generations. Longer cycles need more history. Set 1 to detect stable states only. The heatmap scale always uses period 64 as its reference.",
    },
    {
      path: "engine.cycles_memory_mb",
      label: "Cycle detection memory, MiB",
      type: "integer",
      min: 0,
      max: 1048576,
      mode: "live",
      description:
        "Budget for candidates, phases, and border guards. Zero disables storage. The effective budget may be lower because of the engine's total available memory.",
    },
    {
      path: "engine.cycles_detection_interval",
      label: "New detection interval, generations",
      type: "integer",
      min: 1,
      max: 65535,
      mode: "live",
      description:
        "How often to start checking new candidates. Already confirmed phases and their borders are checked before every replay regardless of this interval.",
    },
    {
      path: "display.heat_stable",
      label: "Stable-state temperature",
      type: "number",
      min: 0,
      max: 1,
      mode: "live",
      description:
        "Base value for a confirmed period of 1. Must be below the maximum cycle temperature. Empty blocks are always black.",
    },
    {
      path: "display.heat_cycle_max",
      label: "Period-64 cycle temperature",
      type: "number",
      min: 0,
      max: 1,
      mode: "live",
      description:
        "Upper base temperature for known cycles. Periods 1 through 64 use log₂(period), without rescaling each frame.",
    },
    {
      path: "display.heat_active",
      label: "Unknown / active-state temperature",
      type: "number",
      min: 0,
      max: 1,
      mode: "live",
      description:
        "Base value when the current border guard does not confirm a period. Higher than all known cycles at the same density; this does not prove chaotic behavior.",
    },
    {
      path: "display.heat_density_gain",
      label: "Additional temperature from density",
      type: "number",
      min: 0,
      max: 1,
      mode: "live",
      description:
        "Increases with density for cyclic and unknown regions. Its sum with the active-state temperature cannot exceed 1.",
    },
    {
      path: "display.heat_density_reference",
      label: "Reference live-cell density",
      type: "number",
      min: 0,
      max: 1,
      mode: "live",
      description:
        "A fraction greater than 0 and at most 1; 0.15 = 15%. The added temperature reaches its maximum at this density. The value is fixed across frames.",
    },
    {
      path: "display.heat_hotspot_mix",
      label: "Hottest-fragment weight",
      type: "number",
      min: 0,
      max: 1,
      mode: "live",
      description:
        "0: average activity weighted by live cells; 1: the maximum. The default 0.25 helps retain small active regions when zoomed out.",
    },
  );
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const get = (object, path) =>
    path.split(".").reduce((v, k) => v?.[k], object);
  function set(object, path, value) {
    const [section, key] = path.split(".");
    object[section] ||= {};
    object[section][key] = value;
  }
  function seedString(value) {
    if (typeof value === "number" && !Number.isSafeInteger(value))
      throw Error(T("Seed was supplied as an imprecise number. Use a decimal string."));
    const s = String(value);
    if (!/^\d+$/.test(s) || BigInt(s) > 18446744073709551615n)
      throw Error(T("Seed must be an integer from 0 to 18446744073709551615."));
    return BigInt(s).toString();
  }
  function normalizeConfig(input = {}) {
    const out = clone(DEFAULTS);
    for (const section of Object.keys(DEFAULTS))
      if (input[section]) Object.assign(out[section], clone(input[section]));
    out.initial.seed = seedString(out.initial.seed);
    if (out.initial.rectangle === null) delete out.initial.rectangle;
    return out;
  }
  function parseConfigJSON(text) {
    let out = "",
      i = 0;
    while (i < text.length) {
      if (text[i] === '"') {
        let j = i + 1;
        while (j < text.length) {
          if (text[j] === "\\") {
            j += 2;
            continue;
          }
          if (text[j++] === '"') break;
        }
        out += text.slice(i, j);
        i = j;
      } else if (text[i] === "-" || /\d/.test(text[i])) {
        const m = text.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
        if (!m) {
          out += text[i++];
          continue;
        }
        const token = m[0];
        out +=
          /^-?\d+$/.test(token) &&
          (BigInt(token) > BigInt(Number.MAX_SAFE_INTEGER) ||
            BigInt(token) < BigInt(Number.MIN_SAFE_INTEGER))
            ? JSON.stringify(token)
            : token;
        i += token.length;
      } else out += text[i++];
    }
    return JSON.parse(out);
  }
  function coordinate(text) {
    const m = String(text).match(/^([1-9][0-9]{0,9})\.([1-9][0-9]{0,9})$/);
    if (!m) return null;
    const x = Number(m[1]),
      y = Number(m[2]);
    return Number.isSafeInteger(x) && Number.isSafeInteger(y) ? { x, y } : null;
  }
  function validateConfig(config) {
    const errors = [],
      add = (path, message) => errors.push({ path, message: T(message) });
    for (const f of FIELDS) {
      const v = get(config, f.path);
      if (f.type === "seed") {
        try {
          seedString(v);
        } catch (e) {
          add(f.path, e.message);
        }
        continue;
      }
      if (f.type === "text") {
        if (typeof v !== "string") add(f.path, "Text is required.");
        if (
          ["server.host", "checkpoints.directory"].includes(f.path) &&
          !String(v || "").trim()
        )
          add(f.path, "The value cannot be empty.");
        continue;
      }
      if (f.type === "boolean") {
        if (typeof v !== "boolean")
          add(f.path, "Select Enabled or Disabled.");
        continue;
      }
      if (f.type === "select") {
        if (!f.options.some(([value]) => value === v))
          add(f.path, "Select one of the available values.");
        continue;
      }
      if (f.type === "auto" && v === "auto") continue;
      const value = f.type === "percent" ? v * 100 : v;
      if (
        typeof v !== "number" ||
        !Number.isFinite(v) ||
        ((f.type === "integer" || f.type === "auto") &&
          !Number.isSafeInteger(v))
      ) {
        add(
          f.path,
          ["integer", "auto"].includes(f.type)
            ? "A finite integer is required."
            : "A finite number is required.",
        );
        continue;
      }
      if (
        (f.min !== undefined && value < f.min) ||
        (f.max !== undefined && value > f.max)
      )
        add(
          f.path,
          T("Allowed range: {0}–{1}.", f.min, f.max ?? T("no upper limit")),
        );
    }
    if (config.grid?.wrap && (config.grid.width < 3 || config.grid.height < 3))
      add("grid.wrap", "A torus requires a field of at least 3 × 3.");
    for (const prefix of ["cpu", "gpu"]) {
      const min = config.engine?.[prefix + "_min_percent"],
        max = config.engine?.[prefix + "_max_percent"];
      if (min > max || max <= 0)
        add(
          "engine." + prefix + "_max_percent",
          "The maximum must be greater than zero and no lower than the minimum.",
        );
    }
    if (
      config.checkpoints?.disk_min_percent >
      config.checkpoints?.disk_max_percent
    )
      add(
        "checkpoints.disk_max_percent",
        "The maximum cannot be lower than the minimum.",
      );
    if (config.checkpoints?.quota_mb < config.checkpoints?.segment_mb)
      add("checkpoints.quota_mb", "The quota cannot be smaller than one segment.");
    if (config.checkpoints?.write_mb_per_second <= 0)
      add(
        "checkpoints.write_mb_per_second",
        "The write rate must be greater than zero.",
      );
    const heat = config.display;
    if (
      heat &&
      !(
        0 <= heat.heat_stable &&
        heat.heat_stable < heat.heat_cycle_max &&
        heat.heat_cycle_max < heat.heat_active &&
        heat.heat_active <= 1
      )
    )
      add(
        "display.heat_active",
        "Required order: stable < cycle < active, within 0–1.",
      );
    if (
      heat &&
      (!(heat.heat_density_reference > 0) || heat.heat_density_reference > 1)
    )
      add(
        "display.heat_density_reference",
        "Reference density must be greater than zero and no greater than 1.",
      );
    if (heat && heat.heat_active + heat.heat_density_gain > 1 + 1e-12)
      add(
        "display.heat_density_gain",
        "The active-state temperature plus the density addition cannot exceed 1.",
      );
    const r = config.initial?.rectangle;
    if (r) {
      const a = coordinate(r.top_left),
        b = coordinate(r.bottom_right);
      if (
        !a ||
        !b ||
        a.x < 1 ||
        a.y < 1 ||
        b.x < a.x ||
        b.y < a.y ||
        b.x > config.grid.width ||
        b.y > config.grid.height
      )
        add(
          "initial.rectangle",
          "The rectangle must be inside the field; x.y coordinates start at 1.",
        );
    }
    return errors;
  }
  function buildChangePlan(baseline, draft) {
    const before = normalizeConfig(baseline),
      after = normalizeConfig(draft),
      changes = [],
      livePatch = {},
      liveChanges = [],
      restartChanges = [];
    for (const f of [
      ...FIELDS,
      {
        path: "initial.rectangle",
        label: "Randomization area",
        mode: "restart",
      },
    ]) {
      const a = get(before, f.path),
        b = get(after, f.path);
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
      const change = {
        path: f.path,
        label: T(f.label),
        before: a,
        after: b,
        mode: f.mode,
      };
      changes.push(change);
      if (f.mode === "restart") restartChanges.push(change);
      else {
        liveChanges.push(change);
        set(livePatch, f.path, b);
      }
    }
    return { changes, livePatch, liveChanges, restartChanges };
  }
  function mergeConfigDraft(baseline, draft, server) {
    const before = normalizeConfig(baseline),
      next = normalizeConfig(server),
      merged = clone(next);
    for (const field of [...FIELDS, { path: "initial.rectangle" }]) {
      const desired = get(draft, field.path);
      if (JSON.stringify(get(before, field.path)) !== JSON.stringify(desired)) {
        if (field.path === "initial.rectangle" && desired === undefined)
          delete merged.initial.rectangle;
        else set(merged, field.path, desired);
      }
    }
    return merged;
  }
  function toTOML(input) {
    const config = normalizeConfig(input),
      errors = validateConfig(config);
    if (errors.length)
      throw Error(errors.map((e) => e.path + ": " + e.message).join("\n"));
    const lines = [
      "# LIFE ENGINE — complete startup configuration",
      "# Save this file and run: python -m life --config config.toml",
      "",
    ];
    for (const section of Object.keys(DEFAULTS)) {
      lines.push("[" + section + "]");
      for (const key of Object.keys(DEFAULTS[section])) {
        const value = config[section][key];
        lines.push(
          key +
            " = " +
            (key === "seed" && section === "initial"
              ? JSON.stringify(seedString(value))
              : typeof value === "string"
                ? JSON.stringify(value)
                : String(value)),
        );
      }
      lines.push("");
      if (section === "initial" && config.initial.rectangle) {
        lines.push(
          "[initial.rectangle]",
          "top_left = " + JSON.stringify(config.initial.rectangle.top_left),
          "bottom_right = " +
            JSON.stringify(config.initial.rectangle.bottom_right),
          "",
        );
      }
    }
    return lines.join("\n");
  }
  function createEditor(container, { onChange } = {}) {
    if (typeof document === "undefined")
      throw Error(T("The editor requires a DOM."));
    let baseline = normalizeConfig(),
      controls = new Map(),
      validationVisible = false;
    const translations = [];
    function bindText(element, source) {
      const update = () => { element.textContent = T(source); };
      translations.push(update);
      update();
    }
    function bindAttribute(element, attribute, source) {
      const update = () => { element.setAttribute(attribute, T(source)); };
      translations.push(update);
      update();
    }
    container.replaceChildren();
    const nav = document.createElement("nav");
    nav.className = "config-section-nav";
    bindAttribute(nav, "aria-label", "Settings sections");
    container.append(nav);
    for (const section of SECTIONS) {
      const button = document.createElement("button");
      button.type = "button";
      bindText(button, section.title);
      button.onclick = () =>
        container
          .querySelector("#cfg-section-" + section.id)
          .scrollIntoView({ behavior: "smooth", block: "start" });
      nav.append(button);
      const group = document.createElement("section");
      group.id = "cfg-section-" + section.id;
      group.className = "config-section";
      const h = document.createElement("h3");
      bindText(h, section.title);
      const p = document.createElement("p");
      p.className = "config-section-description";
      bindText(p, section.description);
      const grid = document.createElement("div");
      grid.className = "config-fields";
      group.append(h, p, grid);
      container.append(group);
      for (const field of FIELDS.filter((f) =>
        f.path.startsWith(section.id + "."),
      )) {
        const wrapper = document.createElement("div");
        wrapper.className = "config-field";
        const title = document.createElement("div");
        title.className = "config-field-title";
        const label = document.createElement("label");
        label.htmlFor = "cfg-" + field.path;
        bindText(label, field.label);
        const badge = document.createElement("span");
        badge.className = "config-badge " + field.mode;
        bindText(badge,
          field.mode === "restart"
            ? "Restart"
            : field.mode === "advisory"
              ? "Target / reserved"
              : "Live");
        title.append(label, badge);
        let input, auto;
        if (field.type === "select" || field.type === "boolean") {
          input = document.createElement("select");
          const opts =
            field.type === "boolean"
              ? [
                  [false, "Disabled"],
                  [true, "Enabled"],
                ]
              : field.options;
          for (const [value, text] of opts) {
            const option = document.createElement("option");
            option.value = String(value);
            bindText(option, text);
            input.append(option);
          }
        } else {
          input = document.createElement("input");
          input.type = ["text", "seed"].includes(field.type)
            ? "text"
            : "number";
          if (field.type === "seed") {
            input.inputMode = "numeric";
            input.pattern = "[0-9]+";
            input.autocomplete = "off";
          } else if (input.type === "number") {
            input.min = field.min ?? "";
            input.max = field.max ?? "";
            input.step =
              field.type === "integer" || field.type === "auto" ? "1" : "any";
          }
          if (field.type === "auto") {
            auto = document.createElement("select");
            const updateModeLabel = () => auto.setAttribute("aria-label", T("{0} — mode", T(field.label)));
            translations.push(updateModeLabel);
            updateModeLabel();
            for (const [value, text] of [
              ["auto", "Automatic"],
              ["manual", "Manual"],
            ]) {
              const option = document.createElement("option");
              option.value = value;
              bindText(option, text);
              auto.append(option);
            }
            auto.onchange = () => {
              input.disabled = auto.value === "auto";
              if (!input.value) input.value = field.min;
              changed();
            };
          }
        }
        input.id = "cfg-" + field.path;
        input.dataset.configPath = field.path;
        const description = document.createElement("p");
        description.id = "cfg-help-" + field.path;
        description.className = "field-help";
        bindText(description, field.description);
        input.setAttribute("aria-describedby", description.id);
        const control = document.createElement("div");
        control.className = auto ? "auto-control" : "config-control";
        if (auto) control.append(auto);
        control.append(input);
        const error = document.createElement("span");
        error.className = "field-error";
        error.id = "cfg-error-" + field.path;
        error.setAttribute("role", "status");
        wrapper.append(title, control, description, error);
        grid.append(wrapper);
        controls.set(field.path, { field, input, auto, error });
        input.addEventListener("input", changed);
        input.addEventListener("change", changed);
      }
      if (section.id === "initial") {
        const block = document.createElement("div");
        block.className = "config-rectangle";
        block.innerHTML =
          '<label class="check-row"><input id="cfg-rectangle-enabled" type="checkbox" aria-describedby="cfg-rectangle-help"><span><span id="cfg-rectangle-label"></span> <span id="cfg-rectangle-badge" class="config-badge restart"></span></span></label><p class="field-help" id="cfg-rectangle-help"></p><div class="config-fields"><label><span id="cfg-rectangle-from-label"></span><input id="cfg-rectangle-from" type="text" inputmode="decimal" placeholder="1.1" aria-describedby="cfg-rectangle-from-help"><small id="cfg-rectangle-from-help" class="field-help"></small></label><label><span id="cfg-rectangle-to-label"></span><input id="cfg-rectangle-to" type="text" inputmode="decimal" placeholder="4096.4096" aria-describedby="cfg-rectangle-to-help"><small id="cfg-rectangle-to-help" class="field-help"></small></label></div><span class="field-error" id="cfg-rectangle-error" role="status"></span>';
        for (const [id, source] of [
          ["label", "Rectangular area only"],
          ["badge", "Restart"],
          ["help", "Without a restriction, the entire field is used. Corners are inclusive; column.row coordinates start at 1, for example 1666.1888."],
          ["from-label", "Top-left corner"],
          ["from-help", "First cell of the area: column.row, inclusive."],
          ["to-label", "Bottom-right corner"],
          ["to-help", "Last cell of the area, inclusive. Must not be above or to the left of the first cell."],
        ]) bindText(block.querySelector("#cfg-rectangle-" + id), source);
        group.append(block);
        for (const input of block.querySelectorAll("input"))
          input.addEventListener("input", () => {
            syncRectangle();
            changed();
          });
      }
    }
    function syncRectangle() {
      const checked = container.querySelector("#cfg-rectangle-enabled").checked;
      container.querySelector("#cfg-rectangle-from").disabled = !checked;
      container.querySelector("#cfg-rectangle-to").disabled = !checked;
    }
    function changed() {
      if (onChange) onChange();
    }
    function load(input, { rebase = true } = {}) {
      const config = normalizeConfig(input);
      validationVisible = false;
      if (rebase) baseline = clone(config);
      for (const { field, input, auto, error } of controls.values()) {
        const value = get(config, field.path);
        error.textContent = "";
        input.removeAttribute("aria-invalid");
        if (auto) {
          auto.value = value === "auto" ? "auto" : "manual";
          input.disabled = value === "auto";
          input.value = value === "auto" ? "" : value;
          input.placeholder =
            value === "auto" ? T("Automatic selection") : String(field.min);
        } else
          input.value = field.type === "percent" ? value * 100 : String(value);
      }
      const rectangle = config.initial.rectangle;
      container.querySelector("#cfg-rectangle-enabled").checked = !!rectangle;
      container.querySelector("#cfg-rectangle-from").value =
        rectangle?.top_left || "1.1";
      container.querySelector("#cfg-rectangle-to").value =
        rectangle?.bottom_right || config.grid.width + "." + config.grid.height;
      container.querySelector("#cfg-rectangle-error").textContent = "";
      syncRectangle();
      changed();
    }
    function read() {
      const config = clone(DEFAULTS);
      for (const { field, input, auto } of controls.values()) {
        let value = field.type === "seed" ? input.value.trim() : input.value;
        if (auto?.value === "auto") value = "auto";
        else if (field.type === "boolean") value = value === "true";
        else if (field.type === "select") {
          const option = field.options.find(([v]) => String(v) === value);
          value = option ? option[0] : value;
        } else if (!["text", "seed"].includes(field.type)) {
          value = value.trim() === "" ? NaN : Number(value);
          if (field.type === "percent") value /= 100;
        }
        set(config, field.path, value);
      }
      if (container.querySelector("#cfg-rectangle-enabled").checked)
        config.initial.rectangle = {
          top_left: container.querySelector("#cfg-rectangle-from").value.trim(),
          bottom_right: container
            .querySelector("#cfg-rectangle-to")
            .value.trim(),
        };
      return config;
    }
    function validate({ focus = false } = {}) {
      validationVisible = true;
      const config = read(),
        errors = validateConfig(config);
      for (const { input, error } of controls.values()) {
        input.removeAttribute("aria-invalid");
        error.textContent = "";
      }
      container.querySelector("#cfg-rectangle-error").textContent = "";
      for (const e of errors) {
        if (e.path === "initial.rectangle") {
          container.querySelector("#cfg-rectangle-error").textContent =
            e.message;
          continue;
        }
        const c = controls.get(e.path);
        if (c) {
          c.input.setAttribute("aria-invalid", "true");
          c.error.textContent = e.message;
        }
      }
      if (focus && errors.length) {
        const input =
          controls.get(errors[0].path)?.input ||
          container.querySelector("#cfg-rectangle-from");
        input.focus();
      }
      return { config, errors };
    }
    function plan() {
      return buildChangePlan(baseline, read());
    }
    function rebase(config) {
      const merged = mergeConfigDraft(baseline, read(), config);
      baseline = normalizeConfig(config);
      load(merged, { rebase: false });
    }
    function refreshLocale() {
      // Reuse existing controls: raw drafts, selection, focus, and undo history survive.
      for (const update of translations) update();
      for (const { field, input, auto } of controls.values()) {
        if (auto) input.placeholder = auto.value === "auto" ? T("Automatic selection") : String(field.min);
      }
      if (validationVisible) validate();
    }
    load(DEFAULTS);
    return {
      load,
      read,
      validate,
      plan,
      rebase,
      refreshLocale,
      get baseline() {
        return clone(baseline);
      },
    };
  }
  const API = {
    DEFAULTS,
    FIELDS,
    SECTIONS,
    normalizeConfig,
    validateConfig,
    parseConfigJSON,
    toTOML,
    buildChangePlan,
    mergeConfigDraft,
    createEditor,
  };
  if (typeof module !== "undefined") module.exports = API;
  global.LifeConfig = API;
})(typeof window === "undefined" ? globalThis : window);
