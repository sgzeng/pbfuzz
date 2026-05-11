#!/usr/bin/env python3
"""
ELF file generator for testing readelf.cpp
Can generate both safe and bug-triggering ELF files
"""

import struct
import random

def generate(seed=0, elf_class=1, data_encoding=1, trigger_bug=False, entry_point=0x401000, file_size=64, **kwargs):
    """
    Generate ELF file bytes.
    
    Args:
        seed: Random seed for reproducible generation
        elf_class: 1 for 32-bit, 2 for 64-bit ELF
        data_encoding: 1 for little endian, 2 for big endian
        trigger_bug: If True, generate ELF that can trigger the bug
        entry_point: Entry point address (used for bug triggering)
        file_size: Minimum size of generated file in bytes
        **kwargs: Additional parameters (ignored)
    
    Returns:
        tuple: (elf_bytes, used_params_dict)
    """
    random.seed(seed)
    
    # If trigger_bug is True, force the bug-triggering combination
    if trigger_bug:
        elf_class = 2  # 64-bit
        data_encoding = 2  # big endian
        # Use one of the entry points that trigger the bug
        entry_point = random.choice([0x400000, 0x8048000])
    
    used_params = {
        "seed": seed,
        "elf_class": elf_class,
        "data_encoding": data_encoding,
        "trigger_bug": trigger_bug,
        "entry_point": entry_point,
        "file_size": file_size
    }
    
    # Start building ELF header
    elf_bytes = bytearray()
    
    # ELF Magic (e_ident[0:4])
    elf_bytes.extend([0x7f, ord('E'), ord('L'), ord('F')])
    
    # ELF class (e_ident[4])
    elf_bytes.append(elf_class)
    
    # Data encoding (e_ident[5])
    elf_bytes.append(data_encoding)
    
    # ELF version (e_ident[6])
    elf_bytes.append(1)  # EV_CURRENT
    
    # OS/ABI (e_ident[7])
    elf_bytes.append(0)  # ELFOSABI_SYSV
    
    # ABI version (e_ident[8])
    elf_bytes.append(0)
    
    # Padding (e_ident[9:15])
    elf_bytes.extend([0] * 7)
    
    # Determine endianness for struct packing
    endian_char = '>' if data_encoding == 2 else '<'
    
    # e_type (object file type) - 2 bytes
    e_type = random.choice([1, 2, 3])  # ET_REL, ET_EXEC, ET_DYN
    elf_bytes.extend(struct.pack(f'{endian_char}H', e_type))
    
    # e_machine (machine type) - 2 bytes
    e_machine = random.choice([0x3E, 0x28, 0x08])  # x86-64, ARM, MIPS
    elf_bytes.extend(struct.pack(f'{endian_char}H', e_machine))
    
    # e_version (object file version) - 4 bytes
    elf_bytes.extend(struct.pack(f'{endian_char}I', 1))
    
    # e_entry (entry point) - depends on class
    if elf_class == 1:  # 32-bit
        elf_bytes.extend(struct.pack(f'{endian_char}I', entry_point & 0xFFFFFFFF))
    else:  # 64-bit
        # For 64-bit, still use the entry_point value directly (not as 64-bit address)
        elf_bytes.extend(struct.pack(f'{endian_char}Q', entry_point & 0xFFFFFFFF))
    
    # e_phoff (program header offset) - depends on class
    if elf_class == 1:
        elf_bytes.extend(struct.pack(f'{endian_char}I', 52))  # After ELF header
    else:
        elf_bytes.extend(struct.pack(f'{endian_char}Q', 64))  # After ELF header
    
    # e_shoff (section header offset) - depends on class
    if elf_class == 1:
        elf_bytes.extend(struct.pack(f'{endian_char}I', 0))
    else:
        elf_bytes.extend(struct.pack(f'{endian_char}Q', 0))
    
    # e_flags (processor flags) - 4 bytes
    elf_bytes.extend(struct.pack(f'{endian_char}I', 0))
    
    # e_ehsize (ELF header size) - 2 bytes
    ehsize = 52 if elf_class == 1 else 64
    elf_bytes.extend(struct.pack(f'{endian_char}H', ehsize))
    
    # e_phentsize (program header entry size) - 2 bytes
    phentsize = 32 if elf_class == 1 else 56
    elf_bytes.extend(struct.pack(f'{endian_char}H', phentsize))
    
    # e_phnum (program header count) - 2 bytes
    elf_bytes.extend(struct.pack(f'{endian_char}H', 0))
    
    # e_shentsize (section header entry size) - 2 bytes
    shentsize = 40 if elf_class == 1 else 64
    elf_bytes.extend(struct.pack(f'{endian_char}H', shentsize))
    
    # e_shnum (section header count) - 2 bytes
    elf_bytes.extend(struct.pack(f'{endian_char}H', 0))
    
    # e_shstrndx (string table index) - 2 bytes
    elf_bytes.extend(struct.pack(f'{endian_char}H', 0))
    
    # Pad to minimum file size with random data
    while len(elf_bytes) < file_size:
        elf_bytes.append(random.randint(0, 255))
    
    return bytes(elf_bytes), used_params
