/*
 * pbfuzz reach/trigger canary — Java.
 *
 * Emits the two stderr markers the campaign oracle matches:
 *
 *   PBFUZZ_REACHED: <id>
 *   PBFUZZ_TRIGGERED: <id>
 *
 * which are what the default `oracleDefaults.reachedPattern` (`PBFUZZ_REACHED:\s*(\S+)`)
 * and `oracleDefaults.triggeredPattern` (`PBFUZZ_TRIGGERED:\s*(\S+)`) in
 * pbfuzz-settings.schema.json expect. A campaign using this sets `oracle.mode: canary` and
 * copies those two regexes into `oracle.reached_pattern` / `oracle.triggered_pattern`.
 *
 * Insertion is a reversible patch — see ../README.md.
 *
 * Installation: put this file on the target's source path (default package keeps the call
 * sites import-free) or give it a package declaration matching where you place it, and add
 * the corresponding `import` to each patched file. Compiling one extra source file is
 * usually less invasive than adding a jar to the build.
 *
 * Abort mode: set PBFUZZ_CANARY_ABORT=1 in the environment to make a trigger halt the JVM,
 * matching `oracle.canary_on_trigger: abort`. The default (`log`) keeps the run alive so one
 * execution can report several signals.
 */
public final class PbfuzzCanary {

    private static final boolean ABORT = "1".equals(System.getenv("PBFUZZ_CANARY_ABORT"));

    private PbfuzzCanary() {
    }

    /**
     * Report reaching {@code bugId}, and triggering it when {@code condition} is true.
     * The condition is evaluated by the caller, so keep it side-effect free: the canary
     * must not change the behaviour it is observing.
     */
    public static void log(String bugId, boolean condition) {
        System.err.println("PBFUZZ_REACHED: " + bugId);
        if (condition) {
            System.err.println("PBFUZZ_TRIGGERED: " + bugId);
        }
        System.err.flush();
        if (condition && ABORT) {
            // Runtime.halt skips shutdown hooks, so a harness cannot swallow the trigger.
            Runtime.getRuntime().halt(134);
        }
    }

    /** Reach-only canary, for a location with no predicate to evaluate. */
    public static void reached(String bugId) {
        System.err.println("PBFUZZ_REACHED: " + bugId);
        System.err.flush();
    }

    /** Trigger-only canary, for a site already known to be reached. */
    public static void triggered(String bugId) {
        System.err.println("PBFUZZ_TRIGGERED: " + bugId);
        System.err.flush();
        if (ABORT) {
            Runtime.getRuntime().halt(134);
        }
    }
}
