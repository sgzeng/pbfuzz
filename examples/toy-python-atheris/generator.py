"""pbfuzz input generator for toy-python-atheris (toy.py:24).

The target is the Atheris harness's `TestOneInput`, which hands `toy.process()` exactly the bytes
of the input file (harness.py:26-27 consumes the whole buffer). `process()` has one decision tree
and no parser, so the input is not a container format — it is five meaningful bytes.

The acceptance set is known in closed form (precondition R7) rather than searched for:

    { data : len(data) >= 5, data[0:4] == b"FUZZ", data[4] == 0x42 }

so the generator's job is to place those bytes, and the parameter space exists to sweep the one
byte that separates reaching from triggering.

Two routes, chosen by `use_base_seed`:

  * direct construction (trigger plan TP1) — emit the magic followed by the crash byte, with an
    optional unconstrained tail.
  * base-seed mutation (trigger plan TP2) — start from seeds/magic-near-miss.bin, which already
    reaches toy.py:24 (it prints the reach marker at toy.py:23 and leaves triggered=false), and
    rewrite only its fifth byte. That fifth byte is the entire difference between the shipped
    near-miss seed and a PoC: hex 46555a5a41 versus 46555a5a42.

`prefix` is a categorical so the batch can carry a negative control for precondition R4: every
non-"FUZZ" value fails the outer guard at toy.py:22 and never reaches toy.py:24. It is not
speculative — the shipped non-reaching seeds are exactly this case (`plain.bin` is b"hello").

Deterministic by construction: every byte is a function of the parameters, and the tail is padded
with a fixed fill byte, so the same assignment always produces the same bytes and a triggering
case stays reproducible.
"""

#: The 4-byte magic the target checks at toy.py:22.
MAGIC = b"FUZZ"

#: The byte at offset 4 that toy.py:24 compares against the literal 0x42.
TRIGGER_BYTE = 0x42

#: Offset of the crash byte: the first byte after the 4-byte magic.
CRASH_BYTE_OFFSET = 4

#: The 5-byte prefix every crashing input must start with.
CRASH_PREFIX = MAGIC + bytes([TRIGGER_BYTE])

#: Byte used to pad the unconstrained tail. toy.py references no offset above 4, so the tail's
#: content cannot affect reach or trigger; a constant keeps the generator deterministic.
TAIL_FILL = 0x00

#: The near-miss seed the mutation route starts from: b"FUZZ\x41" (5 bytes), one byte away from
#: the trigger and already a reaching input.
DEFAULT_BASE_SEED = (
    "/mnt/work/pbfuzz/pbfuzz-dsh/examples/toy-python-atheris/seeds/magic-near-miss.bin"
)

#: Prefixes the space can select. "FUZZ" reaches toy.py:24; the others are R4 negative controls.
PREFIX_VALUES = {
    "FUZZ": MAGIC,
    "fuzz": b"fuzz",
    "FUZ": b"FUZ",
    "FUZZY": b"FUZZY",
    "ZZUF": b"ZZUF",
    "hello": b"hello",
}

#: Fallback when a categorical arrives as an unknown string: the reaching prefix.
DEFAULT_PREFIX = "FUZZ"


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


def generate(**params) -> bytes:
    """Build one input from the parameter space.

    Keyword arguments (all optional, in-domain defaults):

        prefix:        categorical — the leading bytes; only "FUZZ" satisfies precondition R4
        crash_byte:    int — the byte tested at offset 4; only 0x42 triggers BP1
        tail_length:   int — unconstrained bytes appended after the crash byte
        use_base_seed: bool — mutate the near-miss seed instead of building from scratch
        base_seed:     path to that seed, supplied by a `base_seed` parameter

    Returns the input bytes for this assignment.
    """
    prefix = _resolve_prefix(params.get("prefix", DEFAULT_PREFIX))
    crash_byte = int(params.get("crash_byte", TRIGGER_BYTE)) & 0xFF
    tail_length = int(params.get("tail_length", 0))
    use_base_seed = bool(params.get("use_base_seed", False))
    base_seed = params.get("base_seed", DEFAULT_BASE_SEED)

    if use_base_seed:
        buf = bytearray(_read_seed(base_seed))
    else:
        buf = bytearray()

    # The reach precondition (R4): a magic prefix of at least 4 bytes. Written for both routes
    # so an assignment that changes only the crash byte still reaches toy.py:24.
    buf[0:len(prefix)] = prefix

    # The trigger (BP1). On the mutation route this replaces the seed's 0x41 with our value,
    # which is the only difference between the near-miss seed and a PoC. The crash byte is only
    # meaningful when the prefix is the magic, but writing it unconditionally keeps the mapping
    # from parameters to bytes total.
    if len(buf) <= CRASH_BYTE_OFFSET:
        buf.extend(b"\x00" * (CRASH_BYTE_OFFSET + 1 - len(buf)))
    buf[CRASH_BYTE_OFFSET] = crash_byte

    # Unconstrained tail: toy.py compares no offset above 4, so this cannot change the outcome.
    # It is present so the space can express "longer than the 5-byte minimum", the axis TP3
    # checks is genuinely free.
    if tail_length > 0:
        buf.extend(bytes([TAIL_FILL]) * tail_length)

    return bytes(buf)
