"""Corpus analysis (`corpus.analyze`).

Replays each seed through the target, judges it with the stderr oracle, and groups the
reaching seeds into call-stack routes — the basis for `base_seed` parameters. Ported from the
CCS'26 corpus MCP server, minus its background threads: this is one deterministic pass.

Routes need a tracer (breakpoints at the campaign targets with `print_call_stack`). Without one
the reaching seeds are still reported, as a single route entry with `count` and `exemplar` and
no `callstack` key: the contract allows that shape, and leaving the field out is honest where a
placeholder callstack would not be.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Callable

from .campaign import Campaign
from .errors import CORPUS_EMPTY, EngineError, remedy
from .oracle import StderrOracle
from .runner import run_target

Notify = Callable[[str, dict[str, Any]], None]

#: Frames kept per call stack when keying routes (the old server kept 5).
ROUTE_FRAMES = 5
#: Reaching seeds traced for route extraction; the rest only count toward reachingSeeds.
MAX_ROUTE_SEEDS = 50


def _seed_files(seeds_dir: Path, max_seeds: int | None) -> list[Path]:
    files = sorted(p for p in seeds_dir.rglob("*") if p.is_file() and not p.name.startswith("."))
    return files[:max_seeds] if max_seeds else files


def _truncate(callstack: str) -> str:
    lines = [ln for ln in callstack.strip().splitlines() if ln.strip()]
    if len(lines) > ROUTE_FRAMES:
        return "\n".join(lines[:ROUTE_FRAMES]) + f"\n... ({len(lines) - ROUTE_FRAMES} more frames)"
    return "\n".join(lines)


def analyze_corpus(
    campaign: Campaign,
    *,
    seeds_dir: str | Path | None = None,
    timeout_sec: float = 3.0,
    max_seeds: int | None = None,
    tracer: Any | None = None,
    notify: Notify | None = None,
) -> dict[str, Any]:
    """Return a `CorpusAnalyzeResult` for the campaign's seed corpus."""
    notify = notify or (lambda m, p: None)
    directory = Path(seeds_dir) if seeds_dir else campaign.seeds_dir
    if directory is None or not directory.is_dir():
        raise EngineError(
            CORPUS_EMPTY, "no seed corpus to analyse",
            diagnosis=(f"The seeds directory `{directory}` does not exist." if directory else "The campaign sets no `analysis.corpus.seeds_dir` and none was passed."),
            remedies=[
                remedy("set_seeds", "Point analysis.corpus.seeds_dir at a seed directory", effect="edit_campaign"),
                remedy("disable_corpus", "Turn corpus analysis off for this campaign", detail="Recorded as `analysis.corpus.enabled: false` with disabled_reason `no seeds supplied`.", effect="disable_tool"),
            ],
        )
    seeds = _seed_files(directory, max_seeds)
    if not seeds:
        raise EngineError(
            CORPUS_EMPTY, f"seed directory {directory} is empty",
            diagnosis=f"`{directory}` contains no files.",
            remedies=[
                remedy("add_seeds", "Add seed inputs to the directory", effect="manual"),
                remedy("disable_corpus", "Turn corpus analysis off for this campaign", effect="disable_tool"),
            ],
        )

    oracle = StderrOracle.from_campaign(campaign.oracle)
    reaching: list[Path] = []
    for i, seed in enumerate(seeds):
        try:
            data = seed.read_bytes()
            result = run_target(campaign.entry, seed, data, timeout_sec=timeout_sec, cwd=seed.parent)
        except OSError as exc:  # noqa: BLE001 - one unreadable/vanished seed must not lose the corpus result
            notify("log", {"level": "warn", "message": f"skipping seed {seed.name}: {exc}"})
            continue
        if oracle.judge(result.stderr, timed_out=result.timed_out).reached:
            reaching.append(seed)
        if (i + 1) % 50 == 0:
            notify("progress", {"op": "corpus.analyze", "seeds": i + 1, "total": len(seeds), "reaching": len(reaching)})

    routes: list[dict[str, Any]] = []
    if reaching and tracer is not None and campaign.target_locations:
        breakpoints = [{"location": loc, "hit_limit": 1, "print_call_stack": True, "inline_expr": []} for loc in campaign.target_locations]
        groups: dict[str, list[Path]] = {}
        untraced: list[Path] = []
        for seed in sorted(reaching, key=lambda p: p.stat().st_size)[:MAX_ROUTE_SEEDS]:
            try:
                traced = tracer.run(campaign.raw, str(seed), breakpoints, timeout_sec * 3 + 2)
            except Exception as exc:  # noqa: BLE001 - one bad trace must not lose the corpus result
                notify("log", {"level": "warn", "message": f"tracing seed {seed.name} failed: {getattr(exc, 'diagnosis', exc)}"})
                untraced.append(seed)
                continue
            stacks = [h.callstack for b in traced.breakpoints for h in b.hits if getattr(h, "callstack", "")]
            if not stacks:
                untraced.append(seed)
                continue
            for stack in dict.fromkeys(_truncate(s) for s in stacks):
                groups.setdefault(stack, []).append(seed)
        for stack, members in sorted(groups.items(), key=lambda kv: -len(kv[1])):
            exemplar = min(members, key=lambda p: p.stat().st_size)
            routes.append({"callstack": stack, "count": len(members), "exemplar": str(exemplar.resolve())})
        if untraced and not routes:
            routes.append({"count": len(reaching), "exemplar": str(min(reaching, key=lambda p: p.stat().st_size).resolve())})
    elif reaching:
        notify("log", {"level": "info", "message": "no tracer available: reaching seeds reported as one route without a call stack"})
        routes.append({"count": len(reaching), "exemplar": str(min(reaching, key=lambda p: p.stat().st_size).resolve())})

    return {"seeds": len(seeds), "reachingSeeds": len(reaching), "routes": routes}
