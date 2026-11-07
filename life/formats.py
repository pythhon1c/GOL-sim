"""Bounded, strict state parsing. No import mutates a running engine."""
from __future__ import annotations

from dataclasses import dataclass
import json
import re
from typing import Iterable

from .config import integer, validate_grid

MAX_TEXT_BYTES = 64 << 20
MAX_IMPORT_CELLS = 2_000_000


@dataclass
class State:
    width: int
    height: int
    wrap: bool
    generation: int
    cells: list[tuple[int, int]]


def check_rule(rule: str) -> None:
    if not isinstance(rule, str) or rule.upper().replace(" ", "") not in ("B3/S23", "23/3"):
        raise ValueError("Only Conway's B3/S23 rule is supported")


def parse_json(text: str, max_cells: int = MAX_IMPORT_CELLS) -> State:
    data = json.loads(text)
    if not isinstance(data, dict):
        raise ValueError("State must be a JSON object")
    check_rule(data.get("rule", "B3/S23"))
    if data.get("version", 1) != 1:
        raise ValueError("Unsupported state version")
    base = data.get("coordinate_base", 0)
    if type(base) is not int or base not in (0, 1):
        raise ValueError("coordinate_base must be 0 or 1")
    width, height, wrap = data.get("width"), data.get("height"), data.get("wrap", False)
    validate_grid(width, height, wrap)
    generation = integer(data.get("generation", 0), 0, (1 << 64) - 1, "generation")
    raw = data.get("cells")
    if not isinstance(raw, list) or len(raw) > max_cells:
        raise ValueError(f"cells must be an array with at most {max_cells} entries")
    cells = []
    seen = set()
    for pair in raw:
        if not isinstance(pair, (list, tuple)) or len(pair) != 2:
            raise ValueError("Each cell must be [x,y]")
        x = integer(pair[0], base, width - 1 + base, "cell x") - base
        y = integer(pair[1], base, height - 1 + base, "cell y") - base
        key = (y << 32) | x
        if key in seen:
            raise ValueError("Duplicate live cell in state")
        seen.add(key)
        cells.append((x, y))
    return State(width, height, wrap, generation, cells)


def parse_rle(text: str, max_cells: int = MAX_IMPORT_CELLS) -> State:
    lines = text.splitlines()
    metadata = {}
    body_lines = []
    header = None
    for line in lines:
        line = line.strip()
        if not line:
            continue
        if line.startswith("#"):
            if line.startswith("#C LIFE "):
                for token in line[len("#C LIFE "):].split():
                    match = re.fullmatch(r"(width|height|origin_x|origin_y|wrap|generation)=(\d+)", token)
                    if not match or match[1] in metadata:
                        raise ValueError("Malformed or duplicated LIFE metadata")
                    metadata[match[1]] = int(match[2])
            continue
        if header is None:
            header = re.fullmatch(r"x\s*=\s*(\d+)\s*,\s*y\s*=\s*(\d+)(?:\s*,\s*rule\s*=\s*([^,]+))?", line, re.I)
            if not header:
                raise ValueError("Invalid RLE header")
        else:
            body_lines.append(line)
    if not header:
        raise ValueError("RLE header is missing")
    pattern_w, pattern_h = int(header[1]), int(header[2])
    if pattern_w < 0 or pattern_h < 0:
        raise ValueError("Invalid RLE dimensions")
    check_rule(header[3] or "B3/S23")
    width, height = metadata.get("width", max(1, pattern_w)), metadata.get("height", max(1, pattern_h))
    if metadata.get("wrap", 0) not in (0, 1):
        raise ValueError("RLE wrap must be 0 or 1")
    wrap = bool(metadata.get("wrap", 0))
    validate_grid(width, height, wrap)
    ox, oy = metadata.get("origin_x", 0), metadata.get("origin_y", 0)
    if ox + pattern_w > width or oy + pattern_h > height:
        raise ValueError("RLE pattern exceeds its field bounds")
    generation = integer(metadata.get("generation", 0), 0, (1 << 64) - 1, "generation")
    body = re.sub(r"\s+", "", "".join(body_lines))
    if not body.endswith("!") or body.count("!") != 1:
        raise ValueError("RLE must terminate with one !")
    cells = []
    x = y = pos = 0
    token_pattern = re.compile(r"(\d*)([bo$])")
    while pos < len(body) - 1:
        match = token_pattern.match(body, pos)
        if not match:
            raise ValueError(f"Invalid RLE token at offset {pos}")
        count = int(match[1] or "1")
        if count == 0:
            raise ValueError("RLE run lengths must be positive")
        token = match[2]
        if token == "$":
            y += count
            x = 0
            if y > pattern_h:
                raise ValueError("RLE row exceeds header height")
        else:
            if y >= pattern_h or x + count > pattern_w:
                raise ValueError("RLE run exceeds header dimensions")
            if token == "o":
                if len(cells) + count > max_cells:
                    raise ValueError(f"RLE exceeds {max_cells} live cells import limit")
                cells.extend((ox + xx, oy + y) for xx in range(x, x + count))
            x += count
        pos += len(match[0])
    return State(width, height, wrap, generation, cells)


def parse_state(text: str, format: str, max_cells: int = MAX_IMPORT_CELLS) -> State:
    if len(text.encode("utf-8")) > MAX_TEXT_BYTES:
        raise ValueError("State input exceeds 64 MiB")
    if format == "json":
        return parse_json(text, max_cells)
    if format == "rle":
        return parse_rle(text, max_cells)
    raise ValueError("format must be json or rle")


def json_chunks(width: int, height: int, wrap: bool, generation: int, cells: Iterable[tuple[int, int]]):
    header = {"format": "exact-life-state", "version": 1, "rule": "B3/S23", "coordinate_base": 1,
              "width": width, "height": height, "wrap": wrap, "generation": generation}
    yield json.dumps(header, separators=(",", ":"))[:-1] + ',"cells":['
    first = True
    buffer = []
    for x, y in cells:
        buffer.append(("" if first else ",") + f"[{x + 1},{y + 1}]")
        first = False
        if len(buffer) == 4096:
            yield "".join(buffer)
            buffer.clear()
    yield "".join(buffer) + "]}\n"


def rle_text(width: int, height: int, wrap: bool, generation: int, cells: Iterable[tuple[int, int]]) -> str:
    ordered = sorted(cells, key=lambda cell: (cell[1], cell[0]))
    prefix = f"#C LIFE width={width} height={height} origin_x=0 origin_y=0 wrap={int(wrap)} generation={generation}\n"
    prefix += f"x = {width}, y = {height}, rule = B3/S23\n"
    tokens = []
    x = y = 0
    def run(n, token):
        if n:
            tokens.append((str(n) if n > 1 else "") + token)
    index = 0
    while index < len(ordered):
        xx, yy = ordered[index]
        if yy != y:
            run(yy - y, "$")
            x, y = 0, yy
        run(xx - x, "b")
        end = index + 1
        while end < len(ordered) and ordered[end] == (ordered[end - 1][0] + 1, yy):
            end += 1
        run(end - index, "o")
        x = ordered[end - 1][0] + 1
        index = end
    tokens.append("!")
    # Wrap only between tokens: a numeric run length is never split.
    lines, line = [], ""
    for token in tokens:
        if len(line) + len(token) > 70:
            lines.append(line)
            line = ""
        line += token
    lines.append(line)
    return prefix + "\n".join(lines) + "\n"
