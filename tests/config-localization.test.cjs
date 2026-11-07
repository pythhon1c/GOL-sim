"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const messages = require("../web/config-locales.js");
const translated = (key, language) => messages[key]?.[language] ?? key;
const rangeMessage = language => translated("Allowed range: {0}–{1}.", language).replace("{0}", "1").replace("{1}", "2000000000");
const source = fs.readFileSync(path.join(__dirname, "../web/config-editor.js"), "utf8");

// A small DOM model exercises updates of existing inputs, rather than snapshots of HTML.
class Element {
  constructor(tag, document) {
    this.tagName = tag.toLowerCase();
    this.ownerDocument = document;
    this.children = [];
    this.attributes = {};
    this.dataset = {};
    this.listeners = {};
    this._value = "";
    this._text = "";
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this._text = ""; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  set value(value) { this._value = String(value); }
  get value() { return this._value; }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === "id") this.id = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  focus() { this.ownerDocument.activeElement = this; }
  querySelectorAll(selector) {
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (selector.startsWith("#") ? child.id === selector.slice(1) : child.tagName === selector) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  set innerHTML(html) {
    this.replaceChildren();
    const stack = [this];
    for (const match of html.matchAll(/<\/?([a-z]+)([^>]*)>/g)) {
      if (match[0][1] === "/") { stack.pop(); continue; }
      const child = this.ownerDocument.createElement(match[1]);
      for (const attr of match[2].matchAll(/([a-z-]+)="([^"]*)"/g)) child.setAttribute(attr[1], attr[2]);
      stack.at(-1).append(child);
      if (match[1] !== "input") stack.push(child);
    }
  }
}

function fixture() {
  let language = "en";
  const document = { createElement(tag) { return new Element(tag, document); } };
  const translator = {
    t(key, ...values) {
      const template = translated(key, language);
      return template.replace(/\{(\d+)\}/g, (match, index) => index < values.length ? String(values[index]) : match);
    },
  };
  const context = vm.createContext({ document, LifeI18n: translator });
  vm.runInContext(source, context);
  return { config: context.LifeConfig, document, language(value) { language = value; } };
}
const plain = value => JSON.parse(JSON.stringify(value));

test("configuration labels use English source text and provide Russian and Ukrainian translations", () => {
  const { config } = fixture();
  const strings = [
    ...config.SECTIONS.flatMap(section => [section.title, section.description]),
    ...config.FIELDS.flatMap(field => [field.label, field.description, ...(field.options || []).map(option => option[1])]),
  ];
  for (const key of strings) {
    assert.doesNotMatch(key, /\p{Script=Cyrillic}/u);
    if (/^\d+ × \d+$/.test(key)) continue;
    for (const language of ["ru", "uk"]) assert.ok(messages[key]?.[language]?.trim(), `Missing ${language} translation for ${key}`);
  }
});

test("language changes localize validation and change labels without changing data or TOML", () => {
  const f = fixture(), base = f.config.normalizeConfig();
  const valid = f.config.normalizeConfig(base);
  valid.initial.seed = "18446744073709551615";
  valid.initial.path = "C:\\Life\\Café.rle";
  valid.engine.threads = 4;
  const exports = [];
  const plans = [];
  for (const language of ["en", "ru", "uk"]) {
    f.language(language);
    exports.push(f.config.toTOML(valid));
    plans.push(plain(f.config.buildChangePlan(base, valid)));
    const bad = f.config.normalizeConfig(base);
    bad.grid.width = 0;
    bad.engine.threads = Infinity;
    const errors = f.config.validateConfig(bad);
    const range = errors.find(item => item.path === "grid.width").message;
    assert.equal(range, rangeMessage(language));
    assert.equal(errors.find(item => item.path === "engine.threads").message,
      translated("A finite integer is required.", language));
  }
  assert.equal(exports[0], exports[1]);
  assert.equal(exports[0], exports[2]);
  assert.match(exports[0], /# LIFE ENGINE — complete startup configuration/);
  assert.match(exports[0], /seed = "18446744073709551615"/);
  assert.match(exports[0], /Café\.rle/);
  assert.equal(plans[0].restartChanges.find(change => change.path === "engine.threads").label, "CPU threads");
  assert.equal(plans[1].restartChanges.find(change => change.path === "engine.threads").label, messages["CPU threads"].ru);
  for (const plan of plans) {
    for (const group of ["changes", "liveChanges", "restartChanges"]) for (const change of plan[group]) delete change.label;
  }
  assert.deepEqual(plans[0], plans[1]);
  assert.deepEqual(plans[0], plans[2]);
});

test("locale refresh preserves raw drafts, selection, baseline and control identities", () => {
  const f = fixture(), container = f.document.createElement("div");
  let changes = 0;
  const editor = f.config.createEditor(container, { onChange() { changes++; } });
  const seed = container.querySelector("#cfg-initial.seed");
  const width = container.querySelector("#cfg-grid.width");
  const from = container.querySelector("#cfg-rectangle-from");
  seed.value = "00018446744073709551615";
  width.value = "";
  from.value = " 12.34 ";
  seed.selectionStart = 3;
  seed.selectionEnd = 10;
  seed.focus();
  const baseline = plain(editor.baseline);
  editor.validate();
  assert.equal(container.querySelector("#cfg-error-grid.width").textContent, "A finite integer is required.");
  const initialChanges = changes;
  f.language("ru");
  editor.refreshLocale();
  assert.equal(seed, container.querySelector("#cfg-initial.seed"));
  assert.equal(f.document.activeElement, seed);
  assert.equal(seed.value, "00018446744073709551615");
  assert.equal(seed.selectionStart, 3);
  assert.equal(seed.selectionEnd, 10);
  assert.equal(width.value, "");
  assert.equal(from.value, " 12.34 ");
  assert.deepEqual(plain(editor.baseline), baseline);
  assert.equal(changes, initialChanges, "Changing language must not publish a configuration edit");
  assert.equal(container.querySelector("#cfg-error-grid.width").textContent, messages["A finite integer is required."].ru);
  assert.equal(container.querySelector("#cfg-rectangle-label").textContent, messages["Rectangular area only"].ru);
  assert.equal(container.querySelector("#cfg-grid.wrap").children[0].textContent, messages["Disabled"].ru);
  f.language("uk");
  editor.refreshLocale();
  assert.equal(container.querySelector("#cfg-rectangle-label").textContent, messages["Rectangular area only"].uk);
  assert.equal(seed.value, "00018446744073709551615");
  f.language("en");
  editor.refreshLocale();
  assert.equal(container.querySelector("#cfg-rectangle-label").textContent, "Rectangular area only");
  assert.doesNotMatch(container.textContent, /\p{Script=Cyrillic}/u);
});

test("the shared CommonJS translator defaults to English and serves configuration messages", () => {
  const i18n = require("../web/i18n.js");
  const config = require("../web/config-editor.js");
  assert.equal(i18n.getLanguage(), "en");
  try {
    for (const language of ["en", "ru", "uk"]) {
      i18n.setLanguage(language);
      const draft = config.normalizeConfig();
      draft.grid.width = 0;
      assert.equal(config.validateConfig(draft).find(error => error.path === "grid.width").message,
        rangeMessage(language));
      const source = config.FIELDS.find(field => field.path === "engine.cycles_detection_interval").description;
      assert.equal(i18n.t(source), translated(source, language));
    }
  } finally {
    i18n.setLanguage("en");
  }
});
