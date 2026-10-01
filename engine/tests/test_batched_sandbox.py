"""`BatchedGeneratorSandbox`/`call_extractor_many`: the long-lived worker (P4.1).

Complements `test_sandbox.py` (which covers the unchanged one-shot `GeneratorSandbox`/
`call_extractor` path and `_generator_child.main()`) with the batched worker protocol added on
top: correctness against the one-shot path, worker reuse across calls, restart-and-resume after
a per-call timeout or a fatal in-process crash, and the pre-injected common-imports preamble
that is unique to the worker entry point.
"""

from __future__ import annotations

import struct
import time

import pytest

from pbfuzz_engine.sandbox import (
    BatchedGeneratorSandbox,
    GeneratedInput,
    GeneratorSandbox,
    SandboxError,
    SandboxLimits,
    call_extractor_many,
)

FAST = SandboxLimits(timeout_sec=10, mem_mb=0, cpu_sec=0)


def test_generate_many_matches_generate_one_at_a_time(write_generator):
    gen = write_generator("def generate(**p):\n    return (str(p['n']) * 2).encode(), {'resolved': p['n']}\n")
    single = GeneratorSandbox(gen, FAST)
    expected = [single.generate({"n": i}) for i in range(5)]

    batched = BatchedGeneratorSandbox(gen, FAST)
    try:
        results = batched.generate_many([{"n": i} for i in range(5)])
    finally:
        batched.close()

    assert all(isinstance(r, GeneratedInput) for r in results)
    assert [r.data for r in results] == [e.data for e in expected]
    assert [r.used_params for r in results] == [e.used_params for e in expected]


def test_worker_is_reused_across_generate_many_calls(write_generator, tmp_path):
    marker = tmp_path / "pids.txt"
    gen = write_generator(
        "import os\n"
        f"def generate(**p):\n"
        f"    with open({str(marker)!r}, 'a') as f:\n"
        f"        f.write(str(os.getpid()) + chr(10))\n"
        f"    return b'x'\n"
    )
    sandbox = BatchedGeneratorSandbox(gen, FAST)
    try:
        r1 = sandbox.generate_many([{} for _ in range(3)])
        r2 = sandbox.generate_many([{} for _ in range(3)])
    finally:
        sandbox.close()

    assert all(isinstance(r, GeneratedInput) for r in r1 + r2)
    pids = set(marker.read_text().splitlines())
    assert len(pids) == 1, f"expected one worker process to serve all 6 calls, saw pids {pids}"


def test_worker_crash_mid_batch_still_resolves_every_other_item(write_generator):
    """The restart-and-resume contract: a fatal in-process failure (here `os._exit()`, the
    same "cannot be caught" failure mode `test_sys_exit_and_hard_exit_do_not_escape` exercises
    for the one-shot path) on ONE item must not lose the rest of the batch."""
    gen = write_generator(
        "import os\n"
        "def generate(**p):\n"
        "    if p.get('n') == 3:\n"
        "        os._exit(7)\n"
        "    return str(p.get('n')).encode()\n"
    )
    sandbox = BatchedGeneratorSandbox(gen, FAST)
    try:
        results = sandbox.generate_many([{"n": i} for i in range(1, 6)])
    finally:
        sandbox.close()

    assert len(results) == 5
    for i, result in enumerate(results, start=1):
        if i == 3:
            assert isinstance(result, SandboxError), f"item {i} should have failed"
            assert result.kind == "crash"
        else:
            assert isinstance(result, GeneratedInput), f"item {i} should have a real result, got {result!r}"
            assert result.data == str(i).encode()


def test_per_call_timeout_kills_and_restarts_the_worker(write_generator):
    """`timeout_sec` bounds each call's own round trip, INCLUDING a freshly (re)started
    worker's one-time interpreter-boot-and-import cost for that first call -- exactly like the
    one-shot path's `Popen.communicate(timeout=...)` always has (it too starts counting before
    the child has even booted). 2s comfortably covers that boot cost even on a slow VM while
    staying far below the 5s the hung call sleeps for, so the timeout only ever fires for the
    genuinely-hung call.
    """
    gen = write_generator(
        "import time\n"
        "def generate(**p):\n"
        "    if p.get('n') == 2:\n"
        "        time.sleep(5)\n"
        "    return str(p.get('n')).encode()\n"
    )
    sandbox = BatchedGeneratorSandbox(gen, SandboxLimits(timeout_sec=2.0, mem_mb=0, cpu_sec=0))
    started = time.monotonic()
    try:
        results = sandbox.generate_many([{"n": i} for i in range(1, 4)])
    finally:
        sandbox.close()
    elapsed = time.monotonic() - started

    assert isinstance(results[0], GeneratedInput) and results[0].data == b"1"
    assert isinstance(results[1], SandboxError) and results[1].kind == "timeout"
    assert isinstance(results[2], GeneratedInput) and results[2].data == b"3"
    # The killed worker's 5s sleep must not be waited out; only its own ~2s budget (plus a
    # fresh worker boot for item 3's restart).
    assert elapsed < 8.0, f"took {elapsed:.1f}s -- the timed-out call was not killed promptly"


