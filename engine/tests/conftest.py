"""Shared fixtures: a tiny Python target, campaign/plan/generator writers, schema helpers."""

from __future__ import annotations

import json
import sys
import textwrap
from pathlib import Path
from typing import Any

import pytest
import yaml

REPO = Path(__file__).resolve().parents[2]
CONTRACTS = REPO / "contracts"

# The program under test. Markers in the input drive its behaviour:
#   R -> prints REACHED on stderr;  T -> prints TRIGGERED;  H -> hangs;  A -> abort()s.
TARGET_SRC = textwrap.dedent(
    """
    import os, sys, time
    data = open(sys.argv[1], 'rb').read() if len(sys.argv) > 1 else sys.stdin.buffer.read()
    if b'H' in data:
        time.sleep(30)
    if b'R' in data:
        sys.stderr.write('PBFUZZ_REACHED: t1\\n')
    if b'T' in data:
        sys.stderr.write('PBFUZZ_TRIGGERED: t1\\n')
    sys.stderr.flush()
    if b'A' in data:
        os.abort()
    """
)

GEN_ECHO = textwrap.dedent(
    """
    def generate(**params):
        return str(params.get('payload', '')).encode() + b'|' + str(params.get('seed')).encode()
    """
)


@pytest.fixture
def target_script(tmp_path: Path) -> Path:
    path = tmp_path / "target.py"
    path.write_text(TARGET_SRC)
    return path


@pytest.fixture
def make_campaign(tmp_path: Path, target_script: Path):
    """Write a campaign YAML; keyword overrides are deep-merged into the defaults."""

    def _make(channel: str = "file", **overrides: Any) -> Path:
        run_cmd = f"{sys.executable} {target_script}" + (" @@" if channel == "file" else "")
        doc: dict[str, Any] = {
            "version": 1,
            "id": "unit-test",
            "confirmed": True,
            "target": {"repo": str(tmp_path), "language": "python"},
            "bug": {"kind": "trigger_condition", "targets": [{"location": "target.py:9"}]},
            "entry": {"kind": "executable", "run_cmd": run_cmd, "input_channel": channel},
            "oracle": {"mode": "preexisting", "reached_pattern": r"PBFUZZ_REACHED:\s*(\S+)", "triggered_pattern": r"PBFUZZ_TRIGGERED:\s*(\S+)"},
            "tracer": "off",
            "output": {"dir": str(tmp_path / "out")},
        }
        for key, value in overrides.items():
            if isinstance(value, dict) and isinstance(doc.get(key), dict):
                doc[key] = {**doc[key], **value}
            elif value is None:
                doc.pop(key, None)
            else:
                doc[key] = value
        path = tmp_path / f"campaign-{channel}.yaml"
        path.write_text(yaml.safe_dump(doc))
        return path

    return _make


@pytest.fixture
def write_generator(tmp_path: Path):
    counter = {"n": 0}

    def _write(src: str = GEN_ECHO) -> Path:
        counter["n"] += 1
        path = tmp_path / f"gen_{counter['n']}.py"
        path.write_text(textwrap.dedent(src))
        return path

    return _write


@pytest.fixture
def write_plan(tmp_path: Path):
    def _write(plan: dict[str, Any]) -> Path:
        path = tmp_path / "fuzz_plan.json"
        path.write_text(json.dumps(plan))
        return path

    return _write


def contract_def(file: str, name: str | None = None) -> dict[str, Any]:
    schema = json.loads((CONTRACTS / file).read_text())
    return schema["$defs"][name] if name else schema


def assert_only_declared_keys(obj: dict[str, Any], schema: dict[str, Any], where: str = "") -> None:
    """Recursively check `additionalProperties: false` objects carry no undeclared keys."""
    props = schema.get("properties", {})
    if schema.get("additionalProperties") is False:
        extra = set(obj) - set(props)
        assert not extra, f"{where or 'object'} has undeclared keys {sorted(extra)}"
    for key in schema.get("required", []):
        assert key in obj, f"{where or 'object'} is missing required {key}"
    for key, sub in props.items():
        if key in obj and isinstance(obj[key], dict) and sub.get("type") == "object":
            assert_only_declared_keys(obj[key], sub, f"{where}.{key}")


def assert_error_shape(err: Any) -> None:
    """Every engine error must carry a diagnosis and at least one remedy with id+label."""
    data = err.to_rpc()["data"] if hasattr(err, "to_rpc") else err["data"]
    assert isinstance(data["diagnosis"], str) and data["diagnosis"]
    assert data["remedies"], "remedies must be non-empty"
    for r in data["remedies"]:
        assert r["id"] and r["label"]
        if "effect" in r:
            assert r["effect"] in {"retry", "edit_campaign", "disable_tool", "run_command", "manual"}
