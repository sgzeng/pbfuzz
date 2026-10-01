#!/usr/bin/env bash
# Builds the V4 verification target: compiles the toy target and its Jazzer harness against the
# Jazzer standalone jar, so `entry.run_cmd` (the `jazzer` native launcher with --target_class=Fuzz)
# has a Fuzz.class/Toy.class on the classpath to load.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

JAZZER_HOME="${JAZZER_HOME:-$HOME/.local/opt/jazzer}"
JAZZER_JAR="${JAZZER_JAR:-$JAZZER_HOME/jazzer_standalone.jar}"

if [ ! -f "$JAZZER_JAR" ]; then
  echo "jazzer_standalone.jar not found at $JAZZER_JAR (set JAZZER_JAR or JAZZER_HOME)" >&2
  exit 1
fi

javac -cp "$JAZZER_JAR" Toy.java Fuzz.java
echo "built Toy.class + Fuzz.class ($(javac -version 2>&1))"
