# readelf-c — PBFuzz in one minute

A tiny C++ ELF-header parser (`readelf.cpp`) with a hidden `abort()`. You give pbfuzz only *where* the
bug is (`readelf.cpp:93`); it plans, writes a generator, fuzzes, and returns a **verified** triggering
input — headless, no prompts.

## Run it

```sh
./install.sh --profile headless            # once, at the repo root
export DEEPSEEK_API_KEY=sk-...
cd examples/readelf-c && ./run.sh          # ~1 minute
```

Needs `clang++` and `gdb`.

## You should see

```
== verdict: /tmp/pbfuzz-readelf-c/.pbfuzz/readelf-c/state/state.json
{ "phase": "SUCCESS", "status": "trigger confirmed", "pier_round": 1,
  "poc": { "input_path": ".../crashes/poc_round0_s1_stage1_iter1", "reproduced_times": 3, ... } }
```

Check it yourself — the PoC aborts with exit 134:

```sh
cd /tmp/pbfuzz-readelf-c && ./readelf .pbfuzz/readelf-c/crashes/poc_round0_s1_stage1_iter1
# bug location reached / bug location triggered / Fatal: Dangerous ELF combination detected!
```

`phase: "STOPPED"` instead means the run hit a budget (`budget.*` in the plugin settings) — try again.

## What's here

| File | |
|---|---|
| `readelf.cpp` | the target |
| `campaign.template.yaml` | the "bug report" handed to pbfuzz: location + trigger condition |
| `run.sh` | stages a clean copy in `/tmp/pbfuzz-readelf-c`, runs the campaign headless, prints the verdict |
| `reference/` | an earlier run's answer (generator, PoC) and notes — **not** visible to the agent, which works in the copy |
