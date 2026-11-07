# Third-party materials and pattern sources

## License scope

The original application uses PolyForm Noncommercial 1.0.0. That license does
not replace licenses for third-party patterns, their adaptations, or installed
dependencies. See NOTICE and licenses/CC-BY-SA-3.0.txt.

The public export contains 59 catalog entries. It excludes all 13 imports with
unconfirmed redistribution permission described below: the digital clock, four
large Golly devices, and eight Golly-derived fast machines. Their descriptions
and source links are retained as provenance records only; the public bundle
does not contain those imported cell states or asset wrappers. The local
installation may retain them. See publication-policy.json and PUBLICATION.md.

All 36 Life Lexicon-derived entries, their converted cell data, names,
descriptions and translations remain under CC BY-SA 3.0. The project's
noncommercial restriction does not restrict rights granted by that license.

Python and Rust dependencies are installed separately from their official
registries and retain upstream notices. licenses/DEPENDENCIES.json lists the
locked versions and declared licenses. No third-party simulator implementation
is bundled with the application.


## Digital clock (AM + PM)

The bundled `web/patterns/digital-clock.rle` is the AM + PM variation of the autonomous Conway B3/S23 digital clock by **dim**, published March 2017.

- Author's design and explanation: https://codegolf.stackexchange.com/questions/88783/build-a-digital-clock-in-conways-game-of-life
- Original downloadable AM + PM data: https://gist.githubusercontent.com/anonymous/9d7468755dd76a35d93beeb5c0a5bdcf/raw/3295717faf24e8911048bcb69d4b6c8505d24330/gistfile1.txt
- Downloaded on 2026-11-05. The RLE data has not been modified.
- Dimensions of this variation: 10,284 columns × 6,796 rows.
- Initial population of this variation: 272,802 (verified by both independent parsers).
- SHA-256: `8e5c37df64da46ce6f1aa1b90220981257875254682c49c898c2ce985515d0cb`.
- One displayed minute represents 11,520 Life generations, not wall-clock time.

