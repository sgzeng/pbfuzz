"""Loading and validating `pbfuzz.campaign.yaml`.

The campaign is the whole of what the engine needs to execute a target, and the reason the
framework is language-agnostic: `entry.run_cmd` plus an input channel plus two stderr regexes
describe a libFuzzer harness, an Atheris harness, a Jazzer harness and a plain executable
equally well. See contracts/campaign.schema.json.

Validation is hand-written rather than delegated to a generic JSON-Schema validator so every
rejection can carry the diagnosis and remedies the RPC contract requires.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .errors import CAMPAIGN_INVALID, EngineError, remedy

#: The placeholder `entry.run_cmd` uses for the input file path, AFL-style.
AT_FILE = "@@"

_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_LOCATION_RE = re.compile(r"^.+:[0-9]+$")

_LANGUAGES = {"c", "cpp", "python", "java", "other"}
_INPUT_CHANNELS = {"file", "stdin"}
_ENTRY_KINDS = {"api", "executable"}
_ORACLE_MODES = {"canary", "preexisting"}
_TRACERS = {"auto", "gdb", "lldb", "pymon", "jdb", "off"}


def _invalid(message: str, diagnosis: str, remedies: list[dict[str, Any]]) -> EngineError:
    return EngineError(CAMPAIGN_INVALID, message, diagnosis=diagnosis, remedies=remedies)


def _edit(detail: str) -> list[dict[str, Any]]:
    """The common single remedy: the campaign field needs fixing."""
    return [
        remedy("edit_campaign", "Edit pbfuzz.campaign.yaml", detail=detail, effect="edit_campaign"),
        remedy("rerun_questionnaire", "Re-run the questionnaire", detail="`/pbfuzz` redrafts the campaign from your answers.", effect="manual"),
    ]


@dataclass(frozen=True)
class Entry:
    """`campaign.entry` — how one input is fed to the program under test."""

    kind: str
    run_cmd: str
    input_channel: str
    harness: str | None = None
    harness_function: str | None = None
    cwd: str | None = None
    env: dict[str, str] = field(default_factory=dict)

    @property
    def uses_file(self) -> bool:
        """True when the input is passed as a file path substituted for `@@`."""
        return self.input_channel == "file"


@dataclass(frozen=True)
class Oracle:
    """`campaign.oracle` — how a run is judged, as two stderr regexes."""

    mode: str
    reached_pattern: str
    triggered_pattern: str
    canary_on_trigger: str = "log"
    canary_patch: str | None = None


@dataclass(frozen=True)
class Campaign:
    """A validated campaign, normalised to what the engine actually consumes."""

    id: str
    path: Path
    repo: Path
    language: str
    entry: Entry
    oracle: Oracle
    output_dir: Path
    confirmed: bool = False
    tracer: str = "auto"
    targets: tuple[dict[str, Any], ...] = ()
    seeds_dir: Path | None = None
    corpus_enabled: bool = False
    deviation_enabled: bool = False
    deviation_mode: str = "critical_bb"
    raw: dict[str, Any] = field(default_factory=dict)

    @property
    def state_dir(self) -> Path:
        """`<output.dir>/state` — where `metrics.json` and the agent's blocks live."""
        return self.output_dir / "state"

    @property
    def target_locations(self) -> tuple[str, ...]:
        """The `file:line` locations this campaign is trying to reach."""
        return tuple(str(t["location"]) for t in self.targets if t.get("location"))


def _require(obj: dict[str, Any], key: str, where: str) -> Any:
    if key not in obj or obj[key] is None:
        raise _invalid(
            f"campaign.{where}{key} is required",
            diagnosis=f"`{where}{key}` is missing from the campaign file. It is a required field in campaign.schema.json.",
            remedies=_edit(f"Add `{where}{key}` to pbfuzz.campaign.yaml."),
        )
    return obj[key]


