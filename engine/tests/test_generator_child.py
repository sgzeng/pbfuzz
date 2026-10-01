"""Regression tests for `_generator_child.py`'s own mechanics (sys.path/sys.modules ordering),
as opposed to `test_sandbox.py` (the one-shot `GeneratorSandbox` path) and
`test_batched_sandbox.py` (the batched worker protocol's behaviour as seen through
`BatchedGeneratorSandbox`)."""

from __future__ import annotations

import struct

from pbfuzz_engine.sandbox import BatchedGeneratorSandbox, GeneratedInput, SandboxLimits

FAST = SandboxLimits(timeout_sec=10, mem_mb=0, cpu_sec=0)


def test_preamble_names_are_not_shadowed_by_a_same_named_sibling_file(write_generator, tmp_path):
    """preamble-sibling-shadow regression: `worker_main()`'s `_load_function(...,
    extra_sys_path=...)` puts the generator's OWN directory at `sys.path[0]` before the
    preamble-prepended module is exec'd. Before the fix, a bare `import struct` in
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
