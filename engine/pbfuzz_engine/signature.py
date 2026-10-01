"""What a generator's `generate` can be called with — read from its source, never by running it.

The engine calls `generate(**params)` with every parameter of the plan plus a `seed` it injects
itself. A generator that cannot take one of those used to be found out only by calling it: once
per batch-plan entry, each failure carrying the same `TypeError` and the same traceback, and only
after every earlier validation step had passed. Reading the signature from the AST answers the
same question in microseconds, before anything is spawned, and without executing a line of the
generator (which the engine process must never do — that is what the sandbox is for).

@module pbfuzz_engine.signature
"""

from __future__ import annotations

import ast
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

#: The name the engine calls.
GENERATE = "generate"


@dataclass(frozen=True)
class GeneratorSignature:
    """The keyword interface of one `def generate(...)`."""

    #: Names that can be passed by keyword.
    keywords: frozenset[str]
    #: Of those, the ones without a default.
    required: frozenset[str]
    #: Positional-only parameters without a default — uncallable, since everything goes by keyword.
    required_positional_only: tuple[str, ...]
    #: Whether it has `**kwargs`.
    var_keyword: bool

    def accepts(self, name: str) -> bool:
        """Whether `generate(name=...)` binds."""
        return self.var_keyword or name in self.keywords


def read_signature(generator_path: str | Path, function: str = GENERATE) -> GeneratorSignature | None:
    """The signature of the top-level `def <function>` in `generator_path`.

    Returns None when it cannot be known statically — no such top-level `def` (e.g. `generate` is
    assigned or imported), or the file does not parse. Callers then fall back to finding out at
    call time, exactly as before, so an unusual generator is never rejected on a guess.
    """
    try:
        tree = ast.parse(Path(generator_path).read_text(encoding="utf-8"))
    except (OSError, SyntaxError, ValueError):
        return None
    found = None
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == function:
            found = node  # the last definition wins, as it does at import time
    if found is None:
        return None
    args = found.args
    positional = [*args.posonlyargs, *args.args]
    # Defaults align to the END of the positional list.
    first_defaulted = len(positional) - len(args.defaults)
    posonly_required = tuple(a.arg for i, a in enumerate(args.posonlyargs) if i < first_defaulted)
    keywords = [a.arg for a in args.args] + [a.arg for a in args.kwonlyargs]
    required = {a.arg for i, a in enumerate(positional) if i >= len(args.posonlyargs) and i < first_defaulted}
    required |= {a.arg for a, d in zip(args.kwonlyargs, args.kw_defaults) if d is None}
    return GeneratorSignature(
        keywords=frozenset(keywords),
        required=frozenset(required),
        required_positional_only=posonly_required,
        var_keyword=args.kwarg is not None,
    )


def fit_kwargs(params: dict[str, Any], signature: GeneratorSignature | None) -> dict[str, Any]:
    """`params` minus anything `generate` cannot bind; unchanged when the signature is unknown."""
    if signature is None or signature.var_keyword:
        return params
    return {k: v for k, v in params.items() if k in signature.keywords}


def signature_issues(signature: GeneratorSignature | None, supplied: Iterable[str], *, function: str = GENERATE) -> list[str]:
    """Why `generate(**{name: ... for name in supplied})` would fail, one sentence per cause.

    `supplied` is what the plan passes — the parameter-space names and every batch-plan key. The
    engine's own `seed` is deliberately not in it: that is only ever passed when accepted (see
    {@link fit_kwargs}), so a generator that ignores seeding is not an error.
    """
    if signature is None:
        return []
    supplied = set(supplied)
    issues: list[str] = []
    if signature.required_positional_only:
        names = ", ".join(signature.required_positional_only)
        issues.append(f"`{function}` has positional-only parameter(s) {names} with no default, but the engine passes every parameter by keyword")
    rejected = sorted(n for n in supplied if not signature.accepts(n))
    if rejected:
        issues.append(
            f"`{function}` cannot take {', '.join(rejected)}, which the plan supplies; "
            f"add {'it' if len(rejected) == 1 else 'them'} as keyword parameter(s) or accept `**kwargs`"
        )
    missing = sorted(n for n in signature.required if n not in supplied and n != "seed")
    if missing:
        issues.append(
            f"`{function}` requires {', '.join(missing)}, which the plan never supplies; "
            f"give {'it' if len(missing) == 1 else 'them'} a default or add {'it' if len(missing) == 1 else 'them'} to parameter_space"
        )
    return issues
