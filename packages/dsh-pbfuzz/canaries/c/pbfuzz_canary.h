/*
 * pbfuzz reach/trigger canary — C and C++.
 *
 * Emits the two stderr markers the campaign oracle matches:
 *
 *   PBFUZZ_REACHED: <id>
 *   PBFUZZ_TRIGGERED: <id>
 *
 * which are exactly what the default `oracleDefaults.reachedPattern`
 * (`PBFUZZ_REACHED:\s*(\S+)`) and `oracleDefaults.triggeredPattern`
 * (`PBFUZZ_TRIGGERED:\s*(\S+)`) in pbfuzz-settings.schema.json expect. A campaign
 * using these canaries sets `oracle.mode: canary` and copies those two regexes into
 * `oracle.reached_pattern` / `oracle.triggered_pattern`.
 *
 * Insertion is a REVERSIBLE PATCH: see ../README.md. Never edit the target in place
 * without recording the patch at `oracle.canary_patch`.
 *
 * Build: add the directory holding this header to the target's include path, e.g.
 *   CFLAGS += -I<canaries>/c -include pbfuzz_canary.h
 * The `-include` form needs no #include line in the target source, which keeps the
 * patch to exactly the canary call sites.
 *
 * Abort mode: compile with -DPBFUZZ_CANARY_ABORT to make a trigger abort the process.
 * That corresponds to `oracle.canary_on_trigger: abort`. The default (`log`) keeps the
 * run alive so one execution can report several signals.
 */
#ifndef PBFUZZ_CANARY_H
#define PBFUZZ_CANARY_H

#include <stdio.h>
#include <stdlib.h>

#ifdef __cplusplus
extern "C" {
#endif

/*
 * Report reaching `id`, and triggering it when `condition` is non-zero.
 * `static inline` keeps this header-only: no extra object file to link, which
 * matters because the canary must survive the target's own build system.
 */
static inline void pbfuzz_canary(const char *id, int condition)
{
    fprintf(stderr, "PBFUZZ_REACHED: %s\n", id);
    if (condition) {
        fprintf(stderr, "PBFUZZ_TRIGGERED: %s\n", id);
    }
    fflush(stderr);
#ifdef PBFUZZ_CANARY_ABORT
    if (condition) {
        abort();
    }
#endif
}

/*
 * The call site form. Use this, not `pbfuzz_canary` directly: the do/while wrapper
 * makes the canary a single statement, so it can be inserted into an unbraced
 * `if (...)` body without changing the target's control flow.
 *
 *   PBFUZZ_LOG("LUA001", INT_MAX - nextra <= (n - 1));
 */
#define PBFUZZ_LOG(id, cond) do { pbfuzz_canary((id), (int)(cond)); } while (0)

/* Expression form, for places where a statement does not fit (e.g. a comma expression). */
#define PBFUZZ_LOG_V(id, cond) (pbfuzz_canary((id), (int)(cond)))

#ifdef __cplusplus
}
#endif

#endif /* PBFUZZ_CANARY_H */
