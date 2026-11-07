const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const I = require("../web/i18n.js");
const C = require("../web/core.js");
const catalogLocales = require("../web/catalog-locales.js");
const read = (name) =>
  fs.readFileSync(path.join(__dirname, "../web", name), "utf8");

function browser(saved) {
  const writes = [],
    events = [];
  const context = {
    LIFE_UI_LOCALES: require("../web/ui-locales.js"),
    LIFE_CONFIG_LOCALES: require("../web/config-locales.js"),
    LIFE_CATALOG_LOCALES: catalogLocales,
    navigator: { language: "ru-RU" },
    localStorage: {
      getItem: () => saved,
      setItem: (...args) => writes.push(args),
    },
    CustomEvent: class {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    dispatchEvent: (event) => events.push(event),
  };
  vm.createContext(context);
  vm.runInContext(read("i18n.js"), context);
  return { I: context.LifeI18n, context, writes, events };
}

test("English is the explicit default; a validated saved language survives offline startup", () => {
  assert.equal(browser().I.getLanguage(), "en");
  assert.equal(browser("invalid").I.getLanguage(), "en");
  assert.equal(browser("ru").I.getLanguage(), "ru");
  const b = browser();
  b.I.setLanguage("uk");
  assert.deepEqual(b.writes, [["life-language", "uk"]]);
  assert.equal(b.events[0].type, "life:languagechange");
  assert.equal(b.events[0].detail.language, "uk");
  b.I.setLanguage("uk");
  assert.equal(b.events.length, 1);
  assert.throws(() => b.I.setLanguage("de"), /Unsupported language/);
});

test("all UI/config translations retain their placeholders and contain actual translated text", () => {
  const placeholders = (s) =>
    [...s.matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();
  for (const [source, translations] of Object.entries(I.messages)) {
    assert.doesNotMatch(source, /\p{Script=Cyrillic}/u);
    assert.deepEqual(Object.keys(translations).sort(), ["ru", "uk"]);
    for (const [language, text] of Object.entries(translations)) {
      assert.equal(typeof text, "string", source);
      assert(text.trim(), source);
      assert.deepEqual(placeholders(text), placeholders(source), source);
      if (language === "ru") assert.doesNotMatch(text, /[\u0404\u0406\u0407\u0454\u0456\u0457\u0490\u0491]/u);
    }
  }
});

test("ordinary and tagged interpolation use the same locale without changing coordinates", () => {
  for (const lang of I.languages) {
    I.setLanguage(lang, { persist: false });
    assert.equal(
      I.t("Generation {0}. {1}", 128, "42.17"),
      I.t`Generation ${128}. ${"42.17"}`,
    );
    assert.match(I.t`Generation ${128}. ${"42.17"}`, /42\.17$/);
  }
  I.setLanguage("en", { persist: false });
  assert.equal(I.formatNumber(12345.5), "12,345.5");
  I.setLanguage("ru", { persist: false });
  assert.match(I.formatNumber(12345.5), /345,5$/);
  assert.match(
    I.formatDate("2026-11-07T12:00:00Z", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone: "UTC",
    }),
    /07\.11\.2026/,
  );
  I.setLanguage("en", { persist: false });
});

test("explicit static bindings update text and accessibility without touching input values", () => {
  const b = browser(),
    text = { nodeType: 3, nodeValue: "  Monitor ", isConnected: true };
  const selector = { value: "en", options: [{value:"ru",dataset:{languageName:"Russian"}}, {value:"uk",dataset:{languageName:"Ukrainian"}}] },
    draft = { value: "00018446744073709551615" };
  const attributes = {
    "data-i18n-text": '[[0,"Monitor"]]',
    "data-i18n-title": "Settings",
  };
  const element = {
    childNodes: [text],
    getAttribute: (key) => attributes[key],
    setAttribute: (key, value) => (attributes[key] = value),
  };
  const document = {
    documentElement: { lang: "en" },
    querySelectorAll: (query) =>
      ["[data-i18n-text]", "[data-i18n-title]"].includes(query)
        ? [element]
        : [],
    getElementById: (id) => (id === "languageSelect" ? selector : draft),
  };
  b.I.bindDocument(document);
  b.I.setLanguage("ru");
  assert.equal(text.nodeValue, "  " + I.messages.Monitor.ru + " ");
  assert.equal(attributes.title, I.messages.Settings.ru);
  assert.equal(document.documentElement.lang, "ru");
  assert.equal(selector.value, "ru");
  assert.equal(selector.options[0].textContent, I.messages.Russian.ru);
  assert.equal(selector.options[1].textContent, I.messages.Ukrainian.uk);
  assert.equal(draft.value, "00018446744073709551615");
  text.isConnected = false;
  text.nodeValue = "User content";
  b.I.setLanguage("uk");
  assert.equal(text.nodeValue, "User content");
});

test("every declared HTML binding is translated; English is the source document default", () => {
  const html = read("index.html");
  const decode = (s) =>
    s
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  assert.match(html, /<html lang="en">/);
  for (const name of ["index.html", "app.js", "core.js", "config-editor.js", "catalog.js", "i18n.js"]) assert.doesNotMatch(read(name), /\p{Script=Cyrillic}/u, name);
  let count = 0;
  for (const match of html.matchAll(
    /data-i18n-text=(?:"([^"]*)"|'([^']*)')/g,
  )) {
    for (const [, source] of JSON.parse(decode(match[1] || match[2]))) {
      assert(I.messages[source], source);
      count++;
    }
  }
  for (const match of html.matchAll(
    /data-i18n-(?:title|aria-label|placeholder)="([^"]*)"/g,
  ))
    assert(I.messages[decode(match[1])], match[1]);
  assert(count > 150);
  assert(html.indexOf('src="i18n.js') < html.indexOf('src="core.js'));
  assert(html.indexOf('src="config-locales.js') < html.indexOf('src="i18n.js'));
});

