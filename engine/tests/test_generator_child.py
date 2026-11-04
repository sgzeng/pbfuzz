"""Regression tests for `_generator_child.py`'s own mechanics (sys.path/sys.modules ordering),
as opposed to `test_sandbox.py` (the one-shot `GeneratorSandbox` path) and
`test_batched_sandbox.py` (the batched worker protocol's behaviour as seen through
`BatchedGeneratorSandbox`)."""

from __future__ import annotations

import struct

import pytest

from pbfuzz_engine.sandbox import BatchedGeneratorSandbox, GeneratedInput, GeneratorSandbox, SandboxError, SandboxLimits

FAST = SandboxLimits(timeout_sec=10, mem_mb=0, cpu_sec=0)


def test_preamble_names_are_not_shadowed_by_a_same_named_sibling_file(write_generator, tmp_path):
    """preamble-sibling-shadow regression: `worker_main()`'s `_load_function` puts the
    generator's OWN directory at `sys.path[0]` before the preamble and then the module are
    exec'd. Before the fix, a bare `import struct` in
    `_COMMON_IMPORTS_PREAMBLE` would resolve to a same-named sibling file next to the generator
    instead of the real stdlib module, because `struct` was not yet cached in `sys.modules` at
    that point. `write_generator` writes generator files directly into `tmp_path`, so a sibling
    `struct.py` placed in the same directory is exactly the shadowing file this bug needed.
    """
    (tmp_path / "struct.py").write_text(
        "def pack(*a, **k):\n"
        "    raise AssertionError('sibling struct.py shadowed the stdlib module')\n"
    )
    gen = write_generator("def generate(**p):\n    return struct.pack('>I', p['n'])\n")

    sandbox = BatchedGeneratorSandbox(gen, FAST)
    try:
        results = sandbox.generate_many([{"n": 7}])
    finally:
        sandbox.close()

    assert isinstance(results[0], GeneratedInput), results[0]
    assert results[0].data == struct.pack(">I", 7)


def test_worker_loads_the_real_file_so_file_relative_resources_resolve(tmp_path):
    """A generator that finds its resources from `__file__` (here `../natives/blob.bin`, the
    shape of a generator that `ctypes.CDLL`s a sibling `.so`) must find them in the worker too.
    Before the fix the worker exec'd a copy at `/tmp/pbfuzz-worker-*/prepared-gen.py`, so
    `__file__` pointed into the temp dir, the lookup missed, and the generator returned None."""
    (tmp_path / "natives").mkdir()
    (tmp_path / "natives" / "blob.bin").write_bytes(b"native")
    (tmp_path / "gens").mkdir()
    gen = tmp_path / "gens" / "gen.py"
    gen.write_text(
        "import os\n"
        "HERE = os.path.dirname(os.path.abspath(__file__))\n"
        "def generate(**p):\n"
        "    with open(os.path.join(HERE, '..', 'natives', 'blob.bin'), 'rb') as f:\n"
        "        return f.read() + os.path.abspath(__file__).encode()\n"
    )
    with BatchedGeneratorSandbox(gen, FAST) as sandbox:
        (result,) = sandbox.generate_many([{}])
    assert isinstance(result, GeneratedInput), result
    assert result.data == b"native" + str(gen.resolve()).encode()


def test_worker_keeps_future_imports_docstring_and_line_numbers(write_generator):
    """The preamble used to be prepended to the source text: a leading `from __future__ import`
    then became a SyntaxError (and crashed the worker), the docstring stopped being `__doc__`,
    and every traceback line was off by the preamble's length."""
    gen = write_generator(
        '"""Module doc."""\n'
        "from __future__ import annotations\n"
        "def generate(**p):\n"
        "    if p.get('boom'):\n"
        "        raise ValueError('line 5')\n"
        "    return (__doc__ + '|' + struct.pack('>H', 1).hex()).encode()\n"
    )
    with BatchedGeneratorSandbox(gen, FAST) as sandbox:
        ok, boom = sandbox.generate_many([{}, {"boom": True}])
    assert isinstance(ok, GeneratedInput) and ok.data == b"Module doc.|0001"
    assert isinstance(boom, SandboxError) and boom.kind == "exception"
    assert f'File "{gen}", line 5' in boom.traceback


def test_worker_reports_an_import_time_error_per_item_instead_of_crashing(write_generator):
    gen = write_generator("import no_such_module_xyz\ndef generate(**p):\n    return b''\n")
    with BatchedGeneratorSandbox(gen, FAST) as sandbox:
        results = sandbox.generate_many([{}, {}])
    assert [r.kind for r in results] == ["exception", "exception"]  # type: ignore[union-attr]
    assert all("ModuleNotFoundError" in r.message for r in results)  # type: ignore[union-attr]


def test_none_is_reported_as_skipped_with_a_cause_on_both_entry_points(write_generator):
    gen = write_generator("def generate(**p):\n    return None if p.get('n') == 2 else b'ok'\n")
    with BatchedGeneratorSandbox(gen, FAST) as sandbox:
        ok, skipped = sandbox.generate_many([{"n": 1}, {"n": 2}])
    assert isinstance(ok, GeneratedInput) and ok.data == b"ok"
    assert isinstance(skipped, SandboxError) and skipped.kind == "skipped"
    assert "returned None" in skipped.message and "__file__" in skipped.diagnosis
    with pytest.raises(SandboxError) as info:
        GeneratorSandbox(gen, FAST).generate({"n": 2})
    assert info.value.kind == "skipped" and "returned None" in info.value.message