def test_should_stop_cuts_a_slow_batch_short(write_generator):
    """F-batch-cancel-timeout: without `should_stop`, `generate_many()`'s internal loop
    (`_run_batch`) has no way to bail out once started -- every remaining item in the batch pays
    its own cost before the caller gets control back, which is what let a 0.5s fuzz timeout run
    9+ seconds over budget against a slow/broken generator (see `FuzzSession.run()`). Here a
    20-item batch of 0.2s-per-call generates would take ~4s uninterrupted; `should_stop` firing
    after 0.3s must cut it short well before that.
    """
    gen = write_generator("import time\ndef generate(**p):\n    time.sleep(0.2)\n    return str(p['n']).encode()\n")
    sandbox = BatchedGeneratorSandbox(gen, FAST)
    started = time.monotonic()
    should_stop = lambda: time.monotonic() - started >= 0.3  # noqa: E731

    try:
        results = sandbox.generate_many([{"n": i} for i in range(20)], should_stop=should_stop)
    finally:
        sandbox.close()
    elapsed = time.monotonic() - started

    assert len(results) < 20, "should_stop firing mid-batch must return fewer results than requested"
    assert all(isinstance(r, GeneratedInput) for r in results), "items generated before the stop must still be real results"
    assert elapsed < 20 * 0.2, f"took {elapsed:.1f}s -- should_stop was not honoured promptly (ran the full batch)"


def test_common_imports_preamble_lets_batched_calls_skip_explicit_imports(write_generator):
    """F6 (old-pbfuzz `_inject_common_imports`): the worker prepends a standard-imports
    preamble to the module source before importing it, so the single most common
    model-generator mistake (using `struct`/`random`/etc. without importing it) does not cost
    a round trip. This is a worker-only optimisation -- the one-shot path is intentionally
    unaffected, so a generator that relies on it still fails there."""
    gen = write_generator(
        "def generate(**p):\n"
        "    return struct.pack('>I', p['n']) + bytes([random.Random(p['n']).randint(0, 255)])\n"
    )
    sandbox = BatchedGeneratorSandbox(gen, FAST)
    try:
        results = sandbox.generate_many([{"n": 7}])
    finally:
        sandbox.close()
    assert isinstance(results[0], GeneratedInput)
    assert results[0].data[:4] == struct.pack(">I", 7)
    assert len(results[0].data) == 5

    with pytest.raises(SandboxError) as info:
        GeneratorSandbox(gen, FAST).generate({"n": 7})
    assert "NameError" in info.value.message


def test_call_extractor_many_matches_call_extractor(write_generator, tmp_path):
    ext = write_generator("import os\ndef extract_parameters(path):\n    return {'n': {'type': 'int_range', 'min': 0, 'max': os.path.getsize(path)}}\n")
    seeds = []
    for i, size in enumerate((1, 4, 9)):
        seed = tmp_path / f"seed{i}.bin"
        seed.write_bytes(b"x" * size)
        seeds.append(str(seed))

    results = call_extractor_many(ext, seeds, FAST)

    assert results == [
        {"n": {"type": "int_range", "min": 0, "max": 1}},
        {"n": {"type": "int_range", "min": 0, "max": 4}},
        {"n": {"type": "int_range", "min": 0, "max": 9}},
    ]


def test_call_extractor_many_reports_per_input_failures_without_losing_others(write_generator, tmp_path):
    ext = write_generator("def extract_parameters(path):\n    if 'bad' in path:\n        raise ValueError('nope')\n    return {'ok': True}\n")
    good = tmp_path / "good.bin"
    good.write_bytes(b"x")
    bad = tmp_path / "bad.bin"
    bad.write_bytes(b"x")

    results = call_extractor_many(ext, [str(good), str(bad)], FAST)

    assert results[0] == {"ok": True}
    assert isinstance(results[1], SandboxError) and "nope" in results[1].message


def test_close_terminates_the_worker_process(write_generator):
    gen = write_generator()
    sandbox = BatchedGeneratorSandbox(gen, FAST)
    sandbox.generate_many([{"payload": "x", "seed": 1}])
    proc = sandbox._proc
    assert proc is not None
    sandbox.close()
    assert proc.poll() is not None, "the worker process must be gone after close()"
    assert sandbox._proc is None


def test_batched_calls_are_much_cheaper_per_call_than_one_shot(write_generator):
    """Direct evidence for the P4.1 fix: batching amortises the interpreter-start cost that
    made `run_sandboxed` ~416ms/call. Uses modest sample sizes (not the ~500 calls measured for
    the fix's headline number, which this suite keeps out of the routine run -- see the report)
    so this stays fast on a slow VM while still demonstrating an order-of-magnitude difference.
    """
    gen = write_generator("def generate(**p):\n    return b'x' * p.get('n', 1)\n")

    n_old = 8
    single = GeneratorSandbox(gen, FAST)
    started = time.monotonic()
    for i in range(n_old):
        single.generate({"n": i})
    old_per_call = (time.monotonic() - started) / n_old

    n_new = 80
    batched = BatchedGeneratorSandbox(gen, FAST)
    started = time.monotonic()
    try:
        results = batched.generate_many([{"n": i} for i in range(n_new)])
    finally:
        batched.close()
    new_per_call = (time.monotonic() - started) / n_new

    assert all(isinstance(r, GeneratedInput) for r in results)
    assert new_per_call < old_per_call / 3, (
        f"batched sandbox not clearly faster: {new_per_call * 1000:.1f}ms/call vs "
        f"one-shot {old_per_call * 1000:.1f}ms/call"
    )
