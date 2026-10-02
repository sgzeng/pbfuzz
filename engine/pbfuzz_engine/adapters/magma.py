"""Magma adapter: turn a target + bug id into a confirmed `pbfuzz.campaign.yaml`.

Magma (https://hexhive.epfl.ch/magma/) ships its own oracle: every injected bug calls
`MAGMA_LOG("<BUG_ID>", <condition>)` (`magma/src/canary.h`), and `magma_log()`
(`magma/src/canary.c`) unconditionally prints `MAGMA: Bug <BUG_ID> reached` to stderr, plus
`MAGMA: Bug <BUG_ID> triggered` when `<condition>` holds — before it ever touches the shared-memory
canary storage that needs Magma's own monitor process running. That is exactly PLAN §2.6's
"Existing oracle" case, so a Magma campaign never needs canary insertion: `oracle.mode:
preexisting` with those two literal strings as regexes is both correct and precise (they name the
one bug this campaign targets, not a generic pattern).

The target's own `BBtargets.txt` (KAMain's `-target-list` input, produced by
`magma/fuzzers/pbfuzz/instrument.sh`'s `static_analyze()`, one `file:line` per line) is reused
verbatim as `bug.targets`, so kanalyzer's `-target-list` and this campaign's target always agree.
When a target's KAMain outputs already exist (Magma's own pre-built images, or one produced by
`kanalyzer_analyze` on a previous run), `prebuilt_dir` is threaded straight through as
`analysis.static.prebuilt_dir` — the "Magma SKIP_STATIC_ANALYSIS path" the schema names by name.
Without kanalyzer at all, `static_analysis=False` records static analysis as disabled and drops the
deviation detector to `target_only`, which is all a campaign needs to run on gdb traces alone.

The emitted dict carries only keys `contracts/campaign.schema.json` declares: the plugin's
`/pbfuzz run` validator rejects anything else, so provenance goes in a YAML comment header
(`campaign_to_yaml(..., header=...)`) rather than in the document.

This module only builds and serialises the campaign dict; it does not touch the filesystem beyond
what the CLI's `--write` flag asks for, so it is exercised with plain unit tests.

:module: pbfuzz_engine.adapters.magma
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

#: `magma/src/canary.c`'s `magma_log()`: printed unconditionally, before the shared-memory
#: canary write that needs Magma's own monitor process — so this is oracle-safe standalone.
_REACHED_TEMPLATE = "MAGMA: Bug {bug_id} reached"
_TRIGGERED_TEMPLATE = "MAGMA: Bug {bug_id} triggered"

#: `magma/src/canary.h`: `MAGMA_LOG(b,c) do{magma_log((b),(int)(c));}while(0)`. Captures the
#: condition expression, tolerant of the macro's cast-to-int and trailing `;`.
_MAGMA_LOG_CALL = re.compile(
    r'MAGMA_LOG\s*\(\s*"[^"]*"\s*,\s*(?P<condition>.*?)\s*\)\s*;?\s*$'
)

#: One non-empty, non-comment line per `file:line` target, as KAMain's `-target-list` and
#: `BBtargets.txt` both use (`instrument.sh`: `awk -F: '{print $1":"$2}'`, one per line).
_BBTARGET_LINE = re.compile(r"^\s*([^\s:#][^:]*):(\d+)\s*$")


@dataclass(frozen=True)
class MagmaTarget:
    """One `bug.targets[]` entry: a `file:line` KAMain resolved plus, when known, the predicate."""

    location: str
    condition: str | None = None
    evidence: str | None = None

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"location": self.location}
        if self.condition is not None:
            out["condition"] = self.condition
        if self.evidence is not None:
            out["evidence"] = self.evidence
        return out


@dataclass(frozen=True)
class MagmaAdapterInput:
    """Everything the adapter needs; nothing here requires re-deriving anything Magma already
    computed (BBtargets, the patch, the built binary) — that is the whole point of the adapter.

    Attributes:
        campaign_id: Campaign id (state directory name); defaults to `<target_name>-<bug_id>`.
        target_name: Magma's own target directory name (`lua`, `libpng`, ...), used only for the
            default campaign id and `notes` — never interpreted.
        target_repo: Absolute path to the (patched, built) target source tree.
        bug_id: Magma bug id, e.g. `LUA001`.
        binary: Absolute path to the built harness binary `run_cmd` invokes.
        run_cmd: Full command template (`@@` substituted for the input file). Defaults to
            `<binary> @@`.
        targets: Target locations, normally from `parse_bbtargets(BBtargets.txt)`.
        language: `target.language`; Magma benchmarks are C/C++.
        entry_cwd: `entry.cwd`, when the binary must run from a specific directory.
        input_channel: `entry.input_channel`; Magma's `afl_driver.cpp` harnesses take a file.
        bug_patch: Path to `<BUG_ID>.patch`, named in the yaml's provenance header (the campaign
            schema's `bug` carries only `targets`).
        bitcode: The `*.0.0.preopt.bc` KAMain would analyse fresh (mode `lto`/`wllvm`).
        entries: KAMain `-entry-list`; Magma's harnesses have no `LLVMFuzzerTestOneInput` symbol
            once linked into the AFL driver, so `main` is the correct default.
        prebuilt_dir: Existing KAMain text outputs (Magma's `SKIP_STATIC_ANALYSIS` path); when
            given, `analysis.static.mode` becomes `prebuilt` and `bitcode`/`entries` are dropped.
        lto_libs: Static dependency libraries also needing an LTO build (zlib/termcap/readline
            for lua; see `magma/fuzzers/pbfuzz/build.sh`'s `build_llvm_bitcode_libs`).
        seeds_dir: `analysis.corpus.seeds_dir`; Magma ships one per target under
            `magma/targets/<name>/corpus/<program>`.
        output_dir: `output.dir`; defaults to `<target_repo>/.pbfuzz/<campaign_id>`.
        static_analysis: False when kanalyzer is not installed and no `prebuilt_dir` exists:
            static analysis is recorded as disabled and deviation detection drops to
            `target_only` (`critical_bb` needs static analysis).
    """

    target_name: str
    target_repo: str
    bug_id: str
    binary: str
    targets: tuple[MagmaTarget, ...]
    campaign_id: str | None = None
    run_cmd: str | None = None
    language: str = "c"
    entry_cwd: str | None = None
    input_channel: str = "file"
    bug_patch: str | None = None
    bitcode: str | None = None
    entries: tuple[str, ...] = ("main",)
    prebuilt_dir: str | None = None
    lto_libs: tuple[str, ...] = ()
    seeds_dir: str | None = None
    output_dir: str | None = None
    static_analysis: bool = True


def parse_bbtargets(text: str) -> tuple[str, ...]:
    """Parse a KAMain `BBtargets.txt`: one `file:line` per non-empty, non-comment line.

    Args:
        text: The file's contents.

    Returns:
        The `file:line` strings, in file order, blank/comment lines dropped.
    """
    out: list[str] = []
    for line in text.splitlines():
        m = _BBTARGET_LINE.match(line)
        if m is not None:
            out.append(f"{m.group(1)}:{m.group(2)}")
    return tuple(out)


def parse_magma_log_condition(source_line: str) -> str | None:
    """Extract the condition argument from one `MAGMA_LOG("<bug>", <condition>);` source line.

    Args:
        source_line: The exact line `BBtargets.txt` points at, from the applied (patched) source.

    Returns:
        The condition expression text, or `None` if the line has no `MAGMA_LOG(...)` call — a
        target line is required to carry an instruction (PLAN §1's kernel-analyzer pitfalls), so a
        non-match here means the target location needs a second look, not that the call is absent
        for spurious reasons.
    """
    m = _MAGMA_LOG_CALL.search(source_line)
    return m.group("condition") if m is not None else None


def _default_campaign_id(input: MagmaAdapterInput) -> str:
    return f"{input.target_name}-{input.bug_id}".lower()


def find_magma_log_condition(target_repo: str | Path, location: str) -> str | None:
    """Read the `MAGMA_LOG(...)` condition at a `file:line` target from the patched source tree.

    `BBtargets.txt` names files by basename (`instrument.sh` strips directories), so the file is
    looked up at the repo root first, then anywhere below it; the first copy whose line carries a
    `MAGMA_LOG` call wins.

    Args:
        target_repo: The patched target source tree.
        location: A `file:line` target.

    Returns:
        The condition expression, or `None` when no file in the tree has a `MAGMA_LOG` call there.
    """
    name, _, line_no = location.rpartition(":")
    repo = Path(target_repo)
    candidates = [repo / name] + sorted(p for p in repo.rglob(Path(name).name) if p != repo / name)
    for path in candidates:
        try:
            lines = path.read_text(errors="replace").splitlines()
        except OSError:
            continue
        index = int(line_no) - 1
        if 0 <= index < len(lines):
            condition = parse_magma_log_condition(lines[index])
            if condition is not None:
                return condition
    return None


def build_campaign(input: MagmaAdapterInput) -> dict[str, Any]:
    """Build a confirmed campaign dict for one Magma bug.

    Args:
        input: Everything the adapter needs (see `MagmaAdapterInput`).

    Returns:
        A dict matching `contracts/campaign.schema.json`, with `confirmed: true` already set —
        headless runs need no interactive step, since every field traces back to Magma's own,
        already-reviewed ground truth (the patch, BBtargets.txt, the built binary).

    Raises:
        ValueError: `targets` is empty — a Magma bug always has at least one MAGMA_LOG call site,
            so an empty list means the caller failed to parse `BBtargets.txt`, not that the bug
            has no location.
    """
    if len(input.targets) == 0:
        raise ValueError(
            f"{input.bug_id}: no target locations given — parse the target's BBtargets.txt with "
            "parse_bbtargets() first; a Magma bug always has at least one MAGMA_LOG call site."
        )
    campaign_id = input.campaign_id or _default_campaign_id(input)
    binary_name = Path(input.binary).name
    run_cmd = input.run_cmd or f"{input.binary} @@"
    output_dir = input.output_dir or str(Path(input.target_repo) / ".pbfuzz" / campaign_id)

    static: dict[str, Any]
    deviation: dict[str, Any] = {"enabled": True, "mode": "critical_bb"}
    if not input.static_analysis and input.prebuilt_dir is None:
        static = {
            "enabled": False,
            "disabled_reason": "no kanalyzer install and no pre-built KAMain output for this target",
        }
        deviation["mode"] = "target_only"
    else:
        static = {"enabled": True}
        if input.prebuilt_dir is not None:
            static["mode"] = "prebuilt"
            static["prebuilt_dir"] = input.prebuilt_dir
        else:
            static["mode"] = "lto"
            if input.bitcode is not None:
                static["bitcode"] = input.bitcode
            if input.entries:
                static["entries"] = list(input.entries)
            if input.lto_libs:
                static["lto_libs"] = list(input.lto_libs)
        static["program"] = binary_name

    corpus: dict[str, Any]
    if input.seeds_dir is not None:
        corpus = {"enabled": True, "seeds_dir": input.seeds_dir}
    else:
        corpus = {"enabled": False, "disabled_reason": "no seeds supplied"}

    entry: dict[str, Any] = {
        "kind": "executable",
        "run_cmd": run_cmd,
        "input_channel": input.input_channel,
    }
    if input.entry_cwd is not None:
        entry["cwd"] = input.entry_cwd

    campaign: dict[str, Any] = {
        "version": 1,
        "id": campaign_id,
        "confirmed": True,
        "target": {"repo": input.target_repo, "language": input.language},
        "bug": {"targets": [t.to_dict() for t in input.targets]},
        "entry": entry,
        "oracle": {
            "mode": "preexisting",
            "reached_pattern": re.escape(_REACHED_TEMPLATE.format(bug_id=input.bug_id)),
            "triggered_pattern": re.escape(_TRIGGERED_TEMPLATE.format(bug_id=input.bug_id)),
            "canary_on_trigger": "log",
        },
        "tracer": "auto",
        "output": {"dir": output_dir},
        "analysis": {"static": static, "corpus": corpus, "deviation": deviation},
    }
    return campaign


def provenance_header(input: MagmaAdapterInput, *, now: datetime | None = None) -> str:
    """The comment block `campaign_to_yaml` puts above a generated campaign.

    Args:
        input: The adapter input the campaign was built from.
        now: Clock, injected for tests; defaults to the real current UTC time.

    Returns:
        Plain text, one line per comment line (no `#` prefixes).
    """
    ts = (now or datetime.now(timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines = [
        f"Generated {ts} by the Magma adapter (engine/pbfuzz_engine/adapters/magma.py) for "
        f"{input.target_name}/{input.bug_id}.",
        f"Bug: Magma {input.bug_id} — MAGMA_LOG(\"{input.bug_id}\", <condition>) at "
        + ", ".join(t.location for t in input.targets) + "; the bug triggers when <condition> holds "
        "(bug.targets[].condition).",
    ]
    if input.bug_patch is not None:
        lines.append(f"Bug patch (injects the bug and its MAGMA_LOG canary): {input.bug_patch}")
    lines += [
        f"Oracle: magma/src/canary.c prints '{_REACHED_TEMPLATE.format(bug_id=input.bug_id)}' / "
        f"'{_TRIGGERED_TEMPLATE.format(bug_id=input.bug_id)}' to stderr; oracle.mode is preexisting, "
        "so no canary insertion or rebuild is needed.",
        "confirmed: true because every field traces back to Magma's own ground truth (the bug "
        "patch, BBtargets.txt, the built binary).",
    ]
    return "\n".join(lines)


def campaign_to_yaml(campaign: dict[str, Any], *, header: str | None = None) -> str:
    """Serialise a campaign dict the way `pbfuzz_campaign draft` would write one to disk.

    Plain YAML (no `# inferred:` provenance comments): those annotate values a *questionnaire*
    decided on the user's behalf, which does not apply here — every field traces back to Magma's
    own already-reviewed ground truth, which is what makes `confirmed: true` honest without a
    human in the loop.

    Args:
        campaign: A dict from `build_campaign()`.
        header: Optional text emitted as `#` comment lines above the document.

    Returns:
        The YAML text, `\n`-terminated.
    """
    body = yaml.safe_dump(campaign, sort_keys=False, default_flow_style=False, allow_unicode=True)
    if header is None:
        return body
    return "".join(f"# {line}".rstrip() + "\n" for line in header.splitlines()) + body


def _parse_target_arg(raw: str) -> MagmaTarget:
    """Parse one `--target file:line[|condition]` CLI argument."""
    location, _, condition = raw.partition("|")
    if not _BBTARGET_LINE.match(location):
        raise argparse.ArgumentTypeError(f"not a file:line location: {location!r}")
    return MagmaTarget(location=location, condition=condition or None)


def _build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m pbfuzz_engine.adapters.magma",
        description=(
            "Generate a confirmed pbfuzz.campaign.yaml for one Magma bug, for headless runs "
            "(`dsh --profile headless \"/pbfuzz run <path>\"`)."
        ),
    )
    parser.add_argument("--target-name", required=True, help="Magma target directory name, e.g. lua.")
    parser.add_argument("--target-repo", required=True, help="Absolute path to the built target source tree.")
    parser.add_argument("--bug-id", required=True, help="Magma bug id, e.g. LUA001.")
    parser.add_argument("--binary", required=True, help="Absolute path to the built harness binary.")
    parser.add_argument(
        "--bbtargets", help="Path to BBtargets.txt; parsed for --target locations (repeatable flag not needed).",
    )
    parser.add_argument(
        "--target", dest="targets", action="append", type=_parse_target_arg, default=[],
        help="A file:line[|condition] target location; repeatable. Combined with --bbtargets if both are given.",
    )
    parser.add_argument("--campaign-id")
    parser.add_argument("--run-cmd")
    parser.add_argument("--language", default="c")
    parser.add_argument("--cwd", dest="entry_cwd")
    parser.add_argument("--input-channel", default="file", choices=["file", "stdin"])
    parser.add_argument("--bug-patch")
    parser.add_argument("--bitcode")
    parser.add_argument("--entries", action="append", default=[])
    parser.add_argument("--prebuilt-dir")
    parser.add_argument("--lto-lib", dest="lto_libs", action="append", default=[])
    parser.add_argument(
        "--no-static-analysis", dest="static_analysis", action="store_false",
        help="Record static analysis as disabled (no kanalyzer, no --prebuilt-dir); deviation becomes target_only.",
    )
    parser.add_argument("--seeds-dir")
    parser.add_argument("--output-dir")
    parser.add_argument("--write", help="Write the yaml here instead of stdout.")
    return parser


def main(argv: list[str] | None = None) -> int:
    """CLI entry point: `python -m pbfuzz_engine.adapters.magma`."""
    args = _build_arg_parser().parse_args(argv)
    targets: list[MagmaTarget] = list(args.targets)
    if args.bbtargets is not None:
        text = Path(args.bbtargets).read_text()
        known = {t.location for t in targets}
        targets.extend(MagmaTarget(location=loc) for loc in parse_bbtargets(text) if loc not in known)
    # The predicate at each MAGMA_LOG call site is the bug's trigger condition; hand it to the agent.
    targets = [
        t if t.condition is not None
        else MagmaTarget(location=t.location, condition=find_magma_log_condition(args.target_repo, t.location),
                         evidence=t.evidence)
        for t in targets
    ]
    if not targets:
        print(
            "error: no target locations — pass --bbtargets <file> and/or one or more --target file:line",
            file=sys.stderr,
        )
        return 2

    campaign_input = MagmaAdapterInput(
        target_name=args.target_name,
        target_repo=args.target_repo,
        bug_id=args.bug_id,
        binary=args.binary,
        targets=tuple(targets),
        campaign_id=args.campaign_id,
        run_cmd=args.run_cmd,
        language=args.language,
        entry_cwd=args.entry_cwd,
        input_channel=args.input_channel,
        bug_patch=args.bug_patch,
        bitcode=args.bitcode,
        entries=tuple(args.entries) or ("main",),
        prebuilt_dir=args.prebuilt_dir,
        lto_libs=tuple(args.lto_libs),
        seeds_dir=args.seeds_dir,
        output_dir=args.output_dir,
        static_analysis=args.static_analysis,
    )
    text = campaign_to_yaml(build_campaign(campaign_input), header=provenance_header(campaign_input))
    if args.write is not None:
        out_path = Path(args.write)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text)
        print(f"wrote {out_path}", file=sys.stderr)
    else:
        print(text, end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
