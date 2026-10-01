"""F16 — regression check for campaign.py's hand-written validator against known-good/bad docs.

`engine/pbfuzz_engine/generated/contracts.py` is NOT pydantic models despite older claims to
that effect (`scripts/codegen.mjs`, `contracts/README.md`) — it is a small schema-file loader.
`campaign.py`'s `load_campaign()` validates `pbfuzz.campaign.yaml` entirely by hand
(`_require`/`_as_dict`/`_enum`), with no automated check against `contracts/campaign.schema.json`.

This test used to round-trip a set of example campaigns through both `load_campaign` and
`engine/hooks/pbfuzz_hooks/schema.py` (a dependency-free JSON-Schema draft-2020-12-subset
validator vendored for the Claude-Code-hooks tree) and assert the two verdicts agreed.
`engine/hooks/` is being deleted wholesale in a later wave of the DSH-native rewrite this test
belongs to, so depending on `pbfuzz_hooks.schema` here would make this file break the moment
that deletion lands, for a reason unrelated to `campaign.py` itself. Reimplementing a second,
independent JSON-Schema (draft 2020-12 subset) validator from scratch, just to keep exercising
`contracts/campaign.schema.json` as live data, would be substantial new surface for this fix to
carry and to keep correct — `pbfuzz_hooks.schema` already *is* that validator, tested in its own
suite; duplicating it is not a good trade for what this file is checking.

So this test is simplified to its other half, which needs no cross-check tool at all: it feeds
`load_campaign()` the exact same fixture set (schema-valid and deliberately-invalid examples,
covering the same fields campaign.schema.json constrains) and asserts it accepts/rejects each
one exactly as the case's name says it should. A future change to campaign.schema.json's rules
that `campaign.py` does not track will no longer be caught automatically by a live schema
comparison — but every rule this suite actually exercises (required `oracle`, the `language`/
`input_channel` enums, the target-location pattern, the `version` const) still regresses loudly
if `campaign.py`'s hand-written validator drifts from what these fixtures assume the schema
says. `test_hand_written_validator_matches_expectation` below (renamed from the old
`test_hand_written_validator_agrees_with_real_schema`, which no longer describes what it does)
still parametrizes over the same `EXAMPLES` table for that reason.
"""

from __future__ import annotations

import copy
import uuid
from pathlib import Path
from typing import Any, Callable

import pytest
import yaml

REPO = Path(__file__).resolve().parents[2]

from pbfuzz_engine.campaign import load_campaign
from pbfuzz_engine.errors import EngineError


def _base_campaign(repo: Path, output_dir: Path) -> dict[str, Any]:
    """A minimal campaign.schema.json-valid document."""
    return {
        "version": 1,
        "id": "sync-test",
        "confirmed": True,
        "target": {"repo": str(repo), "language": "c"},
        "bug": {"kind": "trigger_condition", "targets": [{"location": "target.c:10"}]},
        "entry": {"kind": "executable", "run_cmd": "/bin/true @@", "input_channel": "file"},
        "oracle": {
            "mode": "preexisting",
            "reached_pattern": r"PBFUZZ_REACHED:\s*(\S+)",
            "triggered_pattern": r"PBFUZZ_TRIGGERED:\s*(\S+)",
        },
        "output": {"dir": str(output_dir)},
    }


def _make_full_valid(doc: dict[str, Any]) -> dict[str, Any]:
    """A larger, still-valid campaign exercising more optional fields."""
    doc = copy.deepcopy(doc)
    doc["target"] = {**doc["target"], "revision": "deadbeef"}
    doc["tracer"] = "gdb"
    doc["entry"] = {**doc["entry"], "cwd": "/tmp", "env": {"FOO": "bar"}}
    doc["analysis"] = {"corpus": {"enabled": True, "seeds_dir": "seeds"}}
    doc["notes"] = "exercised by test_campaign_schema_sync"
    return doc


def _drop(doc: dict[str, Any], key: str) -> dict[str, Any]:
    doc = copy.deepcopy(doc)
    doc.pop(key, None)
    return doc


