#!/usr/bin/env python3
"""Regression: bid_loc_mapping.txt parsing (launcher / SourceCodeFinder startup)."""

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).parent.parent))

from source_code import SourceCodeFinder  # noqa: E402
from prompt import PromptBuilder  # noqa: E402


@pytest.fixture
def static_dir(tmp_path: Path) -> Path:
    d = tmp_path / "static_results"
    d.mkdir(parents=True)
    # SourceCodeFinder loads function_info when present; minimal empty optional
    return d


def _finder(static_dir: Path, bid_text: str) -> SourceCodeFinder:
    (static_dir / "bid_loc_mapping.txt").write_text(bid_text, encoding="utf-8")
    cfg = SimpleNamespace(static_result_folder=str(static_dir))
    return SourceCodeFinder(cfg)


def test_bid_mapping_four_fields_and_loc_with_commas(static_dir: Path):
    """Canonical row; location may contain commas after the third comma."""
    f = _finder(
        static_dir,
        "1,679,42,gas/with,comma/dwarf2dbg.c:679\n",
    )
    assert f.loc_bid_cache[1] == (42, "gas/with,comma/dwarf2dbg.c:679")


def test_bid_mapping_three_field_legacy_smoke_format(static_dir: Path):
    """INIT / LLM sometimes writes bid, bb_hash, path:line without function GUID."""
    f = _finder(static_dir, "1,679,gas/dwarf2dbg.c:679\n")
    assert f.loc_bid_cache[1][0] == 0
    assert f.loc_bid_cache[1][1] == "gas/dwarf2dbg.c:679"


def test_bid_mapping_optional_primary_bid_column(static_dir: Path):
    """Empty first column uses second column as BID (existing behaviour)."""
    f = _finder(static_dir, ",5,10,tiny.c:1\n")
    assert f.loc_bid_cache[5] == (10, "tiny.c:1")


def test_bid_mapping_primary_overrides(static_dir: Path):
    f = _finder(static_dir, "3,5,10,tiny.c:1\n")
    assert f.loc_bid_cache[3] == (10, "tiny.c:1")


def test_bid_mapping_rejects_too_few_fields(static_dir: Path):
    (static_dir / "bid_loc_mapping.txt").write_text("1,2\n", encoding="utf-8")
    cfg = SimpleNamespace(static_result_folder=str(static_dir))
    with pytest.raises(AssertionError, match="Invalid line"):
        SourceCodeFinder(cfg)


def test_bid_mapping_duplicate_bid_last_line_wins(static_dir: Path):
    """INIT sometimes appends placeholder rows that reuse BID 0; launcher must not crash."""
    f = _finder(
        static_dir,
        "1,1,1,first.c:1\n0,0,0,second.c:2\n0,0,0,third.c:3\n",
    )
    assert f.loc_bid_cache[0] == (0, "third.c:3")
    assert f.loc_bid_cache[1] == (1, "first.c:1")


def test_prompt_builder_accepts_legacy_three_field_mapping(static_dir: Path):
    """Regression from smoke: launcher PromptBuilder should not crash on 3-field legacy rows."""
    cfg = SimpleNamespace(
        static_result_folder=str(static_dir),
        cmd=["./fuzz_as", "@@"],
    )
    (static_dir / "bid_loc_mapping.txt").write_text("1,679,gas/dwarf2dbg.c:679\n", encoding="utf-8")
    PromptBuilder(cfg, {"projects": {}})
