/**
 * The bug under test: a tiny parser with a deliberately narrow crash condition.
 *
 * Not a fuzz entry point on its own — {@code Fuzz.java} is that; this class is the "project" a
 * harness wraps, kept separate the way a real target would be.
 */
public final class Toy {
    private Toy() {}

    /**
     * Throw iff {@code data} starts with the 4-byte magic {@code JAVA} followed by the byte
     * {@code 0x99}.
     *
     * A 5-byte, exactly-one-value bug: no seed in the corpus is anywhere close, so finding it is
     * a genuine search, not a coincidence — matching V4's point (PLAN.md §4): the questionnaire
     * and the engine work the same way for Java/Jazzer as for C/C++ and Python, entirely through
     * {@code entry.run_cmd} and the stderr oracle, with no Java-specific code anywhere in pbfuzz
     * itself. The two prints are this project's own pre-existing reach/trigger markers
     * (oracle.mode: preexisting) — the same "the project already tells you" pattern the other
     * toy targets use, spelled in Java.
     */
    public static void process(byte[] data) {
        if (data.length >= 4 && data[0] == 'J' && data[1] == 'A' && data[2] == 'V' && data[3] == 'A') {
            System.err.println("toy: magic JAVA prefix seen");
            if (data.length >= 5 && (data[4] & 0xFF) == 0x99) {
                System.err.println("toy: crash byte 0x99 seen");
                throw new IllegalStateException("crash: JAVA magic followed by byte 0x99");
            }
        }
    }
}
