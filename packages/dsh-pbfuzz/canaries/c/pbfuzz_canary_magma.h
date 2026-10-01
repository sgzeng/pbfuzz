/*
 * Magma-compatible pbfuzz canary — C and C++.
 *
 * Emits byte-for-byte what Magma's own `magma_log` writes to stderr:
 *
 *   MAGMA: Bug <id> reached
 *   MAGMA: Bug <id> triggered
 *
 * (verified against magma/src/canary.c: `fprintf(stderr, "MAGMA: Bug %s reached\n", bug)`
 * and `fprintf(stderr, "MAGMA: Bug %s triggered\n", bug)`).
 *
 * WHEN TO USE THIS VARIANT
 *
 * - NOT for a real Magma build. A Magma target already contains MAGMA_LOG canaries, so the
 *   campaign sets `oracle.mode: preexisting` and inserts nothing at all. Instrumenting an
 *   already-instrumented target is how you get double counting.
 * - Use it when you instrument a NON-Magma target but want Magma-shaped output — comparing
 *   against a Magma baseline, or reusing Magma tooling that greps these strings.
 *
 * The matching campaign oracle is:
 *   oracle.mode: canary
 *   oracle.reached_pattern:   "MAGMA: Bug (\\S+) reached"
 *   oracle.triggered_pattern: "MAGMA: Bug (\\S+) triggered"
 *
 * Note this deliberately does NOT reproduce Magma's shared-memory canary counters
 * (`MAGMA_STORAGE`, the producer/consumer buffers, the monitor process). pbfuzz's oracle
 * reads stderr only, so the stderr half is the whole contract. A target that needs the real
 * counters should be built against Magma's own canary.c instead.
 *
 * Abort mode: -DPBFUZZ_CANARY_ABORT, matching `oracle.canary_on_trigger: abort`. Magma's
 * equivalent is MAGMA_FATAL_CANARIES, which raises SIGSEGV; we use abort() (SIGABRT) because
 * the engine reports the signal either way and SIGSEGV would be indistinguishable from a
 * genuine memory fault.
 */
#ifndef PBFUZZ_CANARY_MAGMA_H
#define PBFUZZ_CANARY_MAGMA_H

#include <stdio.h>
#include <stdlib.h>

#ifdef __cplusplus
extern "C" {
#endif

static inline void pbfuzz_magma_log(const char *bug, int condition)
{
    fprintf(stderr, "MAGMA: Bug %s reached\n", bug);
    if (condition) {
        fprintf(stderr, "MAGMA: Bug %s triggered\n", bug);
    }
    fflush(stderr);
#ifdef PBFUZZ_CANARY_ABORT
    if (condition) {
        abort();
    }
#endif
}

/* Same call-site spelling as Magma's, so a patch written for one applies to the other. */
#define MAGMA_LOG(b, c)   do { pbfuzz_magma_log((b), (int)(c)); } while (0)
#define MAGMA_LOG_V(b, c) (pbfuzz_magma_log((b), (int)(c)))

/*
 * Magma's MAGMA_AND / MAGMA_OR are real functions, so BOTH operands are always evaluated.
 * These macros short-circuit instead. That difference is only observable when an operand has
 * a side effect — avoid side effects in a canary condition and the two are equivalent.
 */
#define MAGMA_AND(a, b) ((a) && (b))
#define MAGMA_OR(a, b)  ((a) || (b))

#ifdef __cplusplus
}
#endif

#endif /* PBFUZZ_CANARY_MAGMA_H */
