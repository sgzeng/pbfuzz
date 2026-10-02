"""Campaign loading/validation: every rejection carries a diagnosis and remedies."""

from __future__ import annotations

import pytest
from conftest import assert_error_shape

from pbfuzz_engine.campaign import load_campaign
from pbfuzz_engine.errors import CAMPAIGN_INVALID, EngineError


def test_valid_campaign_loads(make_campaign, tmp_path):
    c = load_campaign(make_campaign())
    assert c.id == "unit-test" and c.confirmed and c.entry.uses_file
    assert c.state_dir == tmp_path / "out" / "state"
    assert c.target_locations == ("target.py:9",)
    assert c.oracle.canary_on_trigger == "log"


def test_relative_output_dir_resolves_against_repo(make_campaign, tmp_path):
    c = load_campaign(make_campaign(output={"dir": ".pbfuzz/unit"}))
    assert c.output_dir == (tmp_path / ".pbfuzz" / "unit").resolve()


def test_corpus_and_deviation_config(make_campaign, tmp_path):
    c = load_campaign(make_campaign(analysis={"corpus": {"enabled": True, "seeds_dir": str(tmp_path)}, "deviation": {"enabled": True, "mode": "target_only"}}))
    assert c.corpus_enabled and c.seeds_dir == tmp_path and c.deviation_mode == "target_only"


@pytest.mark.parametrize("channel, override, needle", [
    ("file", {"entry": {"run_cmd": "prog"}}, "must contain `@@`"),
    ("stdin", {"entry": {"run_cmd": "prog @@"}}, "must not contain `@@`"),
    ("file", {"entry": {"input_channel": "socket"}}, "input_channel"),
    ("file", {"oracle": {"reached_pattern": "("}}, "not a valid regular expression"),
    ("file", {"oracle": {"mode": "magic"}}, "oracle.mode"),
    ("file", {"oracle": None}, "is required"),
    ("file", {"version": 2}, "version"),
    ("file", {"id": "Bad ID"}, "identifier"),
    ("file", {"bug": {"kind": "cve", "targets": []}}, "non-empty"),
    ("file", {"bug": {"kind": "cve", "targets": [{"location": "no-line"}]}}, "file:line"),
    ("file", {"target": {"repo": "/x", "language": "cobol"}}, "target.language"),
    ("file", {"tracer": "valgrind"}, "tracer"),
])
def test_invalid_campaigns(make_campaign, channel, override, needle):
    with pytest.raises(EngineError) as info:
        load_campaign(make_campaign(channel, **override))
    assert info.value.code == CAMPAIGN_INVALID
    assert needle in info.value.message
    assert_error_shape(info.value)


def test_missing_and_unparseable_files(tmp_path):
    with pytest.raises(EngineError) as info:
        load_campaign(tmp_path / "missing.yaml")
    assert_error_shape(info.value)
    bad = tmp_path / "bad.yaml"
    bad.write_text("version: [1\n")
    with pytest.raises(EngineError) as info:
        load_campaign(bad)
    assert "YAML" in info.value.message
    scalar = tmp_path / "scalar.yaml"
    scalar.write_text("just a string\n")
    with pytest.raises(EngineError):
        load_campaign(scalar)


def test_output_dir_defaults_to_the_campaign_files_directory(make_campaign):
    """A drafted campaign leaves `output.dir` out: it is where the file already is."""
    path = make_campaign(output=None)
    assert load_campaign(path).output_dir == path.resolve().parent
