"""pbfuzz input generator for toy-java-jazzer (Toy.java:25).

The target's entry is the Jazzer harness `Fuzz.fuzzerTestOneInput(byte[])`, which hands
`Toy.process()` exactly the bytes of the input file (Fuzz.java:21-23 passes the array straight
through). `process()` has one nested decision and no parser, so the input is not a container
format — it is five meaningful bytes.

The acceptance set is known in closed form (precondition R7) rather than searched for:

    { data : len(data) >= 5, data[0:4] == b"JAVA", data[4] == 0x99 }

so the generator's job is to place those bytes, and the parameter space exists to sweep the one
byte that separates reaching from triggering.

Two routes, chosen by `use_base_seed`:

  * direct construction (trigger plan TP1) — emit the magic followed by the crash byte, with an
    optional unconstrained tail.
  * base-seed mutation (trigger plan TP2) — start from seeds/magic-near-miss.bin, which already
    reaches Toy.java:25 (it prints the reach marker at Toy.java:24 and leaves triggered=false),
    and rewrite only its fifth byte. That fifth byte is the entire difference between the shipped
    near-miss seed and a PoC: hex 4a41564198 versus 4a41564199.

`prefix` is a categorical so the batch can carry a negative control for precondition R4: every
value that does not begin with "JAVA" fails the outer guard at Toy.java:23 and never reaches
Toy.java:25. It is not speculative — the shipped non-reaching seeds are exactly this case
(`plain.bin` is a 48-byte ASCII sentence, `random.bin` is bytes 01..14).

Deterministic by construction: every byte is a function of the parameters, and the tail is padded
with a fixed fill byte, so the same assignment always produces the same bytes and a triggering
case stays reproducible.
"""

#: The 4-byte magic the target checks at Toy.java:23.
MAGIC = b"JAVA"

#: The byte at offset 4 that Toy.java:25 compares against the literal 0x99.
TRIGGER_BYTE = 0x99

#: Offset of the crash byte: the first byte after the 4-byte magic.
CRASH_BYTE_OFFSET = 4

#: The 5-byte prefix every crashing input must start with.
CRASH_PREFIX = MAGIC + bytes([TRIGGER_BYTE])

#: Byte used to pad the unconstrained tail. Toy.java references no offset above 4, so the tail's
#: content cannot affect reach or trigger; a constant keeps the generator deterministic.
TAIL_FILL = 0x00

#: The near-miss seed the mutation route starts from: "JAVA" + 0x98 (5 bytes), one byte away from
#: the trigger and already a reaching input.
DEFAULT_BASE_SEED = (
    "/mnt/work/pbfuzz/pbfuzz-dsh/examples/toy-java-jazzer/seeds/magic-near-miss.bin"
)

#: Prefixes the space can select. "JAVA" reaches Toy.java:25; the others are R4 negative controls
#: ("java" and "JAV" are the case and length neighbours, "FUZZ" is the other toy target's magic).
PREFIX_VALUES = {
    "JAVA": MAGIC,
    "java": b"java",
    "JAV": b"JAV",
    "JAVAX": b"JAVAX",
    "AVAJ": b"AVAJ",
    "FUZZ": b"FUZZ",
}

#: Fallback when a categorical arrives as an unknown string: the reaching magic.
DEFAULT_PREFIX = "JAVA"


def _resolve_prefix(name: str) -> bytes:
    """Map a categorical prefix name to its bytes, falling back to the reaching magic."""
    return PREFIX_VALUES.get(name, PREFIX_VALUES[DEFAULT_PREFIX])


def _read_seed(path: str) -> bytes:
    """Read the base seed, returning empty bytes when it cannot be read.

    An unreadable seed must not raise: the parameter space permits this assignment, so the
    generator degrades to direct construction instead of failing the iteration (the skill's
    totality rule).
    """
    try:
        with open(path, "rb") as handle:
            return handle.read()
    except OSError:
        return b""


def _fit_tail(body: bytearray, tail_length: int) -> bytes:
    """Truncate or pad `body` so it carries exactly `tail_length` bytes above offset 4."""
    end = CRASH_BYTE_OFFSET + 1 + tail_length
    del body[end:]
    if len(body) < end:
        body += bytes([TAIL_FILL]) * (end - len(body))
    return bytes(body)


def generate(**params) -> bytes:
    """Build one input file from a parameter assignment.

    Parameters (all optional, each with the default the plan's TP1 case uses):
        prefix:       categorical name of the 4-byte magic, or any other prefix (R4 control).
        crash_byte:   the byte placed at offset 4; 0x99 triggers BP1 at Toy.java:25.
        tail_length:  number of unconstrained bytes appended above offset 4.
        use_base_seed: route the bytes through the near-miss seed instead of the literal magic.
        base_seed:    path of the seed the mutation route starts from.

    Returns:
        The input bytes; never raises for an assignment the parameter space permits.
    """
    crash_byte = int(params.get("crash_byte", TRIGGER_BYTE)) & 0xFF
    tail_length = max(0, int(params.get("tail_length", 0)))
    use_base_seed = bool(params.get("use_base_seed", False))

    if use_base_seed:
        seed = _read_seed(str(params.get("base_seed") or DEFAULT_BASE_SEED))
        if len(seed) >= CRASH_BYTE_OFFSET + 1:
            body = bytearray(seed)
            # The whole point of this route: keep the seed's shape, rewrite only the crash byte.
            body[CRASH_BYTE_OFFSET] = crash_byte
            return _fit_tail(body, tail_length)
        # A missing or too-short seed falls through to direct construction rather than raising.

    prefix = _resolve_prefix(str(params.get("prefix", DEFAULT_PREFIX)))
    return prefix + bytes([crash_byte]) + bytes([TAIL_FILL]) * tail_length
