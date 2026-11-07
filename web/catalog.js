/* Placement and lazy loading for the built-in B3/S23 pattern library. */
(function (root, factory) {
  const catalog = factory();
  if (typeof module === "object" && module.exports) module.exports = catalog;
  else root.LifeCatalog = catalog;
})(typeof window === "undefined" ? globalThis : window, function () {
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
  const loads = new Map();

  async function getRLE(pattern) {
    if (typeof pattern.rle === "string") return pattern.rle;
    const id = pattern.asset;
    if (id === "clock") {
      if (typeof window.LIFE_CLOCK_RLE !== "string")
        throw Error(T("Не знайдено даних цифрового годинника."));
      return window.LIFE_CLOCK_RLE;
    }
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id || ""))
      throw Error(T("Некоректний запис у бібліотеці фігур."));
    const read = () => window.LIFE_PATTERN_ASSETS?.[id];
    if (typeof read() === "string") return read();
    if (!loads.has(id)) {
      // Local classic scripts work over both HTTP and file://. The initial
      // page and the catalog grid never load or parse unselected RLE files.
      const pending = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = `patterns/${id}.js`;
        script.onload = () => {
          script.remove();
          if (typeof read() === "string") resolve(read());
          else
            reject(
              Error(T("Файл пристрою не містить очікуваної фігури: ") + id),
            );
        };
        script.onerror = () => {
          script.remove();
          reject(Error(T("Не вдалося завантажити фігуру: ") + id));
        };
        document.head.append(script);
      });
      loads.set(id, pending);
      pending.catch(() => loads.delete(id));
    }
    return loads.get(id);
  }

  function monitorPlacement(pattern, rle, world) {
    const header =
      /^\s*x\s*=\s*(\d+)\s*,\s*y\s*=\s*(\d+)(?:\s*,\s*rule\s*=\s*(B3\/S23|23\/3))?[^\S\r\n]*$/im.exec(
        rle,
      );
    if (!header) throw Error(T("Бібліотечна фігура не має заголовка B3/S23."));
    const width = Number(header[1]),
      height = Number(header[2]);
    if (pattern.preserveBoard) {
      // Keep the authored finite board, the gates' absolute readouts and the
      // devices' dead margins (including space for the pi printer).
      const meta = /^#C LIFE ([^\r\n]*)/m.exec(rle)?.[1] || "";
      const value = (name) =>
        Number(new RegExp(`(?:^| )${name}=(\\d+)(?: |$)`).exec(meta)?.[1] || 0);
      return {
        text: rle,
        x: value("origin_x"),
        y: value("origin_y"),
        width,
        height,
      };
    }
    const fieldW = Math.max(world.width, width + 128),
      fieldH = Math.max(world.height, height + 128);
    const x = Math.floor((fieldW - width) / 2),
      y = Math.floor((fieldH - height) / 2);
    const meta = `#C LIFE width=${fieldW} height=${fieldH} origin_x=${x} origin_y=${y} wrap=${world.wrap ? 1 : 0} generation=0\n`;
    return {
      text: meta + rle.replace(/^#C LIFE [^\r\n]*(?:\r?\n|$)/gm, ""),
      x,
      y,
      width,
      height,
    };
  }

  function caseOf(pattern, index = 0) {
    return pattern.variants
      ? { ...pattern, ...pattern.variants[index], variants: undefined }
      : pattern;
  }
  function readoutDescription(verification) {
    if (!verification?.output_roi) return "";
    const { x, y, width, height } = verification.output_roi;
    return (
      T`Покоління ${verification.generation}. Вихід: ${x + 1}.${y + 1}–${x + width}.${y + height}. ` +
      T`Для вибраних входів очікується ${verification.expected_output} (${verification.expected_population} живих клітин у вікні).`
    );
  }
  return { getRLE, monitorPlacement, caseOf, readoutDescription };
});