test("every shipped catalog card is localized by ID while physics metadata stays untouched", () => {
  const context = { window: {} };
  vm.createContext(context);
  vm.runInContext(read("patterns.js"), context);
  vm.runInContext(read("device-library.js"), context);
  const patterns = context.window.LIFE_PATTERNS;
  assert(patterns.length > 50);
  for (const lang of I.languages) {
    I.setLanguage(lang, { persist: false });
    for (const p of patterns) {
      assert(catalogLocales[lang].patterns[p.id], p.id);
      assert(catalogLocales[lang].categories[p.type], p.type);
      const entry = catalogLocales[lang].patterns[p.id];
      const localized = I.pattern(p);
      assert.equal(localized.name, entry.name, p.id);
      assert.equal(localized.note, entry.note, p.id);
      assert.equal(localized.type, catalogLocales[lang].categories[p.type], p.id);
      if (p.description) assert.equal(localized.description, entry.description, p.id);
      if (p.demo) assert.equal(localized.demo.observation, entry.demoObservation, p.id);
      for (const searchLanguage of I.languages) {
        const reference = catalogLocales[searchLanguage].patterns[p.id];
        for (const value of [reference.name, reference.search].filter(Boolean)) assert(I.searchText(p).includes(value.toLocaleLowerCase(I.locale())), p.id);
      }
      assert.equal(localized.id, p.id);
      assert.equal(localized.rle, p.rle);
      assert.equal(localized.verification, p.verification);
      assert.equal(localized.variants, p.variants);
      assert.equal(localized.population, p.population);
      if (p.demo) {
        assert.equal(localized.demo.generation, p.demo.generation);
        assert.equal(localized.demo.view, p.demo.view);
      }
      if (lang === "en")
        assert(
          !/\p{Script=Cyrillic}/u.test(
            localized.name + localized.note + (localized.description || ""),
          ),
          p.id,
        );
      assert(
        I.searchText(p).includes(localized.name.toLocaleLowerCase(I.locale())),
        p.id,
      );
      assert(
        I.searchText(p).includes(p.name.toLocaleLowerCase(I.locale())),
        p.id,
      );
    }
  }
  I.setLanguage("en", { persist: false });
});

test("offline Blob workers have localized validation and identical exact random output", () => {
  let reference;
  for (const lang of I.languages) {
    I.setLanguage(lang, { persist: false });
    const context = {};
    context.self = context;
    vm.createContext(context);
    vm.runInContext(
      I.workerSource() +
        read("core.js") +
        `
      try { new LifeCore.SparseGrid(0,2); } catch(error) { self.message=error.message; }
      self.cells=Array.from(LifeCore.randomGrid(32,32,{x:1,y:1,width:30,height:30},0.15,"18446744073709551615").cells());
    `,
      context,
    );
    const cells = JSON.stringify(context.cells);
    if (reference) assert.equal(cells, reference);
    else reference = cells;
    assert.equal(
      context.message,
      (() => {
        try {
          new C.SparseGrid(0, 2);
        } catch (error) {
          return error.message;
        }
      })(),
    );
    if (lang === "en") assert(!/\p{Script=Cyrillic}/u.test(context.message));
    assert.equal(context.fetch, undefined);
  }
  I.setLanguage("en", { persist: false });
});