def _as_dict(value: Any, where: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _invalid(
            f"campaign.{where} must be a mapping",
            diagnosis=f"`{where}` is a {type(value).__name__}, but campaign.schema.json declares it an object.",
            remedies=_edit(f"Make `{where}` a mapping in pbfuzz.campaign.yaml."),
        )
    return value


def _enum(value: Any, allowed: set[str], where: str) -> str:
    if value not in allowed:
        raise _invalid(
            f"campaign.{where} must be one of {sorted(allowed)}",
            diagnosis=f"`{where}` is {value!r}, which is not one of the values campaign.schema.json allows: {sorted(allowed)}.",
            remedies=_edit(f"Set `{where}` to one of {sorted(allowed)}."),
        )
    return str(value)


def _compile_pattern(pattern: str, where: str) -> str:
    """Validate an oracle regex at load time, not at the first iteration."""
    try:
        re.compile(pattern)
    except re.error as exc:
        raise _invalid(
            f"campaign.oracle.{where} is not a valid regular expression",
            diagnosis=f"`oracle.{where}` = {pattern!r} failed to compile: {exc}.",
            remedies=_edit(
                f"Fix the regex in `oracle.{where}`. Remember YAML needs backslashes escaped or the "
                f"value single-quoted, e.g. 'PBFUZZ_REACHED:\\s*(\\S+)'."
            ),
        ) from exc
    return pattern


def _validate_entry(raw: dict[str, Any]) -> Entry:
    entry = _as_dict(_require(raw, "entry", ""), "entry")
    kind = _enum(_require(entry, "kind", "entry."), _ENTRY_KINDS, "entry.kind")
    run_cmd = str(_require(entry, "run_cmd", "entry."))
    channel = _enum(_require(entry, "input_channel", "entry."), _INPUT_CHANNELS, "entry.input_channel")

    # The `@@` contract, verified up front: a mismatch here otherwise shows up as every
    # iteration silently running the target on no input at all, which looks like "the bug is
    # unreachable" rather than "the command template is wrong".
    has_at = AT_FILE in run_cmd
    if channel == "file" and not has_at:
        raise _invalid(
            "campaign.entry.run_cmd must contain `@@` when input_channel is `file`",
            diagnosis=(
                f"`entry.input_channel` is `file`, so the input file path is substituted for `@@` in "
                f"`entry.run_cmd`, but the template {run_cmd!r} contains no `@@`. Every run would "
                f"execute the target with no input."
            ),
            remedies=_edit(
                "Either add `@@` where the input file path belongs in `entry.run_cmd`, or set "
                "`entry.input_channel: stdin` if the target reads the input from standard input."
            ),
        )
    if channel == "stdin" and has_at:
        raise _invalid(
            "campaign.entry.run_cmd must not contain `@@` when input_channel is `stdin`",
            diagnosis=(
                f"`entry.input_channel` is `stdin`, so the input is piped to the process, but "
                f"`entry.run_cmd` = {run_cmd!r} still contains the file placeholder `@@`, which "
                f"would be passed to the target as a literal argument."
            ),
            remedies=_edit(
                "Either remove `@@` from `entry.run_cmd`, or set `entry.input_channel: file` if the "
                "target takes the input as a file path argument."
            ),
        )

    env = entry.get("env") or {}
    if not isinstance(env, dict):
        raise _invalid(
            "campaign.entry.env must be a mapping of strings",
            diagnosis=f"`entry.env` is a {type(env).__name__}.",
            remedies=_edit("Make `entry.env` a mapping of environment variable names to string values."),
        )
    return Entry(
        kind=kind,
        run_cmd=run_cmd,
        input_channel=channel,
        harness=entry.get("harness"),
        harness_function=entry.get("harness_function"),
        cwd=entry.get("cwd"),
        env={str(k): str(v) for k, v in env.items()},
    )


def _validate_oracle(raw: dict[str, Any]) -> Oracle:
    oracle = _as_dict(_require(raw, "oracle", ""), "oracle")
    mode = _enum(_require(oracle, "mode", "oracle."), _ORACLE_MODES, "oracle.mode")
    reached = _compile_pattern(str(_require(oracle, "reached_pattern", "oracle.")), "reached_pattern")
    triggered = _compile_pattern(str(_require(oracle, "triggered_pattern", "oracle.")), "triggered_pattern")
    on_trigger = oracle.get("canary_on_trigger", "log")
    if on_trigger not in {"abort", "log"}:
        raise _invalid(
            "campaign.oracle.canary_on_trigger must be `abort` or `log`",
            diagnosis=f"`oracle.canary_on_trigger` is {on_trigger!r}.",
            remedies=_edit("Set `oracle.canary_on_trigger` to `log` (keeps the run alive) or `abort`."),
        )
    return Oracle(
        mode=mode,
        reached_pattern=reached,
        triggered_pattern=triggered,
        canary_on_trigger=str(on_trigger),
        canary_patch=oracle.get("canary_patch"),
    )


def _validate_targets(raw: dict[str, Any]) -> tuple[dict[str, Any], ...]:
    bug = _as_dict(_require(raw, "bug", ""), "bug")
    targets = _require(bug, "targets", "bug.")
    if not isinstance(targets, list) or not targets:
        raise _invalid(
            "campaign.bug.targets must be a non-empty list",
            diagnosis="`bug.targets` is empty; there is nothing for the campaign to aim at.",
            remedies=_edit("Add at least one `{location: file:line}` entry under `bug.targets`."),
        )
    out: list[dict[str, Any]] = []
    for i, target in enumerate(targets):
        target = _as_dict(target, f"bug.targets[{i}]")
        location = str(_require(target, "location", f"bug.targets[{i}]."))
        if not _LOCATION_RE.match(location):
            raise _invalid(
                f"campaign.bug.targets[{i}].location must be `file:line`",
                diagnosis=f"`{location}` does not match the `file:line` form common.schema.json requires.",
                remedies=_edit(f"Rewrite `bug.targets[{i}].location` as `path/to/file.c:123`."),
            )
        out.append(dict(target))
    return tuple(out)


def load_campaign(path: str | Path) -> Campaign:
    """Load, validate and normalise a campaign file.

    Args:
        path: Path to `pbfuzz.campaign.yaml`.

    Returns:
        The validated campaign.

    Raises:
        EngineError: With `CAMPAIGN_INVALID` and actionable remedies when the file is missing,
            unparseable, or violates campaign.schema.json in a way the engine depends on.
    """
    campaign_path = Path(path).expanduser()
    if not campaign_path.is_file():
        raise _invalid(
            f"campaign file not found: {campaign_path}",
            diagnosis=f"No file exists at `{campaign_path}`. The engine is given the campaign path by the plugin.",
            remedies=[
                remedy("check_path", "Check the campaign path", detail=f"`{campaign_path}` does not exist.", effect="edit_campaign"),
                remedy("run_questionnaire", "Create a campaign with `/pbfuzz`", detail="The questionnaire writes pbfuzz.campaign.yaml.", effect="manual"),
            ],
        )
    try:
        raw = yaml.safe_load(campaign_path.read_text(encoding="utf-8"))
    except yaml.YAMLError as exc:
        raise _invalid(
            f"campaign file is not valid YAML: {campaign_path}",
            diagnosis=f"PyYAML could not parse the file: {exc}",
            remedies=_edit("Fix the YAML syntax. Regex patterns usually need single quotes so backslashes survive."),
        ) from exc

    raw = _as_dict(raw, "<root>")

    version = raw.get("version")
    if version != 1:
        raise _invalid(
            "campaign.version must be 1",
            diagnosis=f"`version` is {version!r}; this engine implements campaign schema version 1.",
            remedies=_edit("Set `version: 1`, or upgrade the engine if the campaign was written for a newer schema."),
        )

    campaign_id = str(_require(raw, "id", ""))
    if not _ID_RE.match(campaign_id):
        raise _invalid(
            "campaign.id is not a valid identifier",
            diagnosis=f"`id` = {campaign_id!r} does not match `^[a-z0-9][a-z0-9._-]{{0,63}}$`; it names the state directory.",
            remedies=_edit("Use a short lowercase id such as `libpng-cve-2019-7317`."),
        )

    target = _as_dict(_require(raw, "target", ""), "target")
    repo = Path(str(_require(target, "repo", "target."))).expanduser()
    language = target.get("language", "other")
    if language is not None:
        language = _enum(language, _LANGUAGES, "target.language")

    entry = _validate_entry(raw)
    oracle = _validate_oracle(raw)
    targets = _validate_targets(raw)

    # A drafted campaign leaves `output.dir` out: it is the directory holding the campaign file.
    output = _as_dict(raw.get("output") or {}, "output")
    output_dir = Path(str(output["dir"])).expanduser() if output.get("dir") is not None else campaign_path.resolve().parent
    if not output_dir.is_absolute():
        output_dir = (repo / output_dir).resolve()

    tracer = raw.get("tracer", "auto")
    if tracer is not None:
        tracer = _enum(tracer, _TRACERS, "tracer")

    analysis = raw.get("analysis") or {}
    analysis = _as_dict(analysis, "analysis") if analysis else {}
    corpus_cfg = _as_dict(analysis.get("corpus") or {}, "analysis.corpus") if analysis.get("corpus") else {}
    deviation_cfg = _as_dict(analysis.get("deviation") or {}, "analysis.deviation") if analysis.get("deviation") else {}
    seeds_dir = corpus_cfg.get("seeds_dir")

    return Campaign(
        id=campaign_id,
        path=campaign_path,
        repo=repo,
        language=str(language),
        entry=entry,
        oracle=oracle,
        output_dir=output_dir,
        confirmed=bool(raw.get("confirmed", False)),
        tracer=str(tracer),
        targets=targets,
        seeds_dir=Path(str(seeds_dir)).expanduser() if seeds_dir else None,
        corpus_enabled=bool(corpus_cfg.get("enabled", False)),
        deviation_enabled=bool(deviation_cfg.get("enabled", False)),
        deviation_mode=str(deviation_cfg.get("mode", "critical_bb")),
        raw=raw,
    )
