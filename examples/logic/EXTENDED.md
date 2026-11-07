# Single-use glider circuits in Conway's Game of Life

Choose the input pair `00`, `01`, `10` or `11` in the circuit's folder and open its JSON or RLE file. Each file starts a 112 × 112 board at generation 0 with dead cells beyond its edges. An input of 1 adds a five-cell glider in a fixed position. An input of 0 leaves that position empty. Any clock gliders are present for every input pair.

Advance to the generation in the table and inspect the indicated rectangle. Its corners use one-based **column.row** coordinates and include both endpoints. A complete five-cell glider, or a four-cell block in the memory example, represents 1. An empty rectangle represents 0. Gliders elsewhere on the board can continue moving after readout. Load the next input pair to run another experiment.

| Circuit | Outputs for 00, 01, 10, 11 | Read generation | Output rectangle | How the output forms |
| --- | --- | ---: | --- | --- |
| [NOR](nor/) | 1, 0, 0, 0 | 96 | 43.43–45.45 | Either input can extinguish the clock glider. |
| [OR](or/) | 0, 1, 1, 1 | 128 | 33.33–35.35 | The NOR output extinguishes a second clock glider only for input 00. |
| [NAND](nand/) | 1, 1, 1, 0 | 120 | 55.41–57.43 | Input 11 builds an AND block that intercepts the delayed readout glider. |
| [XNOR](xnor/) | 1, 0, 0, 1 | 80 | 50.24–52.26 | A single input extinguishes the clock glider. Two inputs annihilate each other and leave its path clear. |
| [XOR](xor/) | 0, 1, 1, 0 | 112 | 32.40–34.42 | Another glider inverts the XNOR output. For 01 and 10, the output glider follows the same track. |
| [Inhibitor (A AND NOT B)](inhibit/) | 0, 0, 1, 0 | 96 | 43.43–45.45 | A travels toward the output. If present, B extinguishes A. Input 00 starts with a completely empty board. |
| [Implication (A ⇒ B)](implies/) | 1, 1, 0, 1 | 120 | 19.19–21.21 | A clock glider inverts the inhibitor output. |
| [One-bit memory (write D, reset R)](block-memory/) | 0, 0, 1, 0 | 144 | 51.51–52.52 | This location stores D at generation 60. A delayed reset glider clears the block when R is 1. |

The memory example performs one write followed by an optional reset. When D is 1, the data glider collides with the clock glider to leave a block. When D is 0, the write leaves the output empty. With R set to 0, a written block persists at the same location.

The [manifest](extended-truth-tables.json) gives the exact initial cells, output cells, and velocity of each output signal in zero-based coordinates. The [generator](build_extensions.py) constructs the starting states from the geometry of the gliders. The [tests](../../tests/test_logic_extensions.py) compare the Rust engine with an independent cell-by-cell B3/S23 simulation at every generation. They also check moving signals on the same track four and eight generations after readout and follow the stored memory bit for 64 additional generations.

The coordinates for these examples were constructed and verified for this project. The XNOR geometry came from a search over positions and phases of three gliders. XOR uses that geometry and adds an inverter. The [LifeWiki tutorial on signal technology](https://conwaylife.com/wiki/Tutorials/General_technology) describes related techniques for cancelling gliders and building gates.
