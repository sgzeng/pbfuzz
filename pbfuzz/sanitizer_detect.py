"""Sanitizer output detection (aligned with pbfuzz_repro.verification)."""

from __future__ import annotations

import re

_ASAN_RE = re.compile(
    r"==\d+==ERROR: (AddressSanitizer|UndefinedBehaviorSanitizer|MemorySanitizer|LeakSanitizer):"
)
_UBSAN_RUNTIME_RE = re.compile(r"runtime error:", re.IGNORECASE)
_CRASH_EXIT_CODES = frozenset({1, 134, -6, -11})
_SANITIZER_HINT_RE = re.compile(
    r"AddressSanitizer:|heap-buffer-overflow|SEGV|ABRT", re.IGNORECASE
)


def sanitizer_crash_detected(combined: str, exit_code: int | None = None) -> bool:
    """True when stderr/stdout shows a sanitizer-visible failure."""
    if _ASAN_RE.search(combined):
        return True
    if _UBSAN_RUNTIME_RE.search(combined):
        return True
    if "runtime error: signed integer overflow" in combined.lower():
        return True
    if _SANITIZER_HINT_RE.search(combined):
        return True
    if exit_code in _CRASH_EXIT_CODES and "SUMMARY:" in combined:
        return True
    return False


def exec_timeout_for_input_size(base_timeout: float, data_size: int) -> float:
    """Extend subprocess timeout for large PoC files."""
    if data_size <= 0:
        return float(base_timeout)
  # ~15s per 100 MiB, cap at 15 minutes
    extra = (data_size // (100 * 1024 * 1024)) * 15
    return min(900.0, max(float(base_timeout), 60.0 + extra))
