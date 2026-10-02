"""The Magma adapter: BBtargets/MAGMA_LOG parsing, campaign shape, and — the part that actually
matters — that the generated oracle recognises real `magma_log()` stderr output.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pytest
import yaml

from pbfuzz_engine.adapters.magma import (
    MagmaAdapterInput,
    MagmaTarget,
    build_campaign,
    campaign_to_yaml,
    find_magma_log_condition,
    main,
    parse_bbtargets,
    parse_magma_log_condition,
    provenance_header,
)
from pbfuzz_engine.campaign import load_campaign
from pbfuzz_engine.oracle import StderrOracle

# The real LUA001 BBtargets.txt (magma/fuzzers/pre-built/lua/BBtargets/LUA001/BBtargets.txt).
LUA001_BBTARGETS = "ldebug.c:197\nldebug.c.orig:193\n"

# The applied (patched) source line at ldebug.c:197 for LUA001 (magma/targets/lua/patches/bugs/LUA001.patch).
LUA001_SOURCE_LINE = '      MAGMA_LOG("%MAGMA_BUG%", INT_MAX - nextra <= (n - 1));'


@pytest.mark.parametrize("text, expected", [
    (LUA001_BBTARGETS, ("ldebug.c:197", "ldebug.c.orig:193")),
    ("a.c:1\n\n  \nb.c:2\n", ("a.c:1", "b.c:2")),  # blank lines are skipped
])
def test_parse_bbtargets(text, expected):
    assert parse_bbtargets(text) == expected


@pytest.mark.parametrize("source_line, expected", [
    (LUA001_SOURCE_LINE, "INT_MAX - nextra <= (n - 1)"),
    ("    *pos = ci->func - nextra + (n - 1);", None),  # no MAGMA_LOG call on the line
])
def test_parse_magma_log_condition(source_line, expected):
    assert parse_magma_log_condition(source_line) == expected


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
    c = build_campaign(_lua001_input())
    assert c["confirmed"] is True
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


@pytest.mark.parametrize("overrides, expected", [
    ({}, {"enabled": False, "disabled_reason": "no seeds supplied"}),
    (
        {"seeds_dir": "/work/magma/targets/lua/corpus/lua"},
        {"enabled": True, "seeds_dir": "/work/magma/targets/lua/corpus/lua"},
    ),
])
def test_build_campaign_corpus_follows_seeds_dir(overrides, expected):
    assert build_campaign(_lua001_input(**overrides))["analysis"]["corpus"] == expected


def test_adapter_has_no_field_to_carry_a_bug_patch_path():
    """The agent must only ever be handed the bug's location and its MAGMA_LOG condition — what a
    real crash report or CVE advisory gives you — never the patch that shows the buggy code next
    to Magma's own fix (`#ifdef MAGMA_ENABLE_FIXES`). A prior version of this module accepted
    `bug_patch`/`--bug-patch` and printed it into the campaign yaml's provenance header; a real
    headless run then read that comment, opened the patch, and transcribed the `#else` branch
    instead of reasoning from the location. There is now no field to pass one through at all."""
    with pytest.raises(TypeError):
        MagmaAdapterInput(  # type: ignore[call-arg]
            target_name="lua", target_repo="/work", bug_id="LUA001", binary="/work/lua",
            targets=(MagmaTarget(location="ldebug.c:197", condition="INT_MAX - nextra <= (n - 1)"),),
            bug_patch="/work/magma/targets/lua/patches/bugs/LUA001.patch",
        )


def test_provenance_header_never_names_a_patch_path():
    adapter_input = _lua001_input()
    c = build_campaign(adapter_input)
    assert c["bug"] == {"targets": [{"location": "ldebug.c:197", "condition": "INT_MAX - nextra <= (n - 1)"}]}
    header = provenance_header(adapter_input)
    assert "ldebug.c:197" in header
    assert ".patch" not in header


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


CAMPAIGN_SCHEMA = json.loads(
    (Path(__file__).resolve().parents[2] / "contracts" / "campaign.schema.json").read_text()
)


def _undeclared_keys(doc: Any, schema: dict[str, Any], path: str = "") -> list[str]:
    """Every key in `doc` that a closed (`additionalProperties: false`) schema object does not
    declare. The plugin's `/pbfuzz run` validator rejects such keys, so the adapter must not emit
    any; a dependency-free walk is enough for the object/array shapes campaign.schema.json uses."""
    out: list[str] = []
    if isinstance(doc, dict) and "properties" in schema:
        props = schema["properties"]
        for key, value in doc.items():
            if key not in props:
                if schema.get("additionalProperties") is False:
                    out.append(f"{path}{key}")
                continue
            out.extend(_undeclared_keys(value, props[key], f"{path}{key}."))
    elif isinstance(doc, list) and isinstance(schema.get("items"), dict):
        for i, item in enumerate(doc):
            out.extend(_undeclared_keys(item, schema["items"], f"{path}{i}."))
    return out


@pytest.mark.parametrize("overrides", [
    {},
    {"prebuilt_dir": "/work/BBtargets/LUA001"},
    {"bitcode": "/work/lua.0.0.preopt.bc", "lto_libs": ("/work/libreadline.a",)},
    {"static_analysis": False, "seeds_dir": "/work/corpus"},
])
def test_build_campaign_emits_only_schema_declared_keys(overrides):
    """Regression: the adapter used to emit `confirmed_at`, `notes` and
    `analysis.static.{provider,call_stack_len,type_based_callgraph}`, none of which
    campaign.schema.json declares — so `/pbfuzz run` refused every generated campaign."""
    c = build_campaign(_lua001_input(**overrides))
    assert _undeclared_keys(c, CAMPAIGN_SCHEMA) == []


def test_no_static_analysis_disables_it_with_a_reason_and_drops_deviation_to_target_only():
    c = build_campaign(_lua001_input(static_analysis=False))
    assert c["analysis"]["static"]["enabled"] is False
    assert c["analysis"]["static"]["disabled_reason"]
    assert c["analysis"]["deviation"] == {"enabled": True, "mode": "target_only"}


def test_prebuilt_dir_keeps_static_analysis_on_even_without_the_flag():
    c = build_campaign(_lua001_input(static_analysis=False, prebuilt_dir="/work/BBtargets/LUA001"))
    assert c["analysis"]["static"]["enabled"] is True
    assert c["analysis"]["static"]["mode"] == "prebuilt"


def test_provenance_goes_in_a_comment_header_not_the_document():
    c = build_campaign(_lua001_input())
    header = provenance_header(_lua001_input(), now=datetime(2026, 1, 1, tzinfo=timezone.utc))
    text = campaign_to_yaml(c, header=header)
    assert text.startswith("# Generated 2026-01-01T00:00:00Z by the Magma adapter")
    assert yaml.safe_load(text) == c


def test_find_magma_log_condition_reads_the_patched_source(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "ldebug.c").write_text("int a;\n" + LUA001_SOURCE_LINE.replace("%MAGMA_BUG%", "LUA001") + "\n")
    assert find_magma_log_condition(tmp_path, "ldebug.c:2") == "INT_MAX - nextra <= (n - 1)"
    assert find_magma_log_condition(tmp_path, "ldebug.c:1") is None
    assert find_magma_log_condition(tmp_path, "missing.c:1") is None


def test_cli_fills_conditions_from_the_source_and_supports_no_static_analysis(tmp_path):
    (tmp_path / "ldebug.c").write_text("\n" * 196 + LUA001_SOURCE_LINE.replace("%MAGMA_BUG%", "LUA001") + "\n")
    bbtargets = tmp_path / "BBtargets.txt"
    bbtargets.write_text("ldebug.c:197\n")
    binary = tmp_path / "lua"
    binary.write_text("#!/bin/sh\n")
    out = tmp_path / "pbfuzz.campaign.yaml"

    assert main([
        "--target-name", "lua", "--target-repo", str(tmp_path), "--bug-id", "LUA001",
        "--binary", str(binary), "--bbtargets", str(bbtargets), "--no-static-analysis",
        "--output-dir", str(tmp_path / "out"), "--write", str(out),
    ]) == 0
    doc = yaml.safe_load(out.read_text())
    assert doc["bug"]["targets"] == [{"location": "ldebug.c:197", "condition": "INT_MAX - nextra <= (n - 1)"}]
    assert doc["analysis"]["static"]["enabled"] is False
    assert _undeclared_keys(doc, CAMPAIGN_SCHEMA) == []
    assert load_campaign(out).id == "lua-lua001"
