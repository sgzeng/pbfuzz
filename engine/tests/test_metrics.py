"""metrics.json: sole-writer store, cumulative, atomic, schema-exact, and what W7's guards read."""

from __future__ import annotations

import json

import pytest
from conftest import assert_only_declared_keys, contract_def

from pbfuzz_engine.metrics import MetricsStore, SessionMetrics

SCHEMA = contract_def("state/metrics.schema.json")


def _s(**kw):
    base = dict(iterations=10, reached=3, triggered=0, timeouts=1, errors=0, elapsed_sec=1.5, stopped_by="completed")
    return SessionMetrics(**{**base, **kw})


def test_first_session_and_schema_conformance(tmp_path):
    store = MetricsStore(tmp_path / "state")
    out = store.record_session(_s(best_reaching_input="/t/x"), campaign_id="c", pier_round=2)
    on_disk = json.loads(store.path.read_text())
    assert on_disk == out
    assert_only_declared_keys(on_disk, SCHEMA)
    assert on_disk["total_iterations"] == 10 and on_disk["total_reached_count"] == 3
    assert on_disk["last_session"]["best_reaching_input"] == "/t/x"
    assert on_disk["last_updated"].endswith("Z")


def test_cumulative_counters_and_last_reached(tmp_path):
    store = MetricsStore(tmp_path)
    store.record_session(_s(), campaign_id="c", pier_round=0)
    out = store.record_session(_s(iterations=5, reached=0, triggered=1, stopped_by="trigger", first_triggering_input="/p"), campaign_id="c", pier_round=1)
    assert out["total_iterations"] == 15 and out["total_reached_count"] == 3
    assert out["last_reached_count"] == 0 and out["triggered_count"] == 1
    assert out["timeout_count"] == 2 and out["last_session"]["stopped_by"] == "trigger"


def test_pier_round_and_triggered_count_always_present(tmp_path):
    """W7's guards read both; SUCCESS requires triggered_count >= 1."""
    store = MetricsStore(tmp_path)
    out = store.record_session(_s(), campaign_id="c", pier_round=None)
    assert out["pier_round"] == 0 and out["triggered_count"] == 0
    store.record_session(_s(), campaign_id="c", pier_round=3)
    assert store.record_session(_s(), campaign_id="c", pier_round=None)["pier_round"] == 3


def test_corrupt_previous_file_and_no_temp_leftovers(tmp_path):
    store = MetricsStore(tmp_path)
    store.path.write_text("{not json")
    out = store.record_session(_s(), campaign_id="c", pier_round=0)
    assert out["total_iterations"] == 10
    assert [p.name for p in tmp_path.iterdir()] == ["metrics.json"]


def test_tampered_negative_counters_are_not_trusted(tmp_path):
    store = MetricsStore(tmp_path)
    store.path.write_text(json.dumps({"total_iterations": -50, "total_reached_count": "lots", "triggered_count": 0}))
    out = store.record_session(_s(), campaign_id="c", pier_round=0)
    assert out["total_iterations"] == 10 and out["total_reached_count"] == 3


@pytest.mark.parametrize("bad", [dict(stopped_by="bogus"), dict(reached=-1)])
def test_rejects_invalid_sessions(tmp_path, bad):
    with pytest.raises(ValueError):
        MetricsStore(tmp_path).record_session(_s(**bad), campaign_id="c", pier_round=0)


def test_cancelled_is_an_accepted_stopped_by_value(tmp_path):
    """A cancelled fuzz.run session must be distinguishable from a completed one in metrics.json."""
    store = MetricsStore(tmp_path)
    out = store.record_session(_s(stopped_by="cancelled"), campaign_id="c", pier_round=0)
    assert out["last_session"]["stopped_by"] == "cancelled"
    assert "cancelled" in SCHEMA["properties"]["last_session"]["properties"]["stopped_by"]["enum"]