Stack Exchange contributions from this period are published under CC BY-SA 3.0 (https://creativecommons.org/licenses/by-sa/3.0/). The linked anonymous Gist does not contain a separate explicit license; this provenance is recorded rather than assuming the license of a simulator applies to every pattern. The public exporter excludes this clock until its redistribution permission is documented.

## Small standard patterns

The basic still lifes, oscillators, spaceships and glider gun in the editor are conventional B3/S23 patterns represented as RLE data. Their names and pattern-specific notes are included in the catalog. No Golly or LifeViewer implementation code is included.

UX and format references:

- https://golly.sourceforge.io/Help/edit.html
- https://golly.sourceforge.io/Help/formats.html
- https://github.com/rowett/lifeviewer

## Expanded catalog: Stephen Silver / Dave Greene Life Lexicon

The 34 additional catalog entries in `web/patterns.js` were adapted from the
first ASCII pattern diagram in the corresponding **Life Lexicon** entry.
The Lexicon is by **Stephen A. Silver**, with later updates by **Dave Greene**
and the contributors credited in its introduction. Original pattern discoverers
are credited in the individual linked entries. The source used here is Golly's
copy of that original reference document, retrieved through the explicitly
identified AlephAlpha unofficial Golly mirror, at immutable revision
`2cf06330cab58dccec085724067e17ddd7a56905` on 2026-11-05.

- Source introduction, contributor credits and COPYING terms:
  https://github.com/AlephAlpha/golly/blob/2cf06330cab58dccec085724067e17ddd7a56905/Help/Lexicon/lex.htm
- Golly project: https://golly.sourceforge.io/
- License: **Creative Commons Attribution-ShareAlike 3.0 Unported**,
  https://creativecommons.org/licenses/by-sa/3.0/

The Lexicon identifies its copyright as Stephen Silver, 1997–2018, and allows
copying, modification and distribution under CC BY-SA 3.0 with credit to its
contributors and modifiers. The adapted pattern data in this expanded catalog
is provided under that same license. Modifications by the GOL sim project:
ASCII diagrams converted into RLE without changing the initial live cells;
localized names and concise descriptions added; dimensions, population and
independently tested behavior metadata added. No Golly simulator code was used.
Each catalog entry's `source` links to the specific Lexicon source file/entry.

Adapted entries: boat, ship, loaf, tub, pond, snake, barge, hat,
pentadecathlon, clock (catalog ID `clock-small`), Kok's galaxy, pinwheel,
fumarole, unix, mold, jam, mazing, caterer, phoenix, MWSS, HWSS, copperhead,
loafer, turtle, diehard, rabbits, B-heptomino, pi-heptomino, Herschel,
switch engine, blom, Lidka, Simkin glider gun, and puffer train.

The included Simkin example is the Lexicon's snake-stabilized pseudo-period
form: its exact source region repeats after **240** generations while its
glider output has a **120**-generation cadence. The catalog describes this
specific bundled form rather than assigning the generic gun period to every
cell. The tests verify three 240-generation source repetitions and emitted
population increments. Still lifes, oscillator periods and spaceship
displacements are also checked with an independent unbounded scalar B3/S23
reference in `tests/pattern-catalog.test.cjs`.

## Computing devices from Golly

- **OTCA metapixel blinker** (`otca-blinker.rle`). Brice Due built the OTCA metapixel in 2005–2006. GOL sim assembled 25 of the physical B3/S23 metacells from the Golly galaxy pattern into a 5 × 5 field with a horizontal blinker and an outer ring of OFF metacells. The saved state includes 35,328 generations of warm-up so the blinker changes orientation after the next 35,328 generations. [Golly source pattern at the pinned mirror revision](https://github.com/AlephAlpha/golly/blob/2cf06330cab58dccec085724067e17ddd7a56905/Patterns/HashLife/Metacell/metapixel-galaxy.mc.gz)
- **Three-digit hexadecimal counter** (`hex-counter.rle`). Adam P. Goucher (Calcyman) built the seven-segment counter in 2008. GOL sim expanded the original Macrocell tree, translated its occupied bounding box to the origin and encoded the same cells as RLE. The author’s circuit notes accompany the pattern. [Original Golly archive file](https://golly.sourceforge.io/patterns/hex-3digit-7seg.mc.gz)
- **Programmable constructor with memory loop** (`constructor-memory-loop.rle`). Dave Greene built the pattern in 2004 and revised it in 2006, using Paul Chapman’s prototype programmable constructor. The RLE preserves the original file and author’s notes byte for byte after an added line of field metadata. [Golly source pattern at the pinned mirror revision](https://github.com/AlephAlpha/golly/blob/2cf06330cab58dccec085724067e17ddd7a56905/Patterns/Life/Signal-Circuitry/constructor-memory-loop.rle)
- **Pi calculator** (`pi-calculator.rle`). Adam P. Goucher built this machine in 2010 to compute and print decimal digits of π. GOL sim expanded the original two-state Macrocell tree, translated its occupied bounding box to the origin and encoded every live cell as B3/S23 RLE. [Original Golly archive file](https://golly.sourceforge.io/patterns/pi.mc)

The files in `web/patterns/` include field margins for finite-board imports. For the standalone editor, `examples/devices/build_catalog.py` generates a matching `.js` file that loads the selected device’s RLE text locally. It also generates catalog thumbnails from the initial live cells. The validation report records SHA-256 hashes of the downloaded sources and bundled RLE files, the margins and the exact OTCA assembly recipe. [Device validation report](tests/fixtures/devices-validation.json)

Golly credits the pattern authors who permitted Golly to distribute their work. Its GPL-2.0-or-later notice applies to the Golly program. The four source files and the online archive leave individual pattern license terms unspecified. The CC BY-SA terms documented above cover the separately sourced Life Lexicon entries. [Golly credits](https://golly.sourceforge.io/Help/credits.html) · [Golly program license](https://github.com/AlephAlpha/golly/blob/2cf06330cab58dccec085724067e17ddd7a56905/docs/License.html) · [Golly archive](https://golly.sourceforge.io/patterns/golly-access.html)

The optional macro-blinker verification script takes a separately supplied copy of Fabian Hemmer’s HashLife implementation, `copy/life`, at revision `924c90afb529ad5d417f11d795bc1b400fff8d18`. It verifies the source checksum before replaying four macrosteps. This dependency is used only by the independent verification command. The upstream code carries the BSD 2-Clause license, copyright 2012–2018 Fabian Hemmer. [Pinned reference source](https://github.com/copy/life/blob/924c90afb529ad5d417f11d795bc1b400fff8d18/life.js) · [Upstream license](https://github.com/copy/life/blob/924c90afb529ad5d417f11d795bc1b400fff8d18/LICENSE) · `examples/devices/verify-macro.cjs` (local optional verification only)

## Fast machines

The ten fast-machine additions use the same pinned Golly mirror revision,
`2cf06330cab58dccec085724067e17ddd7a56905`, retrieved on 2026-11-06.
Original pattern authors and source-specific adaptations are listed below.

- **Two-glider eater synthesis** (`two-glider-eater`). Extracted from the table of 71 two-glider collisions compiled by **Jason Summers on 29 January 2005**. The source credits Summers as the compiler. GOL sim selected the ten living cells inside the zero-based source rectangle `x=56, y=236, width=5, height=11`, translated that rectangle to the origin and encoded it as a standalone RLE. The selected collision produces a stable seven-cell eater after 21 generations. [Pinned synthesis collection](https://github.com/AlephAlpha/golly/blob/2cf06330cab58dccec085724067e17ddd7a56905/Patterns/Life/Syntheses/two-glider-collisions.rle)
- **Blinker puffer** (`blinker-puffer`). **Robert Wainwright, 1984**. Adapted from the first ASCII diagram in the Life Lexicon’s “blinker puffer” entry. GOL sim converted the 37-cell, 9 × 18 diagram into RLE, preserving its initial phase. [Pinned Lexicon entry](https://github.com/AlephAlpha/golly/blob/2cf06330cab58dccec085724067e17ddd7a56905/Help/Lexicon/lex_b.htm#blinkerpuffer)
- **Block-laying switch engine** (`block-laying-switch-engine`). The Life Lexicon credits the stabilized block-laying type to **Charles Corderman**. Adapted from the first diagram in its “stabilized switch engine” entry. The selected 104-cell, 60 × 60 source phase includes the engine and its existing zigzag block trail. GOL sim converted the ASCII diagram into RLE. [Pinned Lexicon entry](https://github.com/AlephAlpha/golly/blob/2cf06330cab58dccec085724067e17ddd7a56905/Help/Lexicon/lex_s.htm#stabilizedswitchengine)
- **Spacefiller** (`spacefiller`). **Hartmut Holzwart, 4 November 1998**, from **Alan Hensel’s lifebc collection**. The source credits Hensel with the original idea and middle section, Holzwart with the original construction and top/bottom stretchers, and **David Bell, Alan Hensel and Tim Coe** with size optimization. The pinned file also records an update dated 16 May 2022 and links to its source discussion. All of these author notes accompany the bundled pattern. [Pinned source and update reference](https://github.com/AlephAlpha/golly/blob/2cf06330cab58dccec085724067e17ddd7a56905/Patterns/Life/Breeders/spacefiller.rle)
- **Golly ticker** (`golly-ticker`). **Brice Due, September 2005**, modified by **Dave Greene, September 2006**. Its memory-loop design is based on **Alan Hensel’s 1994 Decimal Counter**. The source also credits **Jan Kok’s 1971 Kok’s Galaxy oscillator**, whose phases form parts of the displayed lettering. The bundled file retains the GollyTicker-Take4 phase and its author’s explanation. [Pinned source](https://github.com/AlephAlpha/golly/blob/2cf06330cab58dccec085724067e17ddd7a56905/Patterns/Life/Guns/golly-ticker.rle)
- **Period-416 2c/5 spaceship gun** (`2c5-spaceship-gun-p416`). **Dave Greene, 11 April 2003**. The source credits the spaceship synthesis mainly to **Noam Elkies** and describes the four construction salvos driven by the gun array. [Pinned source](https://github.com/AlephAlpha/golly/blob/2cf06330cab58dccec085724067e17ddd7a56905/Patterns/Life/Guns/2c5-spaceship-gun-p416.rle)
- **Blockstacker** (`blockstacker`). **Jason Summers, 28 August 1999**, from the **jslife pattern collection**. The original comments identify its growing line of blocks and growth rate. [Pinned source](https://github.com/AlephAlpha/golly/blob/2cf06330cab58dccec085724067e17ddd7a56905/Patterns/Life/Miscellaneous/blockstacker.rle)
- **Period-30 Heisenburp** (`heisenburp-30`). **David I. Bell**, from **Alan Hensel’s lifebc collection**. The source describes the detector and its demonstration with three input gliders. The accompanying author notes are retained. [Pinned source](https://github.com/AlephAlpha/golly/blob/2cf06330cab58dccec085724067e17ddd7a56905/Patterns/Life/Signal-Circuitry/heisenburp-30.rle)
- **Period-210 loafer gun** (`loafer-gun-p210`). **Shannon Omick, 18 February 2013**. The bundled source phase includes the output-lane eater. Its header links to the author’s original announcement. [Pinned source](https://github.com/AlephAlpha/golly/blob/2cf06330cab58dccec085724067e17ddd7a56905/Patterns/Life/Guns/loafer-gun-p210.rle) · [Original announcement](https://conwaylife.com/forums/viewtopic.php?f=2&t=1031#p7466)
- **Period-90 rake factory** (`p90-rake-factory`). **Dieter Leithner, 11 November 1994**. The source describes a stationary gun producing a period-20 space rake every 90 generations. The bundled file retains the source phase and notes. [Pinned source](https://github.com/AlephAlpha/golly/blob/2cf06330cab58dccec085724067e17ddd7a56905/Patterns/Life/Breeders/p90-rake-factory.rle)

For the seven complete source RLEs, GOL sim adds a leading `#C LIFE`
metadata line and retains the original RLE content and author comments.
For the synthesis crop and two Lexicon diagrams, the extraction and format
conversion are described above. Finite-board placement uses empty margins
around the initial pattern. The validation report records the exact field
dimensions and placement for each bundled file. Localized catalog names,
descriptions, thumbnails, local JavaScript asset wrappers and measured
demonstration timings were added by GOL sim. [Fast-machine validation report](tests/fixtures/fast-machines-validation.json)

The two Life Lexicon adaptations remain under **CC BY-SA 3.0 Unported**, with
credit to Stephen A. Silver, Dave Greene, the Lexicon contributors and the
pattern discoverers named above. Their ASCII-to-RLE adaptations and catalog
descriptions are provided under that same license. [Lexicon credits and copying terms](https://github.com/AlephAlpha/golly/blob/2cf06330cab58dccec085724067e17ddd7a56905/Help/Lexicon/lex.htm) · [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)

The eight other entries follow the Golly pattern attribution policy described
in the preceding section. Their source files preserve author credit while
leaving individual pattern license terms unspecified. Golly’s program license
and the separate Life Lexicon license retain their respective scopes. [Golly credits](https://golly.sourceforge.io/Help/credits.html) · [Golly program license](https://github.com/AlephAlpha/golly/blob/2cf06330cab58dccec085724067e17ddd7a56905/docs/License.html)
