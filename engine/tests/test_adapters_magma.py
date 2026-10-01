"""The Magma adapter: BBtargets/MAGMA_LOG parsing, campaign shape, and — the part that actually
matters — that the generated oracle recognises real `magma_log()` stderr output.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
import yaml

from pbfuzz_engine.adapters.magma import (
    MagmaAdapterInput,
    MagmaTarget,
    build_campaign,
    campaign_to_yaml,
    main,
    parse_bbtargets,
    parse_magma_log_condition,
)
from pbfuzz_engine.campaign import load_campaign
from pbfuzz_engine.oracle import StderrOracle

# The real LUA001 BBtargets.txt (magma/fuzzers/pre-built/lua/BBtargets/LUA001/BBtargets.txt).
LUA001_BBTARGETS = "ldebug.c:197\nldebug.c.orig:193\n"

# The applied (patched) source line at ldebug.c:197 for LUA001 (magma/targets/lua/patches/bugs/LUA001.patch).
LUA001_SOURCE_LINE = '      MAGMA_LOG("%MAGMA_BUG%", INT_MAX - nextra <= (n - 1));'


def test_parse_bbtargets_reads_one_location_per_line():
    assert parse_bbtargets(LUA001_BBTARGETS) == ("ldebug.c:197", "ldebug.c.orig:193")


def test_parse_bbtargets_skips_blank_lines():
    assert parse_bbtargets("a.c:1\n\n  \nb.c:2\n") == ("a.c:1", "b.c:2")


def test_parse_magma_log_condition_extracts_the_predicate():
    assert parse_magma_log_condition(LUA001_SOURCE_LINE) == "INT_MAX - nextra <= (n - 1)"


def test_parse_magma_log_condition_none_when_absent():
    assert parse_magma_log_condition("    *pos = ci->func - nextra + (n - 1);") is None


def _lua001_input(**overrides) -> MagmaAdapterInput:
    defaults = dict(
        target_name="lua",
        target_repo="/work/magma/targets/lua",
        bug_id="LUA001",
        binary="/work/magma/fuzzers/pre-built/lua/clang_bc/lua/lua",
        targets=(MagmaTarget(location="ldebug.c:197", condition="INT_MAX - nextra <= (n - 1)"),),
    )
    defaults.update(overrides)
    return MagmaAdapterInput(**defaults)


def test_build_campaign_is_confirmed_and_reuses_the_bug_id_in_the_oracle():
    c = build_campaign(_lua001_input(), now=datetime(2026, 1, 1, tzinfo=timezone.utc))
    assert c["confirmed"] is True
    assert c["confirmed_at"] == "2026-01-01T00:00:00.000Z"
    assert c["oracle"]["mode"] == "preexisting"
    assert c["oracle"]["reached_pattern"] == r"MAGMA:\ Bug\ LUA001\ reached"
    assert c["oracle"]["triggered_pattern"] == r"MAGMA:\ Bug\ LUA001\ triggered"
    assert c["bug"]["targets"] == [{"location": "ldebug.c:197", "condition": "INT_MAX - nextra <= (n - 1)"}]
    assert c["id"] == "lua-lua001"
    assert c["entry"]["run_cmd"] == f"{_lua001_input().binary} @@"


def test_build_campaign_requires_at_least_one_target():
    with pytest.raises(ValueError, match="no target locations"):
        build_campaign(_lua001_input(targets=()))


def test_build_campaign_lto_mode_carries_bitcode_and_entries():
    c = build_campaign(_lua001_input(bitcode="/work/lua.0.0.preopt.bc", entries=("main",)))
    static = c["analysis"]["static"]
    assert static["mode"] == "lto"
    assert static["bitcode"] == "/work/lua.0.0.preopt.bc"
    assert static["entries"] == ["main"]
    assert "prebuilt_dir" not in static


def test_build_campaign_prebuilt_mode_is_the_magma_skip_static_analysis_path():
    c = build_campaign(_lua001_input(prebuilt_dir="/work/magma/fuzzers/pre-built/lua/BBtargets/LUA001"))
    static = c["analysis"]["static"]
    assert static["mode"] == "prebuilt"
    assert static["prebuilt_dir"] == "/work/magma/fuzzers/pre-built/lua/BBtargets/LUA001"
    assert "bitcode" not in static and "entries" not in static


def test_build_campaign_with_no_seeds_turns_corpus_off_with_a_reason():
    c = build_campaign(_lua001_input())
    assert c["analysis"]["corpus"] == {"enabled": False, "disabled_reason": "no seeds supplied"}


def test_build_campaign_with_seeds_enables_corpus():
    c = build_campaign(_lua001_input(seeds_dir="/work/magma/targets/lua/corpus/lua"))
    assert c["analysis"]["corpus"] == {"enabled": True, "seeds_dir": "/work/magma/targets/lua/corpus/lua"}


def test_bug_patch_sets_bug_kind_patch_and_source_path():
    c = build_campaign(_lua001_input(bug_patch="/work/magma/targets/lua/patches/bugs/LUA001.patch"))
    assert c["bug"]["kind"] == "patch"
    assert c["bug"]["source"] == {"path": "/work/magma/targets/lua/patches/bugs/LUA001.patch"}


def test_the_generated_oracle_recognises_real_magma_log_stderr():
    """The one thing that actually matters: build a real StderrOracle from the generated
    patterns and judge it against text `magma_log()` (magma/src/canary.c) really prints."""
    c = build_campaign(_lua001_input())
    o = StderrOracle(c["oracle"]["reached_pattern"], c["oracle"]["triggered_pattern"])

    reached_only = o.judge("MAGMA: Bug LUA001 reached\n")
    assert reached_only.reached is True and reached_only.triggered is False

    both = o.judge("MAGMA: Bug LUA001 reached\nMAGMA: Bug LUA001 triggered\n")
    assert both.reached is True and both.triggered is True

    # A different bug's marker must not cross-trigger this campaign's oracle.
    other_bug = o.judge("MAGMA: Bug LUA002 reached\nMAGMA: Bug LUA002 triggered\n")
    assert other_bug.reached is False and other_bug.triggered is False


def test_campaign_round_trips_through_the_engines_own_loader(tmp_path):
    """Proves the adapter's output is what the engine actually consumes for `/pbfuzz run`, not
    just something that looks like the schema."""
    seeds = tmp_path / "corpus"
    seeds.mkdir()
    binary = tmp_path / "lua"
    binary.write_text("#!/bin/sh\n")
    campaign = build_campaign(_lua001_input(
        target_repo=str(tmp_path),
        binary=str(binary),
        seeds_dir=str(seeds),
        output_dir=str(tmp_path / "out"),
    ))
    path = tmp_path / "pbfuzz.campaign.yaml"
    path.write_text(campaign_to_yaml(campaign))

    loaded = load_campaign(path)
    assert loaded.id == "lua-lua001"
    assert loaded.confirmed is True
    assert loaded.target_locations == ("ldebug.c:197",)
    assert loaded.corpus_enabled is True
    assert loaded.entry.uses_file is True
    assert loaded.oracle.mode == "preexisting"

    oracle = StderrOracle.from_campaign(loaded.oracle)
    assert oracle.judge("MAGMA: Bug LUA001 triggered\n").triggered is True


def test_cli_writes_a_loadable_campaign(tmp_path):
    bbtargets = tmp_path / "BBtargets.txt"
    bbtargets.write_text(LUA001_BBTARGETS)
    out = tmp_path / "pbfuzz.campaign.yaml"
    binary = tmp_path / "lua"
    binary.write_text("#!/bin/sh\n")

    code = main([
        "--target-name", "lua",
        "--target-repo", str(tmp_path),
        "--bug-id", "LUA001",
        "--binary", str(binary),
        "--bbtargets", str(bbtargets),
        "--output-dir", str(tmp_path / "out"),
        "--write", str(out),
    ])
    assert code == 0
    doc = yaml.safe_load(out.read_text())
    assert doc["confirmed"] is True
    assert doc["bug"]["targets"] == [{"location": "ldebug.c:197"}, {"location": "ldebug.c.orig:193"}]

    loaded = load_campaign(out)
    assert loaded.id == "lua-lua001"


def test_cli_fails_loudly_with_no_targets(tmp_path, capsys):
    binary = tmp_path / "lua"
    binary.write_text("#!/bin/sh\n")
    code = main([
        "--target-name", "lua",
        "--target-repo", str(tmp_path),
        "--bug-id", "LUA001",
        "--binary", str(binary),
    ])
    assert code == 2
    assert "no target locations" in capsys.readouterr().err
