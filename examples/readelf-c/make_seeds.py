#!/usr/bin/env python3
"""Generate the seed corpus for the readelf-c example.

Each seed is a 64-byte `ELFHeader` (see readelf.cpp) with valid ELF magic so the target gets past
its initial validity check, exercising a different combination of class/data/version so corpus
analysis has more than one reach depth to report on. None of them already satisfy the abort()
condition in `check_dangerous_elf_combination` (64-bit + big-endian + version 1 + entry in
{0x400000, 0x8048000}) — finding that combination is what PIER is verified against in V1.
"""
import struct
from pathlib import Path

SEEDS = Path(__file__).parent / "seeds"
SEEDS.mkdir(exist_ok=True)

ELFMAG = b"\x7fELF"
ELFCLASS32, ELFCLASS64 = 1, 2
ELFDATA2LSB, ELFDATA2MSB = 1, 2
EV_CURRENT = 1


def header(e_class, e_data, e_version, entry=0, e_type=2, e_machine=0x3E):
    e_ident = bytearray(16)
    e_ident[0:4] = ELFMAG
    e_ident[4] = e_class
    e_ident[5] = e_data
    e_ident[6] = e_version
    # little-endian struct packing regardless of the *ELF file's* declared endianness — this is
    # the harness's own memory layout (`file.read(&header, sizeof(header))`), not a real ELF parse.
    return (
        bytes(e_ident)
        + struct.pack("<HHI", e_type, e_machine, e_version)
        + struct.pack("<QQQ", entry, 0, 0)
        + struct.pack("<IHHHHHH", 0, 64, 0, 0, 0, 0, 0)
    )


seeds = {
    "32bit-le-v1.bin": header(ELFCLASS32, ELFDATA2LSB, EV_CURRENT),
    "64bit-le-v1.bin": header(ELFCLASS64, ELFDATA2LSB, EV_CURRENT),
    # Reaches "bug location reached" (64-bit + big-endian + version 1) but entry doesn't match —
    # the closest a seed gets without already being the PoC.
    "64bit-be-v1-near-miss.bin": header(ELFCLASS64, ELFDATA2MSB, EV_CURRENT, entry=0x1000),
    "64bit-be-v0.bin": header(ELFCLASS64, ELFDATA2MSB, 0),
}

for name, data in seeds.items():
    assert len(data) == 64, f"{name}: {len(data)} bytes, expected 64"
    (SEEDS / name).write_bytes(data)

# Also a short/invalid file, to exercise the early "Cannot read ELF header" / "Not a valid ELF
# file" returns.
(SEEDS / "too-short.bin").write_bytes(b"\x7fEL")

print(f"wrote {len(seeds) + 1} seeds to {SEEDS}")
