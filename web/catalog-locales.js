/* Catalog display strings keyed by stable pattern IDs. No cell data is stored here. */
(function (root, factory) {
  const locales = factory();
  if (typeof module === "object" && module.exports) module.exports = locales;
  else root.LIFE_CATALOG_LOCALES = locales;
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";
  return {
  "en": {
    "categories": {
      "ACTIVE SIGNAL": "ACTIVE SIGNAL",
      "LARGE LOGIC CIRCUIT": "LARGE LOGIC CIRCUIT",
      "GLIDER GUN": "GLIDER GUN",
      "LONG-LIVED PATTERN": "LONG-LIVED PATTERN",
      "SPACESHIP": "SPACESHIP",
      "LOGIC CIRCUIT": "LOGIC CIRCUIT",
      "LOGIC COMPONENT": "LOGIC COMPONENT",
      "SINGLE-USE LOGIC CIRCUIT": "SINGLE-USE LOGIC CIRCUIT",
      "OSCILLATOR": "OSCILLATOR",
      "PUFFER / MOVING TRAIL": "PUFFER / MOVING TRAIL",
      "STILL LIFE": "STILL LIFE",
      "QUICK DEMO MACHINE": "QUICK DEMO MACHINE"
    },
    "patterns": {
      "glider": {
        "name": "Glider",
        "note": "Period 4 · moves one cell diagonally per cycle"
      },
      "block": {
        "name": "Block",
        "note": "4 cells · a stationary pattern"
      },
      "beehive": {
        "name": "Beehive",
        "note": "6 cells · period 1"
      },
      "blinker": {
        "name": "Blinker",
        "note": "Period 2 · the simplest oscillator"
      },
      "toad": {
        "name": "Toad",
        "note": "Period 2 · alternates between two phases"
      },
      "beacon": {
        "name": "Beacon",
        "note": "Period 2 · two interacting corners"
      },
      "pulsar": {
        "name": "Pulsar",
        "note": "Period 3 · fourfold symmetry"
      },
      "lwss": {
        "name": "Lightweight spaceship",
        "note": "Period 4 · travels horizontally at c/2"
      },
      "acorn": {
        "name": "Acorn",
        "note": "7 cells · a long and complex evolution"
      },
      "rpentomino": {
        "name": "R-pentomino",
        "note": "5 cells · produces many interacting patterns"
      },
      "gosper": {
        "name": "Gosper glider gun",
        "note": "Period 30 · emits a regularly timed stream of gliders"
      },
      "eater": {
        "name": "Signal eater",
        "note": "Eater 1 · absorbs a glider approaching from the correct direction and phase"
      },
      "not-input-zero": {
        "name": "NOT · input 0 → output 1",
        "note": "Read generation 64 · output glider in relative region 29.29–31.31. Single use."
      },
      "not-input-one": {
        "name": "NOT · input 1 → output 0",
        "note": "Read generation 64 · the collision clears the output in relative region 29.29–31.31. Single use."
      },
      "and-latch": {
        "name": "AND · inputs 11 → output 1",
        "note": "Read generation 64 · the two inputs form a block in relative region 21.21–22.22. Single use."
      },
      "boat": {
        "name": "Boat",
        "note": "5 cells · an asymmetric still life"
      },
      "ship": {
        "name": "Ship",
        "note": "6 cells · a stationary pattern with diagonal symmetry"
      },
      "loaf": {
        "name": "Loaf",
        "note": "7 cells · a stable outline with a hollow center"
      },
      "tub": {
        "name": "Tub",
        "note": "4 cells · the smallest hollow diamond"
      },
      "pond": {
        "name": "Pond",
        "note": "8 cells · a square ring with an empty center"
      },
      "snake": {
        "name": "Snake",
        "note": "6 cells · a compact stationary pattern"
      },
      "barge": {
        "name": "Barge",
        "note": "6 cells · an elongated diamond"
      },
      "hat": {
        "name": "Hat",
        "note": "9 cells · a stable pattern with a wide base"
      },
      "pentadecathlon": {
        "name": "Pentadecathlon",
        "note": "Period 15 · an elongated oscillator"
      },
      "clock-small": {
        "name": "Small clock",
        "note": "Period 2 · six cells change orientation"
      },
      "koksgalaxy": {
        "name": "Kok's galaxy",
        "note": "Period 8 · four arms with rotational symmetry"
      },
      "pinwheel": {
        "name": "Pinwheel",
        "note": "Period 4 · a large symmetric rotor"
      },
      "fumarole": {
        "name": "Fumarole",
        "note": "Period 5 · a compact oscillator with short sparks"
      },
      "unix": {
        "name": "Unix",
        "note": "Period 6 · two blocks support an active center"
      },
      "mold": {
        "name": "Mold",
        "note": "Period 4 · a compact pattern with 12 initial cells"
      },
      "jam": {
        "name": "Jam",
        "note": "Period 3 · a small asymmetric oscillator"
      },
      "mazing": {
        "name": "Mazing",
        "note": "Period 4 · a changing center within a stable boundary"
      },
      "caterer": {
        "name": "Caterer",
        "note": "Period 3 · 12 cells in the initial phase"
      },
      "phoenix": {
        "name": "Phoenix",
        "note": "Period 2 · every live cell dies in the next generation"
      },
      "mwss": {
        "name": "Middleweight spaceship",
        "note": "Period 4 · moves two cells horizontally per cycle at c/2"
      },
      "hwss": {
        "name": "Heavyweight spaceship",
        "note": "Period 4 · the largest of the classic trio, moving at c/2"
      },
      "copperhead": {
        "name": "Copperhead",
        "note": "Period 10 · slow orthogonal motion at c/10"
      },
      "loafer": {
        "name": "Loafer",
        "note": "Period 7 · a slow spaceship moving at c/7"
      },
      "turtle": {
        "name": "Turtle",
        "note": "Period 3 · orthogonal motion at c/3 with a short tail spark"
      },
      "diehard": {
        "name": "Diehard",
        "note": "7 cells · vanishes completely at generation 130"
      },
      "rabbits": {
        "name": "Rabbits",
        "note": "9 cells · a long, eventful evolution on a spacious field"
      },
      "bheptomino": {
        "name": "B-heptomino",
        "note": "7 cells · produces blocks, gliders and a ship still life"
      },
      "piheptomino": {
        "name": "Pi-heptomino",
        "note": "7 cells in a Π shape · an active component of many reactions"
      },
      "herschel": {
        "name": "Herschel",
        "note": "7 cells · a short-lived signal used in logic circuits"
      },
      "switchengine": {
        "name": "Switch engine",
        "note": "8 cells · an unstable moving engine with a changing trail"
      },
      "blom": {
        "name": "Blom",
        "note": "13 cells · a long, branching evolution"
      },
      "lidka": {
        "name": "Lidka",
        "note": "15 cells · evolves for a long time and needs plenty of space"
      },
      "simkinglidergun": {
        "name": "Simkin glider gun with snake",
        "note": "The core repeats every 240 generations · emits a glider every 120"
      },
      "puffertrain": {
        "name": "Puffer train",
        "note": "Moves while leaving a trail of live patterns · needs a spacious field"
      },
      "blinker-puffer": {
        "name": "Blinker factory",
        "note": "The first blinker appears at generation 5, then a new one every 8 generations. The moving generator leaves a row of oscillators.",
        "demoObservation": "The generator has moved left, leaving 16 blinkers behind."
      },
      "block-laying-switch-engine": {
        "name": "Moving block factory",
        "note": "The first new block appears at generation 90. The moving engine adds eight 2 × 2 blocks every 288 generations.",
        "demoObservation": "The engine has moved diagonally and added eight stationary blocks."
      },
      "logic-nor": {
        "name": "NOR",
        "note": "Either input glider can extinguish the same clock pulse. Read generation 96.",
        "description": "Either input glider can extinguish the same clock pulse. Single-use circuit. Select the inputs before starting."
      },
      "logic-or": {
        "name": "OR",
        "note": "A second clock pulse inverts the shared NOR output. Read generation 128.",
        "description": "A second clock pulse inverts the shared NOR output. Single-use circuit. Select the inputs before starting."
      },
      "logic-nand": {
        "name": "NAND",
        "note": "Two simultaneous inputs form an AND block that intercepts the delayed readout glider. Read generation 120.",
        "description": "Two simultaneous inputs form an AND block that intercepts the delayed readout glider. Single-use circuit. Select the inputs before starting."
      },
      "logic-xnor": {
        "name": "XNOR",
        "note": "One input extinguishes the clock glider. Two inputs annihilate each other and let it pass. Read generation 80.",
        "description": "One input extinguishes the clock glider. Two inputs annihilate each other and let it pass. Single-use circuit. Select the inputs before starting."
      },
      "logic-xor": {
        "name": "XOR",
        "note": "A second clock glider inverts XNOR, giving the same output for inputs 01 and 10. Read generation 112.",
        "description": "A second clock glider inverts XNOR, giving the same output for inputs 01 and 10. Single-use circuit. Select the inputs before starting."
      },
      "logic-inhibit": {
        "name": "Inhibitor · A AND NOT B",
        "note": "Glider A reaches the output only if glider B does not extinguish it. Read generation 96.",
        "description": "Glider A reaches the output only if glider B does not extinguish it. Single-use circuit. Select the inputs before starting."
      },
      "logic-implies": {
        "name": "Implication · A ⇒ B",
        "note": "A clock glider inverts the output of the A AND NOT B inhibitor. Read generation 120.",
        "description": "A clock glider inverts the output of the A AND NOT B inhibitor. Single-use circuit. Select the inputs before starting."
      },
      "logic-block-memory": {
        "name": "One-bit memory · write and reset",
        "note": "At generation 60 the memory stores D. A delayed R=1 glider clears it. R=0 keeps the stored bit. Read generation 144.",
        "description": "At generation 60 the memory stores D. A delayed R=1 glider clears it. R=0 keeps the stored bit. Single-use circuit. Select the inputs before starting."
      }
    }
  },
  "ru": {
    "categories": {
      "ACTIVE SIGNAL": "АКТИВНЫЙ СИГНАЛ",
      "LARGE LOGIC CIRCUIT": "БОЛЬШАЯ ЛОГИЧЕСКАЯ СХЕМА",
      "GLIDER GUN": "ГЕНЕРАТОР ГЛАЙДЕРОВ",
      "LONG-LIVED PATTERN": "ДОЛГОЖИВУЩАЯ ФИГУРА",
      "SPACESHIP": "КОСМИЧЕСКИЙ КОРАБЛЬ",
      "LOGIC CIRCUIT": "ЛОГИЧЕСКАЯ СХЕМА",
      "LOGIC COMPONENT": "ЛОГИЧЕСКИЙ МОДУЛЬ",
      "SINGLE-USE LOGIC CIRCUIT": "ОДНОРАЗОВАЯ ЛОГИЧЕСКАЯ СХЕМА",
      "OSCILLATOR": "ОСЦИЛЛЯТОР",
      "PUFFER / MOVING TRAIL": "ПАФФЕР / ДВИЖУЩИЙСЯ СЛЕД",
      "STILL LIFE": "НЕПОДВИЖНАЯ ФИГУРА",
      "QUICK DEMO MACHINE": "МАШИНА С БЫСТРОЙ ДЕМОНСТРАЦИЕЙ"
    },
    "patterns": {
      "glider": {
        "name": "Глайдер",
        "note": "Период 4 · сдвиг на одну клетку по диагонали за цикл"
      },
      "block": {
        "name": "Блок",
        "note": "4 клетки · неподвижная фигура"
      },
      "beehive": {
        "name": "Улей",
        "note": "6 клеток · период 1"
      },
      "blinker": {
        "name": "Блинкер",
        "note": "Период 2 · простейший осциллятор"
      },
      "toad": {
        "name": "Жаба",
        "note": "Период 2 · чередование двух фаз"
      },
      "beacon": {
        "name": "Маяк",
        "note": "Период 2 · два взаимодействующих уголка"
      },
      "pulsar": {
        "name": "Пульсар",
        "note": "Период 3 · симметрия в четырёх направлениях"
      },
      "lwss": {
        "name": "Лёгкий космический корабль",
        "note": "Период 4 · движение по горизонтали со скоростью c/2"
      },
      "acorn": {
        "name": "Жёлудь",
        "note": "7 клеток · долгое и сложное развитие"
      },
      "rpentomino": {
        "name": "R-пентамино",
        "note": "5 клеток · порождает множество взаимодействующих фигур"
      },
      "gosper": {
        "name": "Глайдерная пушка Госпера",
        "note": "Период 30 · выпускает регулярный поток глайдеров"
      },
      "eater": {
        "name": "Поглотитель сигнала",
        "note": "Eater 1 · поглощает глайдер, приходящий с подходящего направления в нужной фазе"
      },
      "not-input-zero": {
        "name": "НЕ · вход 0 → выход 1",
        "note": "Считывание на поколении 64 · выходной глайдер в относительной области 29.29–31.31. Одноразовая схема."
      },
      "not-input-one": {
        "name": "НЕ · вход 1 → выход 0",
        "note": "Считывание на поколении 64 · столкновение гасит выход в относительной области 29.29–31.31. Одноразовая схема."
      },
      "and-latch": {
        "name": "И · входы 11 → выход 1",
        "note": "Считывание на поколении 64 · два входных сигнала создают блок в относительной области 21.21–22.22. Одноразовая схема."
      },
      "boat": {
        "name": "Лодка",
        "note": "5 клеток · асимметричная неподвижная фигура"
      },
      "ship": {
        "name": "Кораблик",
        "note": "6 клеток · неподвижная фигура с диагональной симметрией"
      },
      "loaf": {
        "name": "Буханка",
        "note": "7 клеток · устойчивая фигура с пустой серединой"
      },
      "tub": {
        "name": "Кадка",
        "note": "4 клетки · наименьший полый ромб"
      },
      "pond": {
        "name": "Пруд",
        "note": "8 клеток · квадратное кольцо с пустой серединой"
      },
      "snake": {
        "name": "Змейка",
        "note": "6 клеток · компактная неподвижная фигура"
      },
      "barge": {
        "name": "Баржа",
        "note": "6 клеток · вытянутый ромб"
      },
      "hat": {
        "name": "Шляпа",
        "note": "9 клеток · устойчивая фигура с широким основанием"
      },
      "pentadecathlon": {
        "name": "Пентадекатлон",
        "note": "Период 15 · вытянутый осциллятор"
      },
      "clock-small": {
        "name": "Малые часы",
        "note": "Период 2 · шесть клеток меняют ориентацию"
      },
      "koksgalaxy": {
        "name": "Галактика Кока",
        "note": "Период 8 · четыре рукава с вращательной симметрией"
      },
      "pinwheel": {
        "name": "Вертушка",
        "note": "Период 4 · большой симметричный ротор"
      },
      "fumarole": {
        "name": "Фумарола",
        "note": "Период 5 · компактный осциллятор с короткими вспышками"
      },
      "unix": {
        "name": "Unix",
        "note": "Период 6 · два блока поддерживают активную середину"
      },
      "mold": {
        "name": "Плесень",
        "note": "Период 4 · компактная фигура из 12 начальных клеток"
      },
      "jam": {
        "name": "Джем",
        "note": "Период 3 · небольшой асимметричный осциллятор"
      },
      "mazing": {
        "name": "Лабиринт",
        "note": "Период 4 · изменяющаяся середина в устойчивом окружении"
      },
      "caterer": {
        "name": "Кейтерер",
        "note": "Период 3 · 12 клеток в начальной фазе"
      },
      "phoenix": {
        "name": "Феникс",
        "note": "Период 2 · каждая живая клетка погибает в следующем поколении"
      },
      "mwss": {
        "name": "Средний космический корабль",
        "note": "Период 4 · сдвиг на две клетки по горизонтали за цикл, скорость c/2"
      },
      "hwss": {
        "name": "Тяжёлый космический корабль",
        "note": "Период 4 · самый большой из классической тройки, скорость c/2"
      },
      "copperhead": {
        "name": "Медноголовый",
        "note": "Период 10 · медленное движение вдоль оси со скоростью c/10"
      },
      "loafer": {
        "name": "Бездельник",
        "note": "Период 7 · медленный корабль со скоростью c/7"
      },
      "turtle": {
        "name": "Черепаха",
        "note": "Период 3 · движение вдоль оси со скоростью c/3 и короткая вспышка в хвосте"
      },
      "diehard": {
        "name": "Долгожитель",
        "note": "7 клеток · полностью исчезает на поколении 130"
      },
      "rabbits": {
        "name": "Кролики",
        "note": "9 клеток · долгое бурное развитие на просторном поле"
      },
      "bheptomino": {
        "name": "B-гептамино",
        "note": "7 клеток · порождает блоки, глайдеры и неподвижный кораблик"
      },
      "piheptomino": {
        "name": "Пи-гептамино",
        "note": "7 клеток в форме Π · активный участник многих реакций"
      },
      "herschel": {
        "name": "Гершель",
        "note": "7 клеток · короткоживущий сигнал для логических схем"
      },
      "switchengine": {
        "name": "Переключающий двигатель",
        "note": "8 клеток · неустойчивый движущийся двигатель с меняющимся следом"
      },
      "blom": {
        "name": "Блом",
        "note": "13 клеток · долгое разветвлённое развитие"
      },
      "lidka": {
        "name": "Лидка",
        "note": "15 клеток · долго развивается и требует много свободного места"
      },
      "simkinglidergun": {
        "name": "Глайдерная пушка Симкина со змейкой",
        "note": "Ядро повторяется каждые 240 поколений · глайдер выходит каждые 120"
      },
      "puffertrain": {
        "name": "Дымный паровоз",
        "note": "Движется и оставляет след из живых фигур · нужно просторное поле"
      },
      "blinker-puffer": {
        "name": "Фабрика блинкеров",
        "note": "Первый блинкер появляется на поколении 5, затем новый каждые 8 поколений. Движущийся генератор оставляет ряд осцилляторов.",
        "demoObservation": "Генератор сдвинулся влево и оставил 16 блинкеров."
      },
      "block-laying-switch-engine": {
        "name": "Подвижная фабрика блоков",
        "note": "Первый новый блок появляется на поколении 90. Движущийся двигатель добавляет восемь блоков 2 × 2 каждые 288 поколений.",
        "demoObservation": "Двигатель переместился по диагонали и добавил восемь неподвижных блоков."
      },
      "logic-nor": {
        "name": "ИЛИ-НЕ (NOR)",
        "note": "Любой из двух входных глайдеров может погасить общий тактовый импульс. Считывание на поколении 96.",
        "description": "Любой из двух входных глайдеров может погасить общий тактовый импульс. Одноразовая схема. Выберите входы перед запуском."
      },
      "logic-or": {
        "name": "ИЛИ (OR)",
        "note": "Второй тактовый импульс инвертирует общий выход ИЛИ-НЕ. Считывание на поколении 128.",
        "description": "Второй тактовый импульс инвертирует общий выход ИЛИ-НЕ. Одноразовая схема. Выберите входы перед запуском."
      },
      "logic-nand": {
        "name": "И-НЕ (NAND)",
        "note": "Два одновременных входа создают блок И, который перехватывает отложенный глайдер считывания. Считывание на поколении 120.",
        "description": "Два одновременных входа создают блок И, который перехватывает отложенный глайдер считывания. Одноразовая схема. Выберите входы перед запуском."
      },
      "logic-xnor": {
        "name": "Эквивалентность (XNOR)",
        "note": "Один вход гасит тактовый глайдер. Два входа гасят друг друга и пропускают его. Считывание на поколении 80.",
        "description": "Один вход гасит тактовый глайдер. Два входа гасят друг друга и пропускают его. Одноразовая схема. Выберите входы перед запуском."
      },
      "logic-xor": {
        "name": "Исключающее ИЛИ (XOR)",
        "note": "Второй тактовый глайдер инвертирует XNOR и даёт общий выход для входов 01 и 10. Считывание на поколении 112.",
        "description": "Второй тактовый глайдер инвертирует XNOR и даёт общий выход для входов 01 и 10. Одноразовая схема. Выберите входы перед запуском."
      },
      "logic-inhibit": {
        "name": "Ингибитор · A И НЕ B",
        "note": "Глайдер A достигает выхода, только если глайдер B его не погасил. Считывание на поколении 96.",
        "description": "Глайдер A достигает выхода, только если глайдер B его не погасил. Одноразовая схема. Выберите входы перед запуском."
      },
      "logic-implies": {
        "name": "Импликация · A ⇒ B",
        "note": "Тактовый глайдер инвертирует выход ингибитора A И НЕ B. Считывание на поколении 120.",
        "description": "Тактовый глайдер инвертирует выход ингибитора A И НЕ B. Одноразовая схема. Выберите входы перед запуском."
      },
      "logic-block-memory": {
        "name": "Память на один бит · запись и сброс",
        "note": "На поколении 60 в ячейке хранится D. Отложенный глайдер R=1 очищает её, а R=0 сохраняет записанный бит. Считывание на поколении 144.",
        "description": "На поколении 60 в ячейке хранится D. Отложенный глайдер R=1 очищает её, а R=0 сохраняет записанный бит. Одноразовая схема. Выберите входы перед запуском."
      }
    }
  },
  "uk": {
    "categories": {
      "ACTIVE SIGNAL": "АКТИВНИЙ СИГНАЛ",
      "LARGE LOGIC CIRCUIT": "ВЕЛИКА ЛОГІЧНА СХЕМА",
      "GLIDER GUN": "ГЕНЕРАТОР ГЛАЙДЕРІВ",
      "LONG-LIVED PATTERN": "ДОВГОЖИТЕЛЬ",
      "SPACESHIP": "КОСМІЧНИЙ КОРАБЕЛЬ",
      "LOGIC CIRCUIT": "ЛОГІЧНА СХЕМА",
      "LOGIC COMPONENT": "ЛОГІЧНИЙ МОДУЛЬ",
      "SINGLE-USE LOGIC CIRCUIT": "ОДНОРАЗОВА ЛОГІЧНА СХЕМА",
      "OSCILLATOR": "ОСЦИЛЯТОР",
      "PUFFER / MOVING TRAIL": "ПАФЕР / РУХОМИЙ СЛІД",
      "STILL LIFE": "СТАБІЛЬНА ФІГУРА",
      "QUICK DEMO MACHINE": "ШВИДКА МАШИНА"
    },
    "patterns": {
      "glider": {
        "name": "Глайдер",
        "note": "Період 4 · рух на 1 клітину по діагоналі"
      },
      "block": {
        "name": "Блок",
        "note": "4 клітини · нерухомий стан"
      },
      "beehive": {
        "name": "Вулик",
        "note": "6 клітин · період 1"
      },
      "blinker": {
        "name": "Блінкер",
        "note": "Період 2 · найпростіший осцилятор"
      },
      "toad": {
        "name": "Жаба",
        "note": "Період 2 · дві фази"
      },
      "beacon": {
        "name": "Маяк",
        "note": "Період 2 · дві взаємодіючі пари"
      },
      "pulsar": {
        "name": "Пульсар",
        "note": "Період 3 · симетрія у чотирьох напрямах"
      },
      "lwss": {
        "name": "Легкий космічний корабель",
        "note": "Період 4 · ортогональний рух c/2"
      },
      "acorn": {
        "name": "Жолудь",
        "note": "7 клітин · тривала складна еволюція"
      },
      "rpentomino": {
        "name": "R-пентаміно",
        "note": "5 клітин · насичене джерело взаємодій"
      },
      "gosper": {
        "name": "Гармата Госпера",
        "note": "Період 30 · потік глайдерів із фіксованою фазою"
      },
      "eater": {
        "name": "Поглинач сигналу",
        "note": "Eater 1 · поглинає глайдер лише за правильного напряму й фази"
      },
      "not-input-zero": {
        "name": "NOT · вхід 0 → вихід 1",
        "note": "Читати на ході 64 · вихідний глайдер у відносній області 29.29–31.31. Не безперервний вентиль."
      },
      "not-input-one": {
        "name": "NOT · вхід 1 → вихід 0",
        "note": "Читати на ході 64 · зіткнення гасить вихід у відносній області 29.29–31.31. Не безперервний вентиль."
      },
      "and-latch": {
        "name": "AND · входи 11 → вихід 1",
        "note": "Читати на ході 64 · два сигнали утворюють блок у відносній області 21.21–22.22. Не безперервний вентиль."
      },
      "boat": {
        "name": "Човен",
        "note": "5 клітин · асиметрична нерухома фігура"
      },
      "ship": {
        "name": "Кораблик",
        "note": "6 клітин · діагональна симетрія без руху"
      },
      "loaf": {
        "name": "Буханець",
        "note": "7 клітин · стійкий порожнистий контур"
      },
      "tub": {
        "name": "Діжка",
        "note": "4 клітини · найменший порожнистий ромб"
      },
      "pond": {
        "name": "Ставок",
        "note": "8 клітин · квадратне кільце з порожньою серединою"
      },
      "snake": {
        "name": "Змійка",
        "note": "6 клітин · компактний нерухомий стабілізатор"
      },
      "barge": {
        "name": "Баржа",
        "note": "6 клітин · видовжений ромб"
      },
      "hat": {
        "name": "Капелюх",
        "note": "9 клітин · стійка фігура з широкою основою"
      },
      "pentadecathlon": {
        "name": "Пентадекатлон",
        "note": "Період 15 · видовжений ритмічний осцилятор"
      },
      "clock-small": {
        "name": "Малий годинник",
        "note": "Період 2 · шість клітин змінюють орієнтацію"
      },
      "koksgalaxy": {
        "name": "Галактика Кока",
        "note": "Період 8 · обертальна симетрія чотирьох рукавів"
      },
      "pinwheel": {
        "name": "Вітряк",
        "note": "Період 4 · великий симетричний ротор"
      },
      "fumarole": {
        "name": "Фумарола",
        "note": "Період 5 · компактний осцилятор із короткими іскрами"
      },
      "unix": {
        "name": "Unix",
        "note": "Період 6 · два блоки підтримують активну середину"
      },
      "mold": {
        "name": "Пліснява",
        "note": "Період 4 · компактна форма з 12 початкових клітин"
      },
      "jam": {
        "name": "Джем",
        "note": "Період 3 · невеликий асиметричний осцилятор"
      },
      "mazing": {
        "name": "Лабіринт",
        "note": "Період 4 · змінна середина у стійкому оточенні"
      },
      "caterer": {
        "name": "Кейтерер",
        "note": "Період 3 · 12 клітин у початковій фазі"
      },
      "phoenix": {
        "name": "Фенікс",
        "note": "Період 2 · кожна жива клітина гине на наступному ході"
      },
      "mwss": {
        "name": "Середній космічний корабель",
        "note": "Період 4 · рух на 2 клітини по горизонталі, c/2"
      },
      "hwss": {
        "name": "Важкий космічний корабель",
        "note": "Період 4 · найбільший із класичної трійки, c/2"
      },
      "copperhead": {
        "name": "Мідноголовий",
        "note": "Період 10 · повільний ортогональний рух c/10"
      },
      "loafer": {
        "name": "Нероба",
        "note": "Період 7 · повільний корабель зі швидкістю c/7"
      },
      "turtle": {
        "name": "Черепаха",
        "note": "Період 3 · ортогональний рух c/3 і короткий хвостовий спалах"
      },
      "diehard": {
        "name": "Невмирущий",
        "note": "7 клітин · повністю зникає рівно на ході 130"
      },
      "rabbits": {
        "name": "Кролики",
        "note": "9 клітин · тривала бурхлива еволюція на просторому полі"
      },
      "bheptomino": {
        "name": "B-гептаміно",
        "note": "7 клітин · породжує блоки, глайдери та кораблик"
      },
      "piheptomino": {
        "name": "Пі-гептаміно",
        "note": "7 клітин у формі Π · активний будівельний блок реакцій"
      },
      "herschel": {
        "name": "Гершель",
        "note": "7 клітин · короткоживучий сигнал для логічних конструкцій"
      },
      "switchengine": {
        "name": "Перемикальний двигун",
        "note": "8 клітин · нестабільний рухомий двигун із мінливим слідом"
      },
      "blom": {
        "name": "Блом",
        "note": "13 клітин · розгалужена тривала еволюція"
      },
      "lidka": {
        "name": "Лідка",
        "note": "15 клітин · довга еволюція з великої порожньої області"
      },
      "simkinglidergun": {
        "name": "Гармата Сімкіна зі змійкою",
        "note": "Ядро повторюється через 240 ходів · глайдери виходять кожні 120"
      },
      "puffertrain": {
        "name": "Димний потяг",
        "note": "Рухається й залишає живий слід · потрібне просторе поле"
      },
      "blinker-puffer": {
        "name": "Фабрика блінкерів",
        "note": "Перший блінкер на 5-му ході, далі новий кожні 8 ходів. Рухомий генератор залишає ряд осциляторів.",
        "demoObservation": "Генератор зсунувся ліворуч і залишив 16 блінкерів.",
        "search": "швидка машина"
      },
      "block-laying-switch-engine": {
        "name": "Рухома фабрика блоків",
        "note": "Перший новий блок на 90-му ході. Рухомий двигун додає 8 блоків 2 × 2 за кожні 288 ходів.",
        "demoObservation": "Двигун перемістився по діагоналі й додав 8 нерухомих блоків.",
        "search": "швидка машина"
      },
      "logic-nor": {
        "name": "NOR",
        "note": "Два вхідні глайдери можуть по черзі загасити один тактовий імпульс. Зчитування на ході 96.",
        "description": "Два вхідні глайдери можуть по черзі загасити один тактовий імпульс. Одноразова схема: оберіть входи перед запуском."
      },
      "logic-or": {
        "name": "OR",
        "note": "Другий тактовий імпульс інвертує спільний вихід NOR. Зчитування на ході 128.",
        "description": "Другий тактовий імпульс інвертує спільний вихід NOR. Одноразова схема: оберіть входи перед запуском."
      },
      "logic-nand": {
        "name": "NAND",
        "note": "Тільки два одночасні входи записують блок AND, який перехоплює відкладений глайдер читання. Зчитування на ході 120.",
        "description": "Тільки два одночасні входи записують блок AND, який перехоплює відкладений глайдер читання. Одноразова схема: оберіть входи перед запуском."
      },
      "logic-xnor": {
        "name": "XNOR",
        "note": "Один вхід гасить тактовий глайдер. Два входи взаємно гасяться і пропускають його. Зчитування на ході 80.",
        "description": "Один вхід гасить тактовий глайдер. Два входи взаємно гасяться і пропускають його. Одноразова схема: оберіть входи перед запуском."
      },
      "logic-xor": {
        "name": "XOR",
        "note": "Другий тактовий глайдер інвертує XNOR та дає спільний вихід для 01 і 10. Зчитування на ході 112.",
        "description": "Другий тактовий глайдер інвертує XNOR та дає спільний вихід для 01 і 10. Одноразова схема: оберіть входи перед запуском."
      },
      "logic-inhibit": {
        "name": "Інгібітор · A І НЕ B",
        "note": "Глайдер A проходить до виходу, тільки коли глайдер B його не загасив. Зчитування на ході 96.",
        "description": "Глайдер A проходить до виходу, тільки коли глайдер B його не загасив. Одноразова схема: оберіть входи перед запуском."
      },
      "logic-implies": {
        "name": "Імплікація · A ⇒ B",
        "note": "Тактовий глайдер інвертує вихід інгібітора A І НЕ B. Зчитування на ході 120.",
        "description": "Тактовий глайдер інвертує вихід інгібітора A І НЕ B. Одноразова схема: оберіть входи перед запуском."
      },
      "logic-block-memory": {
        "name": "Пам’ять на 1 біт · запис і скидання",
        "note": "На ході 60 у комірці зберігається D. Відкладений глайдер R=1 очищає її; R=0 зберігає запис. Зчитування на ході 144.",
        "description": "На ході 60 у комірці зберігається D. Відкладений глайдер R=1 очищає її; R=0 зберігає запис. Одноразова схема: оберіть входи перед запуском."
      }
    }
  }
};
});
