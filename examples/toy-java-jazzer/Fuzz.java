/**
 * The project's existing Jazzer harness (entry.kind: api, harness_function: fuzzerTestOneInput)
 * — the standard Jazzer/libFuzzer entry-point shape, so `/pbfuzz`'s onboarding recognises this as
 * a harness to reuse rather than something to build.
 *
 * No {@code main} method is needed: the Jazzer native launcher (`jazzer --target_class=Fuzz`)
 * supplies its own entry point, the same way a libFuzzer C/C++ harness needs no {@code main} when
 * compiled with `-fsanitize=fuzzer`. Two ways to run it:
 *
 * - `jazzer --target_class=Fuzz` (no file argument): Jazzer's own continuous fuzzing loop —
 *   useful for a human to sanity-check the harness directly.
 * - `jazzer --target_class=Fuzz -- <input-file>` (pbfuzz's `entry.run_cmd`): Jazzer's native
 *   launcher replays exactly that file through {@code fuzzerTestOneInput} once and exits — the
 *   same one-shot convention libFuzzer binaries use for a crash testcase, so pbfuzz's own
 *   two-stage PBT engine drives it the same way it drives any other {@code entry.kind: api}
 *   target with no Jazzer-specific code anywhere in pbfuzz for this.
 */
public final class Fuzz {
    private Fuzz() {}

    public static void fuzzerTestOneInput(byte[] data) {
        Toy.process(data);
    }
}
