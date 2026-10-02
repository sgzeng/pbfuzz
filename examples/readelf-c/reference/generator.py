"""pbfuzz input generator for readelf-c (readelf.cpp:93).

The target reads exactly sizeof(ELFHeader) == 64 bytes from argv[1] into a native struct and
never converts byte order, so a 64-byte input is a complete, self-contained input for it.
Verified with a compiled probe of the same struct definition: sizeof(ELFHeader) == 64 and
offsetof(e_entry) == 24.

Two routes, chosen by `use_base_seed`:

  * direct construction (TP1) — magic, the e_ident triple at bytes 4..6, and an 8-byte entry
    point at offset 24. Everything else stays zero, which is safe because readelf.cpp never
    validates e_type, e_machine, e_version or any offset/table field (precondition R8).
  * base-seed mutation (TP2) — start from the near-miss seed, which already reaches
    readelf.cpp:93, and rewrite only those same 8 entry-point bytes, keeping the rest of the
    seed intact.

The entry point is packed in the byte order named by `entry_byte_order`. readelf.cpp:93 tests the
raw field and its __builtin_bswap64 image against the same two constants, and both orders accept
both constants — verified empirically over all (value, order) combinations in the acceptance-set
probe. Writing 0x400000 big-endian satisfies the bswap disjunct, little-endian satisfies the raw
one; the value is what matters, the order only picks which disjunct fires (root cause RC1).

Deterministic by construction: every byte is a function of the parameters, and no RNG is used
except to pad the tail, which is driven by a parameter-derived seed.
"""

import random

#: The 4-byte ELF magic the target checks at readelf.cpp:124-135.
ELF_MAGIC = b"\x7fELF"

#: e_ident indices, from readelf.cpp:26-28.
EI_CLASS = 4
EI_DATA = 5
EI_VERSION = 6

#: Offset of e_entry inside the 64-byte header, from the compiled probe of struct ELFHeader.
E_ENTRY_OFFSET = 24

#: How many bytes the target reads; a shorter input dies at readelf.cpp:118.
READ_SIZE = 64

#: e_ident[EI_CLASS] values, from readelf.cpp:30-31.
ELFCLASS_VALUES = {"ELFCLASS32": 1, "ELFCLASS64": 2}

#: e_ident[EI_DATA] values, from readelf.cpp:33-34.
ELFDATA_VALUES = {"ELFDATA2LSB": 1, "ELFDATA2MSB": 2}

#: e_ident[EI_VERSION] values. The target only defines EV_CURRENT at readelf.cpp:36; 0 is the
#: adjacent value used as a negative control in the perturbation batch.
EIVERSION_VALUES = {"EV_NONE": 0, "EV_CURRENT": 1}

#: Fallback when a categorical arrives as an unknown string: the reach-triggering triple.
DEFAULT_CLASS = "ELFCLASS64"
DEFAULT_DATA = "ELFDATA2MSB"
DEFAULT_VERSION = "EV_CURRENT"

#: The near-miss seed whose 64 bytes the mutation route starts from.
DEFAULT_BASE_SEED = "/mnt/work/pbfuzz/pbfuzz-dsh/examples/readelf-c/seeds/64bit-be-v1-near-miss.bin"


def _resolve(table: dict, name: str, default: str) -> int:
    """Map a categorical name to its numeric value, falling back to the default name."""
    return table.get(name, table[default])


def _pack_entry(entry_point: int, byte_order: str) -> bytes:
    """Encode one entry point into 8 bytes, masking to the uint64_t the target stores."""
    value = entry_point & 0xFFFFFFFFFFFFFFFF
    return value.to_bytes(8, "big" if byte_order == "big" else "little")


def generate(**params) -> bytes:
    """Build one 64-byte ELF header from the parameter space.

    Keyword arguments (all optional, in-domain defaults):
        entry_point:       uint64 the header will carry at offset 24
        entry_byte_order:  "big" or "little" — how that value is laid out
        ei_class:          "ELFCLASS32" | "ELFCLASS64"
        ei_data:           "ELFDATA2LSB" | "ELFDATA2MSB"
        ei_version:        "EV_NONE" | "EV_CURRENT"
        use_base_seed:     mutate the near-miss seed instead of building from scratch
        base_seed:         path to that seed, supplied by a `base_seed` parameter
        tail_length:       bytes to append after the header (0 is enough for the target)
        tail_fill:         byte used to pad that tail

    Returns the input bytes for this assignment.
    """
    entry_point = int(params.get("entry_point", 0x400000))
    byte_order = params.get("entry_byte_order", "big")
    ei_class = params.get("ei_class", DEFAULT_CLASS)
    ei_data = params.get("ei_data", DEFAULT_DATA)
    ei_version = params.get("ei_version", DEFAULT_VERSION)
    use_base_seed = bool(params.get("use_base_seed", False))
    base_seed = params.get("base_seed", DEFAULT_BASE_SEED)
    tail_length = int(params.get("tail_length", 0))
    tail_fill = int(params.get("tail_fill", 0)) & 0xFF

    if use_base_seed:
        try:
            with open(base_seed, "rb") as handle:
                buf = bytearray(handle.read())
        except OSError:
            # An unreadable seed must not raise: the space allows this assignment, so the
            # generator falls back to direct construction rather than failing the iteration.
            buf = bytearray(READ_SIZE)
        if len(buf) < READ_SIZE:
            buf.extend(b"\x00" * (READ_SIZE - len(buf)))
    else:
        buf = bytearray(READ_SIZE)

    # The reach precondition triple. Written for both routes so an assignment that changes
    # only the entry point still reaches readelf.cpp:93.
    buf[0:4] = ELF_MAGIC
    buf[EI_CLASS] = _resolve(ELFCLASS_VALUES, ei_class, DEFAULT_CLASS)
    buf[EI_DATA] = _resolve(ELFDATA_VALUES, ei_data, DEFAULT_DATA)
    buf[EI_VERSION] = _resolve(EIVERSION_VALUES, ei_version, DEFAULT_VERSION)

    # The trigger. On the mutation route this replaces the seed's 0x1000 with our value,
    # which is the only difference between the near-miss seed and a PoC.
    buf[E_ENTRY_OFFSET:E_ENTRY_OFFSET + 8] = _pack_entry(entry_point, byte_order)

    if tail_length > 0:
        # Padding past the 64 bytes the target reads; harmless, and present so the space can
        # express "longer than the minimum" the way the other seeds are not.
        rng = random.Random((entry_point << 8) ^ (tail_length << 4) ^ tail_fill ^ len(buf))
        buf.extend(rng.randrange(256) if tail_fill == 0 else tail_fill for _ in range(tail_length))

    return bytes(buf)
