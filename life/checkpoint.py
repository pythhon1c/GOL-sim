"""Segmented snapshots with atomic manifests and ownership-scoped retention."""
from __future__ import annotations

import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import time
import uuid

from .config import integer, validate_grid
from .formats import check_rule

FORMAT = "exact-life-checkpoint"
NAME = re.compile(r"life-\d{20}-[0-9a-f]{12}")


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1 << 20):
            digest.update(block)
    return digest.hexdigest()


class Checkpoints:
    def __init__(self, config: dict, root: Path):
        self.config = config.copy()
        location = Path(config["directory"])
        self.directory = location if location.is_absolute() else root / location
        self.directory.mkdir(parents=True, exist_ok=True)
        self.directory = self.directory.resolve()

    def _owned(self):
        snapshots = []
        for manifest in self.directory.glob("life-*.json"):
            if not NAME.fullmatch(manifest.stem) or manifest.is_symlink():
                continue
            try:
                if manifest.stat().st_size > 16 << 20:
                    continue
                data = json.loads(manifest.read_text("utf-8"))
                if not isinstance(data, dict) or data.get("format") != FORMAT or data.get("id") != manifest.stem:
                    continue
                paths = [manifest]
                seen = set()
                for part in data["segments"]:
                    name = part["file"]
                    if not re.fullmatch(re.escape(manifest.stem) + r"-\d{6}\.bin\.gz", name):
                        raise ValueError("Unsafe segment filename")
                    if name in seen:
                        raise ValueError("Duplicate checkpoint segment")
                    seen.add(name)
                    path = self.directory / name
                    if path.resolve().parent != self.directory or path.is_symlink():
                        raise ValueError("Unsafe segment path")
                    paths.append(path)
                size = sum(path.stat().st_size for path in paths)
                snapshots.append((manifest.stat().st_mtime_ns, size, paths))
            except (OSError, ValueError, KeyError, TypeError):
                continue
        return sorted(snapshots)

    def _storage_bytes(self):
        # Incomplete files from an interrupted writer count toward quota too.
        # Retention deletes only manifests/segments it has positively identified above.
        pattern = re.compile(r"life-\d{20}-[0-9a-f]{12}(?:\.json(?:\.tmp)?|-\d{6}\.bin\.gz(?:\.tmp)?)")
        return sum(path.stat().st_size for path in self.directory.iterdir()
                   if pattern.fullmatch(path.name) and path.is_file() and not path.is_symlink())

    def write(self, engine, cancel_event=None) -> dict:
        if cancel_event is not None and cancel_event.is_set():
            raise RuntimeError("Checkpoint cancelled during shutdown")
        quota = self.config["quota_mb"] << 20
        segment_limit = self.config["segment_mb"] << 20
        raw_limit = ((segment_limit - max(65536, segment_limit // 100)) // 8) * 8
        count = engine.population
        estimate = count * 8 + max(1, (count * 8 + raw_limit - 1) // raw_limit) * 65536 + 65536
        if estimate > quota:
            raise ValueError("Checkpoint would exceed its disk quota; increase quota or reduce population")
        owned = self._owned()
        # A complete previous snapshot survives until its replacement is durable.
        current_size = self._storage_bytes()
        while len(owned) > 1 and current_size + estimate > quota:
            _, size, paths = owned.pop(0)
            for path in paths:
                path.unlink(missing_ok=True)
            current_size -= size
        if current_size + estimate > quota:
            raise ValueError("Disk quota cannot hold the current checkpoint plus its atomic replacement")
        identity = f"life-{engine.generation:020d}-{uuid.uuid4().hex[:12]}"
        manifest_path = self.directory / (identity + ".json")
        created = []
        segments = []
        iterator = iter(engine.iter_packed())
        emitted = 0
        started = time.monotonic()
        rate = self.config["write_mb_per_second"] * (1 << 20)
        try:
            while emitted < count:
                filename = f"{identity}-{len(segments):06d}.bin.gz"
                final_path = self.directory / filename
                temporary = final_path.with_suffix(final_path.suffix + ".tmp")
                created.append(temporary)
                segment_cells = 0
                with temporary.open("wb") as raw:
                    with gzip.GzipFile(fileobj=raw, mode="wb", compresslevel=1, mtime=0) as stream:
                        while segment_cells * 8 < raw_limit and emitted < count:
                            if cancel_event is not None and cancel_event.is_set():
                                raise RuntimeError("Checkpoint cancelled during shutdown")
                            n = min(8192, (raw_limit - segment_cells * 8) // 8, count - emitted)
                            values = [next(iterator) for _ in range(n)]
                            stream.write(struct.pack("<" + "Q" * n, *values))
                            segment_cells += n
                            emitted += n
                            # Bound write throughput with a 64 KiB burst and compression-overhead headroom.
                            target = emitted * 8 * 1.02 / rate
                            while (delay := target - (time.monotonic() - started)) > 0:
                                if cancel_event is not None:
                                    if cancel_event.wait(min(delay, 0.25)):
                                        raise RuntimeError("Checkpoint cancelled during shutdown")
                                else:
                                    time.sleep(min(delay, 0.25))
                    raw.flush()
                    os.fsync(raw.fileno())
                size = temporary.stat().st_size
                if size > segment_limit:
                    raise ValueError("Compressed checkpoint segment exceeded its size limit")
                os.replace(temporary, final_path)
                created.remove(temporary)
                created.append(final_path)
                segments.append({"file": filename, "bytes": size, "cells": segment_cells, "sha256": file_hash(final_path)})
            metadata = {"format": FORMAT, "version": 1, "id": identity, "rule": "B3/S23",
                        "width": engine.width, "height": engine.height, "wrap": engine.wrap,
                        "generation": engine.generation, "population": count,
                        "encoding": "uint64-le-y32-x32-gzip", "coordinate_base": 0, "segments": segments}
            temporary_manifest = manifest_path.with_suffix(".json.tmp")
            created.append(temporary_manifest)
            with temporary_manifest.open("w", encoding="utf-8") as stream:
                json.dump(metadata, stream, separators=(",", ":"))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary_manifest, manifest_path)
            created.remove(temporary_manifest)
            return {"path": str(manifest_path), "generation": engine.generation,
                    "population": count, "bytes": sum(part["bytes"] for part in segments) + manifest_path.stat().st_size,
                    "segments": len(segments)}
        except BaseException:
            for path in created:
                path.unlink(missing_ok=True)
            raise


def checkpoint_metadata(path: Path) -> dict:
    if path.stat().st_size > 16 << 20:
        raise ValueError("Checkpoint manifest is too large")
    data = json.loads(path.read_text("utf-8"))
    if (not isinstance(data, dict) or data.get("format") != FORMAT
            or type(data.get("version")) is not int or data["version"] != 1
            or data.get("encoding") != "uint64-le-y32-x32-gzip"):
        raise ValueError("Unsupported checkpoint manifest")
    integer(data.get("coordinate_base", 0), 0, 0, "coordinate_base")
    check_rule(data.get("rule"))
    validate_grid(data.get("width"), data.get("height"), data.get("wrap"))
    integer(data.get("generation"), 0, (1 << 64) - 1, "generation")
    integer(data.get("population"), 0, data["width"] * data["height"], "population")
    if not isinstance(data.get("segments"), list) or len(data["segments"]) > 1_000_000:
        raise ValueError("Invalid checkpoint segments")
    count = 0
    names = set()
    for part in data["segments"]:
        if not isinstance(part, dict):
            raise ValueError("Invalid checkpoint segment")
        name = part.get("file")
        if not isinstance(name, str) or not name or Path(name).name != name or "/" in name or "\\" in name:
            raise ValueError("Unsafe checkpoint segment path")
        if name in names:
            raise ValueError("Duplicate checkpoint segment")
        names.add(name)
        if not isinstance(part.get("sha256"), str) or not re.fullmatch(r"[a-f0-9]{64}", part["sha256"]):
            raise ValueError("Invalid checkpoint segment checksum")
        integer(part.get("bytes"), 1, (1 << 64) - 1, "segment bytes")
        count += integer(part.get("cells"), 0, data["population"], "segment cells")
    if count != data["population"]:
        raise ValueError("Checkpoint population metadata mismatch")
    return data


def load_checkpoint_into(path: Path, engine, metadata: dict) -> None:
    parent = path.resolve().parent
    for segment in metadata["segments"]:
        name = segment.get("file", "")
        if not isinstance(name, str) or Path(name).name != name or "/" in name or "\\" in name:
            raise ValueError("Unsafe checkpoint segment path")
        part = parent / name
        if part.resolve().parent != parent or part.is_symlink():
            raise ValueError("Unsafe checkpoint segment path")
        expected_cells = integer(segment.get("cells"), 0, metadata["population"], "segment cells")
        if part.stat().st_size != segment.get("bytes") or file_hash(part) != segment.get("sha256"):
            raise ValueError("Checkpoint segment integrity failure")
        emitted = 0
        with gzip.open(part, "rb") as stream:
            while block := stream.read(65536):
                if len(block) % 8:
                    raise ValueError("Truncated checkpoint cell")
                emitted += len(block) // 8
                if emitted > expected_cells:
                    raise ValueError("Checkpoint decompressed data exceeds declared size")
                values = struct.unpack("<" + "Q" * (len(block) // 8), block)
                engine.import_packed(values)
        if emitted != expected_cells:
            raise ValueError("Checkpoint segment cell count mismatch")
    if engine.population != metadata["population"]:
        raise ValueError("Checkpoint contains duplicate or missing cells")
    engine.generation = metadata["generation"]
