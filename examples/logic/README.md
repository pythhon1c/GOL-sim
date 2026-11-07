# Single-use NOT and AND circuits in Conway's Game of Life

Choose an input combination below, open its JSON or RLE file in the monitor, and advance exactly **64 generations**. Both formats describe the same live cells on a 64 × 64 board with dead cells outside its edges. Each input bit selects whether a particular glider is present at generation 0.

Coordinates on this page use **column.row, starting at 1**. Both corners of each output rectangle are included. The [machine-readable truth tables](truth-tables.json) use zero-based coordinates.

## NOT

A clock glider travels southeast toward the output. Input 0 leaves its path clear. Input 1 adds a northwest-bound glider that annihilates the clock glider. At generation 64, look in **29.29–31.31** for the five live cells of the clock glider.

| Input | Initial state | Live cells in the output | NOT |
| ---: | --- | ---: | ---: |
| 0 | [JSON](not/0.json) · [RLE](not/0.rle) | 5 | 1 |
| 1 | [JSON](not/1.json) · [RLE](not/1.rle) | 0 | 0 |

| Glider | Live cells at generation 0 |
| --- | --- |
| Clock | 13.15, 14.13, 14.15, 15.14, 15.15 |
| Input | 27.27, 27.28, 28.27, 28.29, 29.27 |

## AND with a stored output

When A and B are both 1, their gliders collide and leave a stable 2 × 2 block at **21.21–22.22**. Either glider alone passes through and leaves the rectangle empty by generation 64. The block persists until something else hits it.

| A | B | Initial state | Live cells in the output | AND |
| ---: | ---: | --- | ---: | ---: |
| 0 | 0 | [JSON](and/00.json) · [RLE](and/00.rle) | 0 | 0 |
| 0 | 1 | [JSON](and/01.json) · [RLE](and/01.rle) | 0 | 0 |
| 1 | 0 | [JSON](and/10.json) · [RLE](and/10.rle) | 0 | 0 |
| 1 | 1 | [JSON](and/11.json) · [RLE](and/11.rle) | 4 | 1 |

| Input | Live cells at generation 0 |
| --- | --- |
| A | 13.15, 14.13, 14.15, 15.14, 15.15 |
| B | 28.28, 28.29, 29.28, 29.30, 30.28 |

Each circuit processes one input combination. Reload an initial state to run another case. The collisions were constructed and verified for this project using the classic B3/S23 rules. The [tests](../../tests/test_logic_patterns.py) compare all six cases against an independent cell-by-cell simulation at every generation through 64, check the final live cells, and follow the AND block for another 64 generations. See the [extended examples](EXTENDED.md) for more gates and a one-bit memory.
