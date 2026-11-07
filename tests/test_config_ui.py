"""Check the visual editor's exported configuration against the actual backend."""
from __future__ import annotations

import copy
import json
from pathlib import Path
import subprocess
import tomllib

import pytest

from life.config import DEFAULTS, merge_config


ROOT = Path(__file__).resolve().parents[1]
BRIDGE = r"""
const C = require('./web/config-editor.js');
let text = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', part => text += part);
process.stdin.on('end', () => {
  const {action, data, base} = JSON.parse(text);
  let result;
  if (action === 'schema') result = {defaults:C.DEFAULTS, fields:C.FIELDS};
  else if (action === 'toml') result = C.toTOML(data);
  else if (action === 'validate') result = C.validateConfig(data);
  else if (action === 'plan') result = C.buildChangePlan(base, data);
  else if (action === 'merge') result = C.mergeConfigDraft(base, data.draft, data.server);
  else if (action === 'parse') result = C.parseConfigJSON(data);
  process.stdout.write(JSON.stringify(result));
});
"""


def editor(action, data=None, base=None):
    result = subprocess.run(
        ["node", "-e", BRIDGE], cwd=ROOT, text=True, encoding="utf-8",
        input=json.dumps({"action": action, "data": data, "base": base}),
        capture_output=True, check=True,
    )
    return json.loads(result.stdout)


def test_visual_schema_covers_backend_settings():
    schema = editor("schema")
    fields = {field["path"]: field for field in schema["fields"]}
    for section, settings in DEFAULTS.items():
        for key in settings:
            field = fields[f"{section}.{key}"]
            assert field["label"]
            assert len(field["description"]) >= 15
            assert field["mode"] in {"live", "restart", "advisory"}
    assert merge_config(schema["defaults"]) == DEFAULTS


def test_visual_toml_round_trip_preserves_every_setting_and_uint64():
    config = copy.deepcopy(DEFAULTS)
    config["grid"].update(width=6400, height=4700, wrap=True)
    config["initial"].update(
        path='C:\\Life "figures"\\Café.rle', random=True,
        seed="18446744073709551615", density=0.27,
        rectangle={"top_left": "100.200", "bottom_right": "4000.3000"},
    )
    config["engine"].update(threads=4, tile_size=256, memory_mb=1024)
    config["checkpoints"].update(directory="saved/Résumé", mode="strict")
    exported = tomllib.loads(editor("toml", config))
    assert merge_config(exported) == merge_config(config)


def test_visual_change_plan_keeps_restart_edits_out_of_live_patch():
    base = copy.deepcopy(DEFAULTS)
    draft = copy.deepcopy(base)
    draft["engine"].update(threads=4, cpu_max_percent=60)
    draft["grid"]["width"] = 8192
    draft["initial"]["seed"] = "18446744073709551615"
    draft["checkpoints"]["min_interval_seconds"] = 1200
    draft["display"]["gradient_levels"] = 64
    plan = editor("plan", draft, base)
    assert plan["livePatch"] == {
        "engine": {"cpu_max_percent": 60},
        "checkpoints": {"min_interval_seconds": 1200},
        "display": {"gradient_levels": 64},
    }
    assert len(plan["restartChanges"]) == 3
    assert len(plan["liveChanges"]) == 3


def test_visual_parser_does_not_round_uint64_seeds():
    config = copy.deepcopy(DEFAULTS)
    config["initial"]["seed"] = (1 << 64) - 1
    result = editor("parse", json.dumps(config))
    assert result["initial"]["seed"] == "18446744073709551615"
    assert editor("validate", result) == []


def test_visual_validation_rejects_cross_field_errors():
    config = copy.deepcopy(DEFAULTS)
    config["grid"].update(width=2, wrap=True)
    config["engine"].update(cpu_min_percent=95, cpu_max_percent=20)
    config["checkpoints"].update(segment_mb=128, quota_mb=64)
    config["initial"]["rectangle"] = {"top_left": "2.2", "bottom_right": "9000.9000"}
    errors = editor("validate", config)
    assert len(errors) >= 4


@pytest.mark.parametrize("corner", ["01.1", "1.01", " 1.1 ", "0.1"])
def test_visual_rectangle_uses_the_same_coordinate_format_as_backend(corner):
    config = copy.deepcopy(DEFAULTS)
    config["initial"]["rectangle"] = {"top_left": corner, "bottom_right": "100.100"}
    errors = editor("validate", config)
    assert any(error["path"] == "initial.rectangle" for error in errors)
    with pytest.raises(ValueError):
        merge_config(config)


def test_visual_draft_merge_preserves_intentional_edits_and_refreshes_external_changes():
    base = copy.deepcopy(DEFAULTS)
    base["initial"]["rectangle"] = {"top_left": "1.1", "bottom_right": "100.100"}
    draft = copy.deepcopy(base)
    draft["engine"]["threads"] = 4
    draft["checkpoints"]["write_mb_per_second"] = 64
    del draft["initial"]["rectangle"]
    server = copy.deepcopy(base)
    server["engine"]["max_generations_per_second"] = 7
    server["checkpoints"]["write_mb_per_second"] = 64
    merged = editor("merge", {"draft": draft, "server": server}, base)
    assert merged["engine"]["max_generations_per_second"] == 7
    assert merged["engine"]["threads"] == 4
    assert "rectangle" not in merged["initial"]
    plan = editor("plan", merged, server)
    assert plan["livePatch"] == {}
    assert len(plan["restartChanges"]) == 2

