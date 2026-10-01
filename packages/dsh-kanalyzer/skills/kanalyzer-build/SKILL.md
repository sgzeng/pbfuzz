---
name: kanalyzer-build
description: Procedure for the kanalyzer build agent — install LLVM 14 and build dependencies, clone or update sgzeng/kernel-analyzer (branch mzt), build KAMain, verify it with kanalyzer_doctor, and record the result. Started by the Build button / `/kanalyzer build`.
---

# Building KAMain

You were started by `/kanalyzer build`. The prompt gives you the resolved settings:
`installDir`, `repoUrl`, `branch`, `llvmPrefix` (may be empty), `buildType`, `jobs` (0 = nproc).
Work through the steps in order. When something fails, **investigate and fix it yourself**
(read the error, install the missing package, adjust the command) — only ask the user when a
decision is genuinely theirs. Linux x86-64 only.

## 1. Toolchain

KAMain needs LLVM **10–16** (APIs it uses were removed in 17); **14 is the verified version**.

- Find an LLVM: `llvmPrefix` if set, else `/usr/lib/llvm-14`, else `/usr/lib/llvm-{15,16,13,12,11,10}`.
  Check `<prefix>/bin/llvm-config --version` and that `<prefix>/bin/clang`, `ld.lld`, `llvm-nm` exist.
- If none: on Debian/Ubuntu,
  `wget https://apt.llvm.org/llvm.sh && chmod +x llvm.sh && sudo ./llvm.sh 14`
  then `sudo apt-get install -y lld-14 clang-14 llvm-14-dev libclang-14-dev`.
- Also required: `cmake` (≥ 3.16), `make`, `git`, a C++17 compiler, `zlib1g-dev`
  (`libzstd-dev`/`libtinfo-dev` if the link complains), and **Boost ≥ 1.81 headers**
  (`libboost-dev`): the repo vendors only `boost/{config,core,unordered}`, and its
  `unordered_flat_map` fails with `'boost/config.hpp' file not found` without the system headers.
  If `sudo` is refused, header-only Boost works from a user directory: pass it as
  `CPATH=<dir>/usr/include` to `make` (e.g. `apt-get download libboost1.83-dev && dpkg-deb -x … <dir>`).
- Every `sudo` command goes through the normal approval prompt — the user is watching this
  session. Batch the packages into as few `sudo apt-get install` calls as possible.

## 2. Source

- Clone target: `<installDir>/kernel-analyzer` (expand `~`).
- Absent → `git clone -b <branch> <repoUrl> <installDir>/kernel-analyzer`.
- Present → `git -C … fetch origin && git -C … checkout <branch> && git -C … pull --ff-only`.
  Do not discard local changes without asking.

## 3. Build

```sh
cd <installDir>/kernel-analyzer
make LLVM_BUILD=<prefix> BUILD_TYPE=<buildType> -j<jobs> KAMain
```

The Makefile's own `BUILD_TYPE` default is broken (`$(BUILD_TYPE:=Release)` evaluates to empty),
so pass it explicitly. If that still configures without a type, run cmake directly:

```sh
mkdir -p build && cd build
PATH=<prefix>/bin:$PATH LLVM_ROOT_DIR=<prefix>/bin LLVM_LIBRARY_DIRS=<prefix>/lib \
  LLVM_INCLUDE_DIRS=<prefix>/include CC=clang CXX=clang++ \
  cmake ../src -DCMAKE_BUILD_TYPE=Release && make -j<jobs>
```

Result: `<installDir>/kernel-analyzer/build/lib/KAMain`. Use the `KAMain` target, not `all`:
the repo's lit tests are stale and are not a signal.

Common failures: wrong LLVM major picked by cmake (`LLVM_DIR` in `build/CMakeCache.txt` — wipe
`build/` and re-run with the right `PATH`), missing zlib/zstd/terminfo at link time, a system
clang ≥ 17 shadowing the prefix.

## 4. Verify

Call `kanalyzer_doctor`. It compiles `selftest/sample.c` with the analyser's clang in LTO mode,
runs KAMain on it, and checks: the target resolves at distance 0, the `main → foo` call edge
exists, critical blocks are non-empty, and a comment line is reported as `no_target` (proving
the silent-failure detection works). A presence check is not enough — only a passing doctor
counts.

## 5. Record

Doctor writes the `kanalyzer.status.*` settings fields (installed, binaryPath, commit,
llvmVersion, lastDoctor, lastDoctorAt, lastDoctorMessage) itself — that is how the settings card
learns the outcome. If you had to use a non-default LLVM, tell the user to set
`kanalyzer.install.llvmPrefix` to it (bitcode for analysis must come from the same major).

Finish with a short summary: LLVM used, commit built, doctor evidence.