def _set_language(doc: dict[str, Any], language: str) -> dict[str, Any]:
    doc = copy.deepcopy(doc)
    doc["target"] = {**doc["target"], "language": language}
    return doc


def _set_location(doc: dict[str, Any], location: str) -> dict[str, Any]:
    doc = copy.deepcopy(doc)
    doc["bug"] = {**doc["bug"], "targets": [{"location": location}]}
    return doc


def _set_input_channel(doc: dict[str, Any], channel: str) -> dict[str, Any]:
    doc = copy.deepcopy(doc)
    doc["entry"] = {**doc["entry"], "input_channel": channel}
    return doc


def _set_version(doc: dict[str, Any], version: int) -> dict[str, Any]:
    doc = copy.deepcopy(doc)
    doc["version"] = version
    return doc


# (case id, mutator applied to the base campaign, expected verdict — True = schema-valid)
EXAMPLES: list[tuple[str, Callable[[dict[str, Any]], dict[str, Any]], bool]] = [
    ("minimal_valid", lambda d: d, True),
    ("full_valid", _make_full_valid, True),
    ("missing_required_oracle", lambda d: _drop(d, "oracle"), False),
    ("bad_language_enum", lambda d: _set_language(d, "cobol"), False),
    ("bad_target_location_pattern", lambda d: _set_location(d, "no-colon-no-line"), False),
    ("bad_input_channel_enum", lambda d: _set_input_channel(d, "network"), False),
    ("bad_version_const", lambda d: _set_version(d, 2), False),
]


def _hand_written_verdict(doc: dict[str, Any], tmp_path: Path) -> tuple[bool, str | None]:
    path = tmp_path / f"campaign-{uuid.uuid4().hex}.yaml"
    path.write_text(yaml.safe_dump(doc))
    try:
        load_campaign(path)
    except EngineError as exc:
        return False, str(exc)
    return True, None


@pytest.mark.parametrize("name,mutate,expect_valid", EXAMPLES, ids=[e[0] for e in EXAMPLES])
def test_hand_written_validator_matches_expectation(
    name: str,
    mutate: Callable[[dict[str, Any]], dict[str, Any]],
    expect_valid: bool,
    tmp_path: Path,
) -> None:
    """`load_campaign()` accepts every `EXAMPLES` case named `*_valid` and rejects every case
    naming the specific `campaign.schema.json` rule it violates — the same fixture set (and the
    same pass/fail intent per case) this file's docstring explains no longer round-trips through
    a second, independent schema validator to arrive at."""
    base = _base_campaign(tmp_path / "repo", tmp_path / "out")
    doc = mutate(base)

    hand_ok, hand_error = _hand_written_verdict(doc, tmp_path)

    assert hand_ok == expect_valid, (
        f"{name}: expected load_campaign() to say valid={expect_valid}, got valid={hand_ok} ({hand_error})"
    )


# --- The other half of F16: scripts/codegen.mjs and contracts/README.md must stop claiming
# Python codegen produces pydantic models. `generated/contracts.py` is (and, per the fix plan,
# stays) a schema-file loader, not generated models; the sync test above is the substitute for
# real pydantic generation. These are plain text checks, not schema checks, but they belong next
# to the sync test because they guard the same false claim this file's docstring corrects.

CODEGEN_MJS = (REPO / "scripts" / "codegen.mjs").read_text()
CONTRACTS_README = (REPO / "contracts" / "README.md").read_text()


def test_codegen_mjs_no_longer_claims_pydantic_models() -> None:
    assert "pydantic models from" not in CODEGEN_MJS, (
        "scripts/codegen.mjs still claims Python codegen produces pydantic models "
        "(generatePython() only emits a schema-file loader — see generated/contracts.py)"
    )
    assert "Build the pydantic models" not in CODEGEN_MJS, (
        "scripts/codegen.mjs's generatePython() doc comment still claims to build pydantic models"
    )


def test_contracts_readme_no_longer_claims_pydantic_models() -> None:
    assert "pydantic models from the same schemas" not in CONTRACTS_README, (
        "contracts/README.md still claims engine/pbfuzz_engine/generated/contracts.py holds "
        "pydantic models; it is a schema-file loader (SCHEMA_FILES + load_schema())"
    )
