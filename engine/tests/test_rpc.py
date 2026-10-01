"""JSON-RPC framing, against the real sidecar process (`python -m pbfuzz_engine`)."""

from __future__ import annotations

import io
import json
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from conftest import assert_error_shape, assert_only_declared_keys, contract_def

from pbfuzz_engine import tracing
from pbfuzz_engine.errors import NOT_IMPLEMENTED, TRACER_FAILED, EngineError
from pbfuzz_engine.rpc import CONTRACT_METHODS, RpcServer
from pbfuzz_engine.server import EngineService

RPC = json.loads((Path(__file__).resolve().parents[2] / "contracts" / "engine-rpc.schema.json").read_text())
ENGINE_DIR = Path(__file__).resolve().parents[1]


class Sidecar:
    def __init__(self) -> None:
        self.proc = subprocess.Popen([sys.executable, "-m", "pbfuzz_engine", "--log-level", "debug"], cwd=ENGINE_DIR,
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.lines: list[dict[str, Any]] = []
        self._cv = threading.Condition()
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        for raw in self.proc.stdout:
            msg = json.loads(raw)  # every stdout line MUST be JSON
            with self._cv:
                self.lines.append(msg)
                self._cv.notify_all()

    def send_raw(self, text: str) -> None:
        self.proc.stdin.write(text.encode() + b"\n")
        self.proc.stdin.flush()

    def call(self, id: Any, method: str, params: dict | None = None, timeout: float = 60) -> dict[str, Any]:
        msg = {"jsonrpc": "2.0", "id": id, "method": method}
        if params is not None:
            msg["params"] = params
        self.send_raw(json.dumps(msg))
        return self.wait(id, timeout)

    def wait(self, id: Any, timeout: float = 60) -> dict[str, Any]:
        deadline = time.monotonic() + timeout
        with self._cv:
            while True:
                for m in self.lines:
                    if "method" not in m and m.get("id") == id:
                        return m
                left = deadline - time.monotonic()
                assert left > 0, f"no response for {id}; got {self.lines}"
                self._cv.wait(left)

    def close(self) -> int:
        self.proc.stdin.close()
        return self.proc.wait(20)


@pytest.fixture
def sidecar():
    s = Sidecar()
    yield s
    if s.proc.poll() is None:
        s.proc.kill()


def _check_response(resp: dict[str, Any]) -> None:
    assert set(resp) <= {"jsonrpc", "id", "result", "error"} and resp["jsonrpc"] == "2.0"
    assert ("result" in resp) != ("error" in resp)
    if "error" in resp:
        assert set(resp["error"]) <= {"code", "message", "data"}
        assert_error_shape(resp["error"])


def test_ping(sidecar):
    resp = sidecar.call(1, "ping")
    _check_response(resp)
    assert_only_declared_keys(resp["result"], RPC["$defs"]["PingResult"])
    assert resp["result"]["contractsVersion"] == "1"
    assert set(resp["result"]["capabilities"]) == set(RPC["$defs"]["Request"]["properties"]["method"]["enum"])
    assert sidecar.close() == 0


@pytest.mark.parametrize("line, code", [
    ("{not json", -32700),
    ('{"jsonrpc": "1.0", "id": 1, "method": "ping"}', -32600),
    ('[1, 2]', -32600),
    ('{"jsonrpc": "2.0", "id": true, "method": "ping"}', -32600),
    ('{"jsonrpc": "2.0", "id": 7, "method": "fuzz.explode"}', -32601),
    ('{"jsonrpc": "2.0", "id": 8, "method": "ping", "params": [1]}', -32602),
])
def test_protocol_errors_carry_diagnosis_and_remedies(sidecar, line, code):
    sidecar.send_raw(line)
    sidecar.send_raw('{"jsonrpc": "2.0", "id": "after", "method": "ping"}')
    sidecar.wait("after")
    errs = [m for m in sidecar.lines if "error" in m]
    assert errs and errs[0]["error"]["code"] == code
    _check_response(errs[0])


def test_client_notification_is_ignored_and_blank_lines_skipped(sidecar):
    sidecar.send_raw('{"jsonrpc": "2.0", "method": "ping"}')
    sidecar.send_raw("")
    assert "result" in sidecar.call("x", "ping")
    assert len(sidecar.lines) == 1


def test_missing_params_is_invalid_params(sidecar):
    resp = sidecar.call(2, "campaign.load", {})
    assert resp["error"]["code"] == -32602
    _check_response(resp)


def test_campaign_load_error(sidecar, tmp_path):
    resp = sidecar.call(3, "campaign.load", {"campaignPath": str(tmp_path / "none.yaml")})
    assert resp["error"]["code"] == -32001
    _check_response(resp)


def test_fuzz_run_end_to_end(sidecar, make_campaign, write_plan, write_generator):
    campaign = make_campaign()
    plan = write_plan({"parameter_space": {"payload": {"type": "categorical", "values": ["R", "x"]}},
                       "next_batch_plan": [{"plan_description": "reach", "payload": "R"}]})
    resp = sidecar.call(10, "fuzz.run", {"campaignPath": str(campaign), "planPath": str(plan), "generatorPath": str(write_generator()),
                                         "runtime": {"maxIters": 3, "stage1MinConcreteParams": 0}, "pierRound": 2})
    _check_response(resp)
    result = resp["result"]
    assert_only_declared_keys(result, RPC["$defs"]["FuzzRunResult"])
    assert result["summary"]["reachedCount"] >= 1
    metrics = json.loads(Path(result["metricsPath"]).read_text())
    assert metrics["pier_round"] == 2 and metrics["total_reached_count"] == result["summary"]["reachedCount"]
    idx = sidecar.lines.index(resp)
    notes = [m for m in sidecar.lines[:idx] if "method" in m]
    assert {n["method"] for n in notes} >= {"iteration", "progress"}
    for n in notes:
        assert_only_declared_keys(n, RPC["$defs"]["Notification"])


def test_fuzz_run_mid_run_error_diagnosis_reaches_rpc_summary(sidecar, make_campaign, write_plan, write_generator):
    """F20-engine: a mid-run generator error's diagnosis must surface in the RPC-level
    FuzzRunResult, not just in the internal iteration notifications / iterations.jsonl."""
    campaign = make_campaign()
    gen = write_generator("def generate(**p):\n    if p['n'] == 2: raise KeyError('boom')\n    return b'R'\n")
    plan = write_plan({"parameter_space": {"n": {"type": "int_range", "min": 0, "max": 9}},
                       "next_batch_plan": [{"plan_description": "ok", "n": 1}, {"plan_description": "boom", "n": 2}]})
    resp = sidecar.call(14, "fuzz.run", {"campaignPath": str(campaign), "planPath": str(plan), "generatorPath": str(gen),
                                         "runtime": {"maxIters": 9, "stage1MinConcreteParams": 0}})
    _check_response(resp)
    result = resp["result"]
    assert_only_declared_keys(result, RPC["$defs"]["FuzzRunResult"])
    assert result["summary"]["stoppedBy"] == "error" and result["summary"]["errorCount"] == 1
    assert "boom" in result["summary"]["errorMessage"]
    assert result["summary"]["errorDiagnosis"]


def test_fuzz_run_rejects_unknown_params(sidecar):
    resp = sidecar.call(11, "fuzz.run", {"campaignPath": "a", "planPath": "b", "generatorPath": "c", "bogus": 1})
    assert resp["error"]["code"] == -32602


def test_fuzz_run_accepts_contract_debugger_paths(sidecar, make_campaign, write_plan, write_generator):
    """FuzzRunParams.debuggerPaths (contract) is accepted, exactly as the plugin sends it."""
    campaign = make_campaign()
    plan = write_plan({"parameter_space": {"payload": {"type": "categorical", "values": ["R"]}}})
    resp = sidecar.call(12, "fuzz.run", {
        "campaignPath": str(campaign), "planPath": str(plan), "generatorPath": str(write_generator()),
        "runtime": {"maxIters": 1, "stage1MinConcreteParams": 0, "generatorMemLimitMB": 256, "generatorCpuLimitSec": 5},
        "pierRound": 0, "debuggerPaths": {"gdbPath": "/usr/bin/gdb", "pythonPath": sys.executable},
    })
    _check_response(resp)
    assert "result" in resp, resp
    bad = sidecar.call(13, "fuzz.run", {"campaignPath": str(campaign), "planPath": str(plan),
                                        "generatorPath": str(write_generator()), "debuggerPaths": "gdb"})
    assert bad["error"]["code"] == -32602


def test_fuzz_cancel_and_busy(sidecar, make_campaign, write_plan, write_generator):
    campaign = make_campaign()
    plan = write_plan({"parameter_space": {"n": {"type": "int_range", "min": 0, "max": 10**9}}})
    gen = write_generator("import time\ndef generate(**p):\n    time.sleep(0.05)\n    return b'x'\n")
    params = {"campaignPath": str(campaign), "planPath": str(plan), "generatorPath": str(gen), "runtime": {"maxIters": 100000, "generatorTimeoutSec": 5}}
    sidecar.send_raw(json.dumps({"jsonrpc": "2.0", "id": "long", "method": "fuzz.run", "params": params}))
    time.sleep(1.5)
    busy = sidecar.call("second", "fuzz.run", params)
    assert busy["error"]["code"] == -32010
    ack = sidecar.call("cancel", "fuzz.cancel", {})
    assert ack["result"] == {"cancelled": True}
    resp = sidecar.wait("long")
    assert resp["error"]["code"] == -32005
    _check_response(resp)
    assert sidecar.call("cancel2", "fuzz.cancel", {})["result"] == {"cancelled": False}


def test_generator_validate(sidecar, write_generator):
    gen = write_generator("def generate(**p):\n    if p.get('n') == 3: raise ValueError('three')\n    return b'ok'\n")
    resp = sidecar.call(20, "generator.validate", {"generatorPath": str(gen), "parameterSpace": {"n": {"type": "int_range", "min": 3, "max": 4}}, "samples": 6})
    res = resp["result"]
    assert res["ok"] is False and any("three" in s.get("error", "") for s in res["samples"])
    bad = write_generator("def generate(:\n")
    resp = sidecar.call(21, "generator.validate", {"generatorPath": str(bad)})
    assert resp["error"]["code"] == -32002
    _check_response(resp)


def test_selfcheck_engine_over_rpc(sidecar):
    resp = sidecar.call(30, "selfcheck.engine", {"contractsVersion": "1"})
    assert resp["result"]["status"] == "pass"


def test_w3_methods_return_contract_errors_not_crashes(sidecar, tmp_path):
    for i, method in enumerate(["trace.run", "deviation.run"]):
        resp = sidecar.call(40 + i, method, {"campaignPath": str(tmp_path / "missing.yaml")})
        _check_response(resp)
    assert sidecar.proc.poll() is None


@pytest.mark.parametrize("tracer", ["off", "auto"])
def test_corpus_analyze_over_rpc(sidecar, make_campaign, tmp_path, tracer):
    seeds = tmp_path / "seeds"
    seeds.mkdir()
    (seeds / "r").write_bytes(b"R")
    (seeds / "n").write_bytes(b"n")
    resp = sidecar.call(50, "corpus.analyze", {"campaignPath": str(make_campaign(tracer=tracer)), "seedsDir": str(seeds)}, timeout=120)
    _check_response(resp)
    result = resp["result"]
    assert_only_declared_keys(result, RPC["$defs"]["CorpusAnalyzeResult"])
    assert result["seeds"] == 2 and result["reachingSeeds"] == 1 and result["routes"]
    assert sum(r["count"] for r in result["routes"]) >= 1


def test_fuzz_run_with_breakpoints_uses_w3_tracer_selection(sidecar, make_campaign, write_plan, write_generator):
    """tracer: auto + language python selects W3's pymon; the run must complete either way."""
    plan = write_plan({"parameter_space": {"payload": {"type": "categorical", "values": ["R"]}},
                       "breakpoints": [{"location": "target.py:9", "print_call_stack": True}],
                       "next_batch_plan": [{"plan_description": "reach", "payload": "R"}]})
    resp = sidecar.call(60, "fuzz.run", {"campaignPath": str(make_campaign(tracer="auto")), "planPath": str(plan),
                                         "generatorPath": str(write_generator()), "runtime": {"maxIters": 1, "stage1MinConcreteParams": 0}}, timeout=120)
    _check_response(resp)
    result = resp["result"]
    assert result["summary"]["totalIterations"] == 1 and result["stage1"]["entries"] == 1
    logs = [m["params"]["message"] for m in sidecar.lines if m.get("method") == "log"]
    assert any("tracer" in m or "tracing" in m for m in logs), logs


# -- in-process checks --------------------------------------------------------

def test_service_covers_exactly_the_contract():
    assert set(EngineService().handlers()) == set(CONTRACT_METHODS)
    assert set(CONTRACT_METHODS) == set(RPC["$defs"]["Request"]["properties"]["method"]["enum"])
    with pytest.raises(ValueError):
        RpcServer({"not.a.method": lambda p, c: None}, io.BytesIO(), io.BytesIO())


def test_handler_crash_becomes_internal_error_and_notify_is_restricted():
    out = io.BytesIO()
    server = RpcServer({"ping": lambda p, c: 1 / 0}, io.BytesIO(), out)
    server.handle_line(b'{"jsonrpc": "2.0", "id": 1, "method": "ping"}').join(5)
    resp = json.loads(out.getvalue())
    assert resp["error"]["code"] == -32603
    assert_error_shape(resp["error"])
    with pytest.raises(ValueError):
        server.notify("chatter", {})


def test_w3_seam_absent_module_answers_not_implemented(monkeypatch):
    monkeypatch.setattr(tracing, "_import", lambda name: None)
    with pytest.raises(EngineError) as info:
        tracing.call_w3("tracers", "trace_run", "trace.run", {})
    assert info.value.code == NOT_IMPLEMENTED
    assert_error_shape(info.value)
    tracer, reason = tracing.load_tracer(type("C", (), {"raw": {}})())
    assert tracer is None and "not installed" in reason


def test_debugger_paths_are_flattened_for_w3(monkeypatch):
    seen = {}
    fake = type("M", (), {"trace_run": staticmethod(lambda p: seen.update(p) or {"breakpoints": []})})
    monkeypatch.setattr(tracing, "_import", lambda name: fake)
    tracing.call_w3("tracers", "trace_run", "trace.run", {"input": "i", "debuggerPaths": {"gdbPath": "/opt/gdb", "jdbPath": "/j"}, "jdbPath": "/explicit"})
    assert seen == {"input": "i", "gdbPath": "/opt/gdb", "jdbPath": "/explicit"}
    assert tracing.flatten_debugger_paths({"a": 1}) == {"a": 1}


@pytest.mark.parametrize("module", ["pbfuzz_engine", "pbfuzz_engine.rpc"])
def test_both_launch_forms_serve_ndjson(module, tmp_path):
    """W1's bridge runs `python3 -m pbfuzz_engine.rpc` with PYTHONPATH=engine/ (no install)."""
    import os
    env = {**os.environ, "PYTHONPATH": str(ENGINE_DIR)}
    proc = subprocess.run([sys.executable, "-m", module], cwd=tmp_path, env=env, timeout=30, capture_output=True,
                          input=b'{"jsonrpc": "2.0", "id": 1, "method": "ping"}\n')
    lines = proc.stdout.decode().splitlines()
    assert proc.returncode == 0 and len(lines) == 1, (proc.stdout, proc.stderr)
    assert json.loads(lines[0])["result"]["engineVersion"]


def test_tracer_error_conversion():
    class TracerError(Exception):
        def __init__(self):
            super().__init__("x")
            self.diagnosis = "gdb missing"
            self.remedies = [{"id": "install", "label": "apt install gdb", "effect": "run_command"}]

    err = tracing.convert_tracer_error(TracerError())
    assert err.code == TRACER_FAILED and err.remedies[0]["id"] == "install"
    assert tracing.is_tracer_error(TracerError())
