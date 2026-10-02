"""The generator sandbox: model-written code runs out of process, under limits, and can't hurt the engine."""

from __future__ import annotations

import os
import sys
import time

import pytest
from conftest import assert_error_shape

from pbfuzz_engine.errors import GENERATOR_FAILED
from pbfuzz_engine.sandbox import GeneratorSandbox, SandboxError, SandboxLimits, call_extractor

FAST = SandboxLimits(timeout_sec=10, mem_mb=0, cpu_sec=0)


def _gen(write_generator, body: str, limits: SandboxLimits = FAST) -> GeneratorSandbox:
    return GeneratorSandbox(write_generator(body), limits)


def test_returns_bytes(write_generator):
    # Every byte value, repeated: non-UTF-8 output must round-trip exactly, kwargs must arrive.
    out = _gen(write_generator, "def generate(**p):\n    return bytes(range(256)) * p['n']\n").generate({"n": 64})
    assert out.data == bytes(range(256)) * 64 and out.used_params is None


def test_accepts_legacy_tuple_and_keeps_used_params(write_generator):
    out = _gen(write_generator, "def generate(**p):\n    return b'ok', {'resolved': 3}\n").generate({})
    assert out.data == b"ok" and out.used_params == {"resolved": 3}


def test_generator_runs_in_a_different_process(write_generator, tmp_path):
    marker = tmp_path / "pid"
    body = f"import os\ndef generate(**p):\n    open({str(marker)!r}, 'w').write(str(os.getpid()))\n    return b''\n"
    _gen(write_generator, body).generate({})
    assert int(marker.read_text()) != os.getpid()
    assert "pbfuzz_sandboxed" not in sys.modules


def test_exception_is_reported_with_traceback_and_remedies(write_generator):
    with pytest.raises(SandboxError) as info:
        _gen(write_generator, "def generate(**p):\n    return 1 / 0\n").generate({})
    err = info.value
    assert err.kind == "exception" and err.code == GENERATOR_FAILED
    assert "ZeroDivisionError" in err.message and "ZeroDivisionError" in err.traceback
    assert_error_shape(err)


def test_infinite_loop_is_killed_by_timeout(write_generator):
    started = time.monotonic()
    with pytest.raises(SandboxError) as info:
        _gen(write_generator, "def generate(**p):\n    while True: pass\n", SandboxLimits(timeout_sec=0.5, mem_mb=0, cpu_sec=0)).generate({})
    assert info.value.kind == "timeout"
    assert time.monotonic() - started < 5
    assert_error_shape(info.value)


def test_sys_exit_and_hard_exit_do_not_escape(write_generator):
    with pytest.raises(SandboxError) as info:
        _gen(write_generator, "import sys\ndef generate(**p):\n    sys.exit(0)\n").generate({})
    assert info.value.kind == "exception" and "SystemExit" in info.value.message
    with pytest.raises(SandboxError) as info:
        _gen(write_generator, "import os\ndef generate(**p):\n    os._exit(3)\n").generate({})
    assert info.value.kind == "crash"
    assert_error_shape(info.value)


def test_stdout_noise_from_generator_does_not_corrupt_status(write_generator):
    body = "import sys\ndef generate(**p):\n    print('{\"ok\": true, \"fake\": 1}')\n    sys.stdout = None\n    return b'real'\n"
    assert _gen(write_generator, body).generate({}).data == b"real"


@pytest.mark.parametrize("body, needle", [
    ("x = 1\n", "no `generate`"),
    ("generate = 3\n", "not callable"),
    ("def generate(**p):\n    return 'text'\n", "must return bytes"),
    ("import no_such_module_xyz\ndef generate(**p):\n    return b''\n", "ModuleNotFoundError"),
])
def test_malformed_generators(write_generator, body, needle):
    with pytest.raises(SandboxError) as info:
        _gen(write_generator, body).generate({})
    assert needle in info.value.message


def test_syntax_error_is_reported_without_executing(write_generator, tmp_path):
    marker = tmp_path / "ran"
    sandbox = _gen(write_generator, f"open({str(marker)!r}, 'w')\ndef generate(**p) return b''\n")
    with pytest.raises(SandboxError) as info:
        sandbox.check_syntax()
    assert "line 2" in info.value.message
    assert not marker.exists()


def test_missing_generator_file(tmp_path):
    with pytest.raises(SandboxError) as info:
        GeneratorSandbox(tmp_path / "nope.py")
    assert_error_shape(info.value)


def test_unserialisable_params(write_generator):
    # default=str makes most values serialisable; a circular structure is not.
    circular: list = []
    circular.append(circular)
    with pytest.raises(SandboxError) as info:
        _gen(write_generator, "def generate(**p):\n    return b''\n").generate({"x": circular})
    assert info.value.kind == "protocol"


@pytest.mark.skipif(not hasattr(__import__("signal"), "SIGXCPU"), reason="no SIGXCPU on this platform")
def test_cpu_rlimit_kills_busy_generator(write_generator):
    with pytest.raises(SandboxError) as info:
        _gen(write_generator, "def generate(**p):\n    while True: pass\n", SandboxLimits(timeout_sec=20, mem_mb=0, cpu_sec=1)).generate({})
    assert info.value.kind == "crash" and "SIGXCPU" in info.value.message


@pytest.mark.linux_only
@pytest.mark.skipif(sys.platform != "linux", reason="RLIMIT_AS is only enforced on Linux (the deployment target); macOS ignores it")
def test_memory_rlimit_stops_huge_allocation(write_generator):
    with pytest.raises(SandboxError) as info:
        _gen(write_generator, "def generate(**p):\n    return b'x' * (2 * 1024 ** 3)\n", SandboxLimits(timeout_sec=20, mem_mb=256, cpu_sec=10)).generate({})
    assert info.value.kind == "memory"


def test_extractor_json_mode(write_generator, tmp_path):
    seed = tmp_path / "s.bin"
    seed.write_bytes(b"abcd")
    ext = write_generator("import os\ndef extract_parameters(path):\n    return {'n': {'type': 'int_range', 'min': 0, 'max': os.path.getsize(path)}}\n")
    assert call_extractor(ext, str(seed), FAST) == {"n": {"type": "int_range", "min": 0, "max": 4}}
