> Historical notes from the original V1–V4 verification of this example (DSH 0.1.x). Paths below predate
> `generator.py`/`crashes/` moving into `reference/` and `pbfuzz.campaign.yaml` becoming
> `../campaign.template.yaml`; the quick start is in [`../README.md`](../README.md).

# readelf-c

The V1 verification target (PLAN.md §4, HANDOFF-AGENT-PROMPT.md): a small C++ program that parses
a simplified ELF header and aborts on a specific, hard-to-hit combination of fields. It doubles as
the primary C/C++ example for pbfuzz-dsh — static analysis (kanalyzer), corpus analysis and
deviation detection all apply to it directly, and its input arrives as a file argument (no harness
adapter needed on top of the executable itself).

## The bug

`check_dangerous_elf_combination` (`readelf.cpp:75`) calls `abort()` when the header claims to be
64-bit (`e_ident[EI_CLASS] == ELFCLASS64`), big-endian (`e_ident[EI_DATA] == ELFDATA2MSB`), version 1
(`e_ident[EI_VERSION] == EV_CURRENT`), **and** the entry point equals `0x400000` or `0x8048000`. The
crash line is `readelf.cpp:93` (`if (entry == 0x400000 || entry == 0x8048000 || …)`), which is also
kernel-analyzer's target (`/mnt/work/pbfuzz/src/tests/fixtures/readelf_static_analysis/BBtargets.txt`),
so the two agree.

V1's PIER run measured part of the real acceptance set empirically (see `pbfuzz.campaign.yaml`'s
`notes` and `crashes/`) and reported it as exactly `{0x400000, 0x8048000}`, independent of byte
order, reasoning that `raw == bswap(bswap(raw))` makes the `__builtin_bswap64` at `readelf.cpp:90`
dead code. **That claim is wrong, found and corrected during V4** (`docs/verification-notes.md`):
the code applies `bswap64` once to `header.e_entry` (only for `EI_DATA == ELFDATA2MSB`, i.e.
big-endian files) and compares the result against the *same* two literals the raw check uses —
`raw == bswap(bswap(raw))` is a fact about applying the swap *twice*, and is irrelevant here, where
it's applied once. For a big-endian file, `bswap64(header.e_entry) == 0x400000` requires
`header.e_entry == bswap64(0x400000) = 0x400000000000` — a distinct raw field value from `0x400000`
itself. The true accepted set is **four** raw `e_entry` values: `{0x400000, 0x8048000}` trigger
regardless of byte order (the raw disjuncts), and `{0x400000000000, 0x80040800000000}` (`bswap64`
of the first two) trigger *only* for big-endian files (the swapped disjuncts) — verified by hand,
both crash with exit 134. The committed PoC fires the raw disjunct (`entry_point=0x400000`,
little-endian); the two byte-swap-only values were never exercised by this campaign's fuzzing run
and are not reflected in `pbfuzz.campaign.yaml`'s `notes` (a historical record of what the live V1
agent actually measured and believed at the time, left as-is rather than rewritten).

The target already prints its own reach/trigger markers to stderr —
`"bug location reached"` when the class/data/version combination holds, and
`"bug location triggered"` right before the `abort()` — so onboarding's existing-oracle question
(PLAN §2.6, "Existing oracle") applies here without any canary instrumentation.

## Layout

- `readelf.cpp` — the target (copied verbatim from `/mnt/work/pbfuzz/src/tests/fixtures/readelf.cpp`).
- `build.sh` — builds `./readelf` (a plain `-g -O0` debug build, what pbfuzz runs and traces) and,
  when a kanalyzer-compatible clang/lld/llvm-nm are on `PATH`, `readelf.lto.0.0.preopt.bc` (the LTO
  bitcode `kanalyzer_prepare` needs) as a standalone smoke input for kanalyzer.
- `make_seeds.py` — (re)generates `seeds/`: four 64-byte `ELFHeader` seeds spanning
  32-bit/64-bit, little/big-endian and version 0/1, plus one too-short file for the early-return
  path. None of them already satisfy the abort condition — `64bit-be-v1-near-miss.bin` reaches
  `check_dangerous_elf_combination`'s big-endian branch (prints `bug location reached`) with an
  entry point that doesn't match, which is as close as a seed gets without being the actual PoC.
- `pbfuzz.campaign.yaml` — written by `/pbfuzz`'s own questionnaire during the V1 run and copied
  here once confirmed (see `docs/verification.md` for the transcript). Every inferred field carries
  an `# inferred: <evidence>` comment; nothing in it was hand-typed.
- `generator.py` — the PIER-written input generator (`generate(**params) -> bytes`), copied here
  once the campaign reached `SUCCESS`; byte-identical to a hand-built PoC for the same parameters.
- `crashes/poc_round0_s1_stage1_iter1` — the 64-byte proof of vulnerability the campaign found on
  its very first fuzz iteration (PIER round 0, well inside the 5-round budget) and reproduced 4
  times. `./readelf crashes/poc_round0_s1_stage1_iter1` exits 134 (SIGABRT), printing
  `bug location reached` / `bug location triggered` / `Fatal: Dangerous ELF combination detected!`.

## Running it

```bash
./build.sh
python3 make_seeds.py   # only needed if seeds/ is missing or you want to regenerate it
./readelf crashes/poc_round0_s1_stage1_iter1   # exit 134 — the committed PoC, no campaign needed
```

To run the campaign itself: in a DSH session with this directory as the workspace and
`tools.staticAnalysis: kanalyzer`, `corpusAnalysis` and `deviationDetection` enabled in
Settings → PBFuzz, run `/pbfuzz`. The committed `pbfuzz.campaign.yaml` is what that run produced
and confirmed; a fresh run starts its own questionnaire and will write a new campaign under
`.pbfuzz/` rather than overwrite this one.
