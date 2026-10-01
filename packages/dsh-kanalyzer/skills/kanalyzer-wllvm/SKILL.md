---
name: kanalyzer-wllvm
description: Procedure for the kanalyzer install-deps agent — check for an existing wllvm install, install it with pip only if genuinely missing, resolve the directory containing wllvm/wllvm++/extract-bc, and verify with kanalyzer_doctor. Started by the settings card's Install wllvm button / `/kanalyzer install-deps`.
---

# Installing wllvm

You were started by `/kanalyzer install-deps`, from the settings card's **Install wllvm** button
after its Self-test found wllvm missing or broken. Work through the steps in order. When
something fails, **investigate and fix it yourself** (read the error, try the fallback command,
adjust how you look for the install) — only ask the user when a decision is genuinely theirs.
Linux x86-64 only.

## 1. Check what's already there

- `which wllvm wllvm++ extract-bc`
- `python3 -c "import wllvm"`

wllvm is often already installed inside some virtualenv or user site-packages directory that
just isn't on `PATH`. If the executables or the importable module exist anywhere, **that's a
PATH problem, not a missing package** — do not install a second copy. Locate the directory (e.g.
`python3 -c "import wllvm, os; print(os.path.dirname(wllvm.__file__))"`, or `pip show -f wllvm`)
and report that directory rather than reinstalling.

## 2. Install only if genuinely missing

- `pip install --user wllvm`
- If `pip` isn't on `PATH`, fall back to `pip3 install --user wllvm` or
  `python3 -m pip install --user wllvm`.
- `--user` puts the scripts in `~/.local/bin` — that's the directory to report in step 3 for a
  fresh install.

## 3. Resolve and report the directory

Confirm `wllvm`, `wllvm++` and `extract-bc` now resolve (`which` each one). Report the
**absolute directory** containing all three — the host needs it to put on the build subprocess's
`PATH`, not just confirmation that they work in your own shell.

## 4. Verify

Call `kanalyzer_doctor`. A passing doctor is the only acceptable proof, exactly as for a KAMain
build — do not claim success from `which` alone; a stale or half-broken install can resolve on
`PATH` and still fail at build time.

Finish with a short summary: what was found vs. installed, the resolved directory, and doctor
evidence.
