"""corpus.analyze, params.extract, selfcheck.engine."""

from __future__ import annotations

import os
from pathlib import Path

import pytest
from conftest import assert_error_shape, assert_only_declared_keys, contract_def

from pbfuzz_engine.campaign import load_campaign
from pbfuzz_engine.corpus import analyze_corpus
from pbfuzz_engine.errors import CORPUS_EMPTY, PLAN_INVALID, EngineError
from pbfuzz_engine.extract import extract_parameters
from pbfuzz_engine.selfcheck import check_engine

CORPUS_SCHEMA = contract_def("engine-rpc.schema.json", "CorpusAnalyzeResult")


@pytest.fixture
def seeds(tmp_path: Path) -> Path:
    d = tmp_path / "seeds"
    d.mkdir()
    (d / "a").write_bytes(b"R" * 10)
    (d / "b").write_bytes(b"R")
    (d / "c").write_bytes(b"nothing")
    (d / ".hidden").write_bytes(b"R")
    return d


def test_corpus_without_tracer_reports_route_without_callstack(make_campaign, seeds):
    result = analyze_corpus(load_campaign(make_campaign()), seeds_dir=seeds)
    assert_only_declared_keys(result, CORPUS_SCHEMA)
    assert result["seeds"] == 3 and result["reachingSeeds"] == 2
    assert result["routes"] == [{"count": 2, "exemplar": str((seeds / "b").resolve())}]


def test_corpus_routes_group_by_callstack(make_campaign, seeds):
    class Hit:
        def __init__(self, cs):
            self.callstack = cs

    class Tr:
        def run(self, campaign, path, bps, timeout):
            assert bps[0]["print_call_stack"]
            cs = "main\nparse_long\nf3\nf4\nf5\nf6\nf7" if Path(path).name == "a" else "main\nparse_short"

            class R:
                breakpoints = [type("B", (), {"hits": [Hit(cs)]})()]
            return R()

    result = analyze_corpus(load_campaign(make_campaign()), seeds_dir=seeds, tracer=Tr())
    stacks = {r["callstack"]: r for r in result["routes"]}
    assert set(stacks) == {"main\nparse_short", "main\nparse_long\nf3\nf4\nf5\n... (2 more frames)"}
    assert all(r["count"] == 1 for r in result["routes"])


def test_corpus_stdin_channel_and_max_seeds(make_campaign, seeds):
    result = analyze_corpus(load_campaign(make_campaign("stdin")), seeds_dir=seeds, max_seeds=1)
    assert result["seeds"] == 1 and result["reachingSeeds"] == 1


def test_corpus_unreadable_seed_is_skipped_not_fatal(make_campaign, seeds):
    """A chmod-000 seed must not crash analyze_corpus for the whole corpus (regression for F11)."""
    unreadable = seeds / "noaccess.bin"
    unreadable.write_bytes(b"R")
    os.chmod(unreadable, 0o000)
    try:
        result = analyze_corpus(load_campaign(make_campaign()), seeds_dir=seeds)
    finally:
        os.chmod(unreadable, 0o644)
    assert_only_declared_keys(result, CORPUS_SCHEMA)
    # 4 seed files on disk (a, b, c, noaccess.bin); the unreadable one is skipped, not counted
    # as reaching, and does not blow up the remaining 2 reaching seeds (a, b).
    assert result["seeds"] == 4
    assert result["reachingSeeds"] == 2


def test_corpus_missing_or_empty(make_campaign, tmp_path):
    campaign = load_campaign(make_campaign())
    for d in (None, tmp_path / "nope"):
        with pytest.raises(EngineError) as info:
            analyze_corpus(campaign, seeds_dir=d)
        assert info.value.code == CORPUS_EMPTY
        assert any(r["effect"] == "disable_tool" for r in info.value.remedies)
    empty = tmp_path / "empty"
    empty.mkdir()
    with pytest.raises(EngineError):
        analyze_corpus(campaign, seeds_dir=empty)


EXTRACTOR = "import os\ndef extract_parameters(path):\n    n = os.path.getsize(path)\n    return {'size': {'type': 'int_range', 'min': n, 'max': n}, 'head': {'type': 'categorical', 'values': [open(path,'rb').read(1).decode()]}}\n"


def test_extract_merges_across_inputs(seeds, write_generator):
    inputs = [seeds / "a", seeds / "b", seeds / "c"]
    for kw in ({"extractor_code": EXTRACTOR}, {"extractor_path": write_generator(EXTRACTOR)}):
        out = extract_parameters(inputs, **kw)
        assert out["parameter_space"]["size"] == {"type": "int_range", "min": 1, "max": 10}
        assert sorted(out["parameter_space"]["head"]["values"]) == ["R", "n"]
        assert out["extracted"] == 3 and out["failed"] == []


def test_extract_records_partial_failures(seeds):
    code = "def extract_parameters(path):\n    if path.endswith('c'): raise ValueError('bad')\n    if path.endswith('b'): return [1]\n    return {'x': {'type': 'bool'}}\n"
    out = extract_parameters([seeds / "a", seeds / "b", seeds / "c"], extractor_code=code)
    assert out["extracted"] == 1 and len(out["failed"]) == 2


@pytest.mark.parametrize("kwargs", [
    {"inputs": [], "extractor_code": EXTRACTOR},
    {"inputs": ["x"]},
    {"inputs": ["x"], "extractor_code": "def extract_parameters(p):\n    raise SystemExit(1)\n"},
    {"inputs": ["x"], "extractor_code": "def extract_parameters(p):\n    return {'w': {'type': 'int_range', 'min': 3, 'max': 1}}\n"},
])
def test_extract_errors(kwargs):
    inputs = kwargs.pop("inputs")
    with pytest.raises(EngineError) as info:
        extract_parameters(inputs, **kwargs)
    assert info.value.code == PLAN_INVALID
    assert_error_shape(info.value)


def test_selfcheck_engine_pass_and_version_mismatch():
    item = check_engine()
    assert item["name"] == "engine" and item["status"] == "pass", item
    assert any("sandbox round trip ok" in e for e in item["evidence"])
    bad = check_engine("999")
    assert bad["status"] == "fail" and bad["remedies"]
