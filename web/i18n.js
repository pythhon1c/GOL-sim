/* Offline localization. Changing language never changes the simulation or draft. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.LifeI18n = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";
  const languages = Object.freeze(["en", "ru", "uk"]);
  const locales = { en: "en-US", ru: "ru-RU", uk: "uk-UA" };
  const node = typeof module === "object" && module.exports;
  const ui = node ? require("./ui-locales.js") : root.LIFE_UI_LOCALES || {};
  const config = node
    ? require("./config-locales.js")
    : root.LIFE_CONFIG_LOCALES || {};
  const catalog = node
    ? require("./catalog-locales.js")
    : root.LIFE_CATALOG_LOCALES || {};
  const messages = Object.assign({}, ui, config);
  let language = "en";
  try {
    const saved = root.localStorage?.getItem("life-language");
    if (languages.includes(saved)) language = saved;
  } catch {}

  // This pure translator is also serialized into the editor's Blob worker.
  function translate(table, lang, source, values) {
    let key = source;
    if (
      Array.isArray(source) &&
      Object.prototype.hasOwnProperty.call(source, "raw")
    )
      key = source.reduce(
        (text, part, i) => text + (i ? "{" + (i - 1) + "}" : "") + part,
        "",
      );
    const entry = table[key];
    const text = lang === "uk" || !entry ? key : entry[lang === "ru" ? 1 : 0];
    return String(text).replace(/\{(\d+)\}/g, (token, index) =>
      index < values.length ? String(values[index]) : token,
    );
  }
  function t(source, ...values) {
    return translate(messages, language, source, values);
  }
  function getLanguage() {
    return language;
  }
  function locale() {
    return locales[language];
  }
  function formatNumber(value, options) {
    return new Intl.NumberFormat(locale(), options).format(value);
  }
  function formatDate(value, options) {
    return new Intl.DateTimeFormat(locale(), options).format(new Date(value));
  }
  const bindings = [];
  let boundDocument = null;
  function bindDocument(document) {
    if (!document || boundDocument === document) return;
    boundDocument = document;
    for (const element of document.querySelectorAll("[data-i18n-text]")) {
      for (const [index, source] of JSON.parse(
        element.getAttribute("data-i18n-text"),
      )) {
        const text = element.childNodes[index];
        if (text?.nodeType !== 3) continue;
        const prefix = text.nodeValue.match(/^\s*/)[0],
          suffix = text.nodeValue.match(/\s*$/)[0];
        bindings.push({ text, source, prefix, suffix });
      }
    }
    applyDocument(document);
  }
  function applyDocument(document = boundDocument) {
    if (!document) return;
    document.documentElement.lang = language;
    for (const item of bindings) {
      if (item.text.isConnected)
        item.text.nodeValue = item.prefix + t(item.source) + item.suffix;
    }
    for (const attribute of ["title", "aria-label", "placeholder"]) {
      for (const element of document.querySelectorAll(
        "[data-i18n-" + attribute + "]",
      ))
        element.setAttribute(
          attribute,
          t(element.getAttribute("data-i18n-" + attribute)),
        );
    }
    const selector = document.getElementById("languageSelect");
    if (selector) selector.value = language;
  }
  function setLanguage(next, options = {}) {
    if (!languages.includes(next))
      throw new RangeError("Unsupported language: " + next);
    if (language === next) return language;
    language = next;
    if (options.persist !== false) {
      try {
        root.localStorage?.setItem("life-language", next);
      } catch {}
    }
    applyDocument();
    if (root.dispatchEvent && typeof root.CustomEvent === "function")
      root.dispatchEvent(
        new root.CustomEvent("life:languagechange", { detail: { language } }),
      );
    return language;
  }
  function pattern(source) {
    if (!source) return source;
    const entry = catalog[language]?.patterns?.[source.id] || {};
    const localized = { ...source, ...entry, type: category(source.type) };
    if (source.demo)
      localized.demo = {
        ...source.demo,
        observation: entry.demoObservation || source.demo.observation,
      };
    return localized;
  }
  function category(value) {
    return catalog[language]?.categories?.[value] || value;
  }
  function searchText(source) {
    const texts = [
      source.name,
      source.type,
      source.note,
      source.search,
      source.description,
    ];
    for (const lang of languages) {
      texts.push(catalog[lang]?.categories?.[source.type]);
      const entry = catalog[lang]?.patterns?.[source.id];
      if (entry)
        texts.push(entry.name, entry.note, entry.description, entry.search);
    }
    return texts.filter(Boolean).join(" ").toLocaleLowerCase(locale());
  }
  function workerSource() {
    return (
      "self.LifeI18n={t:function(source,...values){return (" +
      translate.toString() +
      ")(" +
      JSON.stringify(messages) +
      "," +
      JSON.stringify(language) +
      ",source,values);}};"
    );
  }
  return {
    t,
    getLanguage,
    setLanguage,
    locale,
    formatNumber,
    formatDate,
    bindDocument,
    applyDocument,
    pattern,
    category,
    searchText,
    workerSource,
    languages,
    messages,
  };
});
