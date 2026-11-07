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
      title: "Поле",
      description:
        "Розміри й топологія для наступного запуску. Поточне поле змінюється через «Нове поле» або імпорт.",
    },
    {
      id: "initial",
      title: "Початковий стан",
      description:
        "Файл має пріоритет над випадковим заповненням. Без файлу й рандомізації початкове поле порожнє.",
    },
    {
      id: "engine",
      title: "Обчислення",
      description:
        "Точний CPU-рушій B3/S23. Автовибір враховує доступні ресурси; GPU у цій версії не підтримується.",
    },
    {
      id: "checkpoints",
      title: "Збереження",
      description:
        "Періодичні контрольні точки з обмеженням запису, розміру сегментів і загальної квоти.",
    },
    {
      id: "display",
      title: "Відображення",
      description:
        "Початкові налаштування монітора. Явне застосування тут також оновлює вигляд у цій вкладці; збережені браузерні налаштування мають пріоритет під час відкриття.",
    },
    {
      id: "server",
      title: "Підключення",
      description:
        "Адреса й порт для наступного запуску. Зовнішній доступ потребує LIFE_ACCESS_TOKEN щонайменше з 24 символів.",
    },
  ];
  const FIELDS = [
    {
      path: "grid.width",
      label: "Стовпців",
      type: "integer",
      min: 1,
      max: 2000000000,
      mode: "restart",
      description:
        "Ширина скінченного поля. Порожні ділянки зберігаються розріджено.",
    },
    {
      path: "grid.height",
      label: "Рядків",
      type: "integer",
      min: 1,
      max: 2000000000,
      mode: "restart",
      description:
        "Висота поля. Розмір не означає, що для всіх клітин одразу виділяється пам’ять.",
    },
    {
      path: "grid.wrap",
      label: "З’єднання протилежних країв",
      type: "boolean",
      mode: "restart",
      description:
        "Увімкнено — тор. Вимкнено — клітини за межами поля мертві. Для тора обидва розміри мають бути не менші за 3.",
    },
    {
      path: "initial.path",
      label: "Файл початкового стану",
      type: "text",
      mode: "restart",
      description:
        "Шлях на комп’ютері сервера до JSON, RLE або маніфест контрольної точки. Файл відновлює збережені розміри й топологію, замінюючи параметри поля. Порожнє значення — без файлу.",
    },
    {
      path: "initial.random",
      label: "Випадкове заповнення",
      type: "boolean",
      mode: "restart",
      description:
        "Застосовується під час старту, якщо шлях до файлу порожній. Клітини поза вибраною областю залишаються мертвими.",
    },
    {
      path: "initial.seed",
      label: "Seed — відтворюваний випадковий стан",
      type: "seed",
      mode: "restart",
      description:
        "Ціле число 0–18446744073709551615. Зберігається точно, без округлення великих чисел у браузері.",
    },
    {
      path: "initial.density",
      label: "Імовірність живої клітини, %",
      type: "percent",
      min: 1,
      max: 99,
      mode: "restart",
      description:
        "Від 1 до 99%. Кожна клітина обирається незалежно; фактична кількість живих може трохи відрізнятися.",
    },
    {
      path: "engine.tile_size",
      label: "Сторона обчислювального кластера",
      type: "select",
      options: [
        ["auto", "Автоматично"],
        [64, "64 × 64"],
        [128, "128 × 128"],
        [256, "256 × 256"],
        [512, "512 × 512"],
        [1024, "1024 × 1024"],
      ],
      mode: "restart",
      description:
        "Один рівень кластерів. Автовибір порівнює 64, 128 і 256; вручну доступні степені двійки до 1024.",
    },
    {
      path: "engine.threads",
      label: "Потоків CPU",
      type: "auto",
      min: 1,
      max: 256,
      mode: "restart",
      description:
        "Автоматично — кількість логічних процесорів, максимум 256. Вручну можна залишити частину ресурсів іншим програмам.",
    },
    {
      path: "engine.memory_mb",
      label: "Бюджет пам’яті, МіБ",
      type: "auto",
      min: 64,
      max: 1048576,
      mode: "restart",
      description:
        "Авто: половина доступної RAM, у межах 128–4096 МіБ. Частина резервується для Python і запитів. Це бюджет та контроль RSS, не жорсткий ліміт ОС.",
    },
    {
      path: "engine.cache_mb",
      label: "Кеш обчислень, МіБ",
      type: "integer",
      min: 0,
      max: 1048576,
      mode: "restart",
      description:
        "Нуль вимикає кеш. Ефективний розмір додатково обмежується чвертю бюджету обчислювального ядра.",
    },
    {
      path: "engine.cpu_min_percent",
      label: "Мінімальне навантаження CPU, %",
      type: "number",
      min: 0,
      max: 100,
      mode: "advisory",
      description:
        "Збережений орієнтир. Рушій не створює зайву роботу, щоб штучно досягти цього мінімуму.",
    },
    {
      path: "engine.cpu_max_percent",
      label: "Максимальне навантаження CPU, %",
      type: "number",
      min: 0,
      max: 100,
      mode: "live",
      description:
        "Значення більше нуля. Середнє навантаження регулюється паузою після цілого покоління; миттєвий пік може бути вищим.",
    },
    {
      path: "engine.max_generations_per_second",
      label: "Максимум поколінь за секунду",
      type: "number",
      min: 0,
      max: 1000000,
      mode: "live",
      description:
        "Нуль — без обмеження швидкості. Додатковий темп роботи не змінює правил або станів симуляції.",
    },
    {
      path: "engine.gpu",
      label: "Режим GPU",
      type: "select",
      options: [["off", "Вимкнено — підтримується лише CPU"]],
      mode: "advisory",
      description:
        "GPU-рушія у цій версії немає. Увімкнення недоступне; поле залишається в конфігурації для майбутнього розширення.",
    },
    {
      path: "engine.gpu_min_percent",
      label: "Мінімальне навантаження GPU, %",
      type: "number",
      min: 0,
      max: 100,
      mode: "advisory",
      description:
        "Резервне налаштування. Поки GPU вимкнено, воно не впливає на роботу.",
    },
    {
      path: "engine.gpu_max_percent",
      label: "Максимальне навантаження GPU, %",
      type: "number",
      min: 0,
      max: 100,
      mode: "advisory",
      description:
        "Резервне налаштування; має бути більше нуля й не менше мінімуму. У поточній версії не застосовується.",
    },
    {
      path: "checkpoints.directory",
      label: "Папка контрольних точок",
      type: "text",
      mode: "live",
      description:
        "Непорожній шлях на сервері. Відносний шлях обчислюється від папки проєкту.",
    },
    {
      path: "checkpoints.every_generations",
      label: "Записувати кожні N поколінь",
      type: "integer",
      min: 1,
      max: 1000000000000000,
      mode: "live",
      description:
        "Цільова відстань між контрольними точками. Разом із нею враховується мінімальний часовий інтервал.",
    },
    {
      path: "checkpoints.min_interval_seconds",
      label: "Мінімальний інтервал запису, секунд",
      type: "number",
      min: 0,
      mode: "live",
      description:
        "1800 секунд = 30 хвилин. Захищає диск від надто частих файлів, навіть якщо покоління змінюються швидко.",
    },
    {
      path: "checkpoints.mode",
      label: "Режим збереження",
      type: "select",
      options: [
        ["coalesce", "Останній актуальний стан"],
        ["strict", "Кожна цільова точка з очікуванням"],
      ],
      mode: "live",
      description:
        "Останній стан: потрібні і N ходів, і часовий інтервал. Строгий режим: на цільовому ході симуляція чекає, доки запис буде дозволено.",
    },
    {
      path: "checkpoints.segment_mb",
      label: "Максимальний сегмент файлу, МіБ",
      type: "integer",
      min: 1,
      max: 256,
      mode: "live",
      description:
        "Великий стан ділиться на стиснені сегменти до цього розміру. Доступно 1–256 МіБ.",
    },
    {
      path: "checkpoints.quota_mb",
      label: "Загальна квота папки, МіБ",
      type: "integer",
      min: 1,
      max: 1000000000,
      mode: "live",
      description:
        "Не менша за сегмент. Для безпечної заміни має вміщати старий і новий знімок; перевірені старі записи очищаються в межах квоти.",
    },
    {
      path: "checkpoints.write_mb_per_second",
      label: "Швидкість запису, МіБ/с",
      type: "number",
      min: 0,
      mode: "live",
      description:
        "Додатне значення. Реальне обмеження потоку запису; короткі невеликі сплески можливі.",
    },
    {
      path: "checkpoints.disk_min_percent",
      label: "Мінімальне навантаження диска, %",
      type: "number",
      min: 0,
      max: 100,
      mode: "advisory",
      description:
        "Збережений орієнтир без примусового навантаження. Фактично діють інтервал, квота й МіБ/с.",
    },
    {
      path: "checkpoints.disk_max_percent",
      label: "Максимальне навантаження диска, %",
      type: "number",
      min: 0,
      max: 100,
      mode: "advisory",
      description:
        "Збережений орієнтир, а не ліміт зайнятості пристрою. Для обмеження запису використовуйте МіБ/с.",
    },
    {
      path: "display.gradient_levels",
      label: "Рівнів сірого",
      type: "integer",
      min: 2,
      max: 256,
      mode: "live",
      description:
        "Кількість відтінків для віддаленого вигляду. На рівні клітин живе залишається білим, мертве — чорним.",
    },
    {
      path: "display.first_level_saturation",
      label: "Насиченість першого рівня",
      type: "number",
      min: 0,
      max: 1000,
      mode: "live",
      description:
        "Підсилення видимості непорожніх блоків до 64 × 64 клітин. Впливає лише на зображення.",
    },
    {
      path: "display.upper_level_saturation",
      label: "Насиченість верхніх рівнів",
      type: "number",
      min: 0,
      max: 1000,
      mode: "live",
      description:
        "Підсилення для більших блоків на віддаленні. Для підрахунків завжди використовуються точні кількості живих.",
    },
    {
      path: "display.tile_cache_mb",
      label: "Кеш монітора, МіБ",
      type: "integer",
      min: 1,
      max: 1024,
      mode: "live",
      description:
        "Бюджет кешу сусідніх областей у браузері. Поточний кадр і пам’ять самого браузера до цього кешу не входять.",
    },
    {
      path: "server.host",
      label: "Адреса прослуховування",
      type: "text",
      mode: "restart",
      description:
        "127.0.0.1 — лише цей комп’ютер. 0.0.0.0 — усі мережеві інтерфейси; потрібен токен доступу в середовищі сервера.",
    },
    {
      path: "server.port",
      label: "Порт",
      type: "integer",
      min: 1,
      max: 65535,
      mode: "restart",
      description: "Порт локального вебсервера. Типове значення — 8765.",
    },
  ];
  FIELDS.push(
    {
      path: "engine.cycles_enabled",
      label: "Пошук і повторення циклів",
      type: "boolean",
      mode: "live",
      description:
        "Дозволяє допоміжний пошук точних повторень. Перед кожним використанням збереженої фази перевіряються стан кластера й зовнішній ряд сусідів; зміна межі повертає звичайний розрахунок.",
    },
    {
      path: "engine.cycles_start_generation",
      label: "Починати пошук із покоління",
      type: "integer",
      min: 0,
      max: 1000000000000000,
      mode: "live",
      description:
        "До цього покоління допоміжний пошук не витрачає ресурси на початковий хаос. Невідомий період на тепловій карті не означає доведену відсутність циклу.",
    },
    {
      path: "engine.cycles_max_period",
      label: "Найбільший період пошуку",
      type: "integer",
      min: 1,
      max: 64,
      mode: "live",
      description:
        "Від 1 до 64 ходів. Довші цикли потребують більше історії. 1 — пошук стабільних станів. Шкала теплової карти завжди прив’язана до періоду 64.",
    },
    {
      path: "engine.cycles_memory_mb",
      label: "Пам’ять пошуку циклів, МіБ",
      type: "integer",
      min: 0,
      max: 1048576,
      mode: "live",
      description:
        "Бюджет кандидатів, фаз і охоронців меж. Нуль вимикає зберігання. Фактичний бюджет може бути меншим через загальну доступну пам’ять ядра.",
    },
    {
      path: "engine.cycles_detection_interval",
      label: "Інтервал нових перевірок, ходів",
      type: "integer",
      min: 1,
      max: 65535,
      mode: "live",
      description:
        "Як часто починати допоміжну перевірку кандидатів. Уже підтверджені фази та їхні межі перевіряються перед кожним повторним використанням незалежно від цього інтервалу.",
    },
    {
      path: "display.heat_stable",
      label: "Температура стабільного стану",
      type: "number",
      min: 0,
      max: 1,
      mode: "live",
      description:
        "Базове значення для підтвердженого періоду 1. Має бути нижчим за верхню температуру циклів. Порожні блоки завжди чорні.",
    },
    {
      path: "display.heat_cycle_max",
      label: "Температура циклу періоду 64",
      type: "number",
      min: 0,
      max: 1,
      mode: "live",
      description:
        "Верхня базова температура відомих циклів. Між періодами 1 і 64 використовується log₂(period), без перенормування кадру.",
    },
    {
      path: "display.heat_active",
      label: "Температура невідомого / активного стану",
      type: "number",
      min: 0,
      max: 1,
      mode: "live",
      description:
        "Базове значення, коли чинний охоронець не підтверджує період. Вище за всі відомі цикли за однакової щільності; це не доказ хаотичності.",
    },
    {
      path: "display.heat_density_gain",
      label: "Додаткова температура від щільності",
      type: "number",
      min: 0,
      max: 1,
      mode: "live",
      description:
        "Зростає зі щільністю для циклічних і невідомих ділянок. Сума з температурою активного стану не може перевищувати 1.",
    },
    {
      path: "display.heat_density_reference",
      label: "Опорна щільність живих клітин",
      type: "number",
      min: 0,
      max: 1,
      mode: "live",
      description:
        "Частка від 0 до 1, більша за нуль; 0.15 = 15%. При цій щільності додаткова температура досягає максимуму. Значення фіксоване для всіх кадрів.",
    },
    {
      path: "display.heat_hotspot_mix",
      label: "Вага найгарячішого фрагмента",
      type: "number",
      min: 0,
      max: 1,
      mode: "live",
      description:
        "0 — середня активність, зважена за живими клітинами; 1 — максимум. Типові 0.25 допомагають зберегти малі активні осередки при віддаленні.",
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
      throw Error(T("Seed отримано як неточне число. Потрібен десятковий рядок."));
    const s = String(value);
    if (!/^\d+$/.test(s) || BigInt(s) > 18446744073709551615n)
      throw Error(T("Seed має бути цілим числом від 0 до 18446744073709551615."));
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
        if (typeof v !== "string") add(f.path, "Очікується текст.");
        if (
          ["server.host", "checkpoints.directory"].includes(f.path) &&
          !String(v || "").trim()
        )
          add(f.path, "Значення не може бути порожнім.");
        continue;
      }
      if (f.type === "boolean") {
        if (typeof v !== "boolean")
          add(f.path, "Оберіть «Увімкнено» або «Вимкнено».");
        continue;
      }
      if (f.type === "select") {
        if (!f.options.some(([value]) => value === v))
          add(f.path, "Оберіть одне з доступних значень.");
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
            ? "Очікується скінченне ціле число."
            : "Очікується скінченне число.",
        );
        continue;
      }
      if (
        (f.min !== undefined && value < f.min) ||
        (f.max !== undefined && value > f.max)
      )
        add(
          f.path,
          T("Доступний діапазон: {0}–{1}.", f.min, f.max ?? T("без верхньої межі")),
        );
    }
    if (config.grid?.wrap && (config.grid.width < 3 || config.grid.height < 3))
      add("grid.wrap", "Для тора потрібне поле щонайменше 3 × 3.");
    for (const prefix of ["cpu", "gpu"]) {
      const min = config.engine?.[prefix + "_min_percent"],
        max = config.engine?.[prefix + "_max_percent"];
      if (min > max || max <= 0)
        add(
          "engine." + prefix + "_max_percent",
          "Максимум має бути більший за нуль і не менший за мінімум.",
        );
    }
    if (
      config.checkpoints?.disk_min_percent >
      config.checkpoints?.disk_max_percent
    )
      add(
        "checkpoints.disk_max_percent",
        "Максимум не може бути нижчим за мінімум.",
      );
    if (config.checkpoints?.quota_mb < config.checkpoints?.segment_mb)
      add("checkpoints.quota_mb", "Квота не може бути меншою за один сегмент.");
    if (config.checkpoints?.write_mb_per_second <= 0)
      add(
        "checkpoints.write_mb_per_second",
        "Швидкість запису має бути більшою за нуль.",
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
        "Потрібний порядок: стабільний < цикл < активний, у межах 0–1.",
      );
    if (
      heat &&
      (!(heat.heat_density_reference > 0) || heat.heat_density_reference > 1)
    )
      add(
        "display.heat_density_reference",
        "Опорна щільність має бути більшою за нуль і не більшою за 1.",
      );
    if (heat && heat.heat_active + heat.heat_density_gain > 1 + 1e-12)
      add(
        "display.heat_density_gain",
        "Температура активного стану разом із додатком від щільності не може перевищувати 1.",
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
          "Прямокутник має бути всередині поля; координати x.y починаються з 1.",
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
        label: "Область рандомізації",
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
      throw Error(T("Для редактора потрібен DOM."));
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
    bindAttribute(nav, "aria-label", "Розділи налаштувань");
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
            ? "Перезапуск"
            : field.mode === "advisory"
              ? "Орієнтир / резерв"
              : "Одразу");
        title.append(label, badge);
        let input, auto;
        if (field.type === "select" || field.type === "boolean") {
          input = document.createElement("select");
          const opts =
            field.type === "boolean"
              ? [
                  [false, "Вимкнено"],
                  [true, "Увімкнено"],
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
            const updateModeLabel = () => auto.setAttribute("aria-label", T("{0} — режим", T(field.label)));
            translations.push(updateModeLabel);
            updateModeLabel();
            for (const [value, text] of [
              ["auto", "Автоматично"],
              ["manual", "Вручну"],
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
          ["label", "Лише прямокутна область"],
          ["badge", "Перезапуск"],
          ["help", "Без обмеження — усе поле. Кути включно, координати стовпець.рядок від 1; наприклад 1666.1888."],
          ["from-label", "Лівий верхній кут"],
          ["from-help", "Перша клітина області: стовпець.рядок, включно."],
          ["to-label", "Правий нижній кут"],
          ["to-help", "Остання клітина області, включно. Має бути не вище й не лівіше першої."],
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
            value === "auto" ? T("Автовибір") : String(field.min);
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
        if (auto) input.placeholder = auto.value === "auto" ? T("Автовибір") : String(field.min);
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
