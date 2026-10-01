#include <iostream>
#include <fstream>
#include <cstdint>
#include <cstdlib>

// ELF Header structure (simplified)
struct ELFHeader {
    uint8_t e_ident[16];    // ELF identification
    uint16_t e_type;        // Object file type
    uint16_t e_machine;     // Machine type
    uint32_t e_version;     // Object file version
    uint64_t e_entry;       // Entry point virtual address
    uint64_t e_phoff;       // Program header table offset
    uint64_t e_shoff;       // Section header table offset
    uint32_t e_flags;       // Processor-specific flags
    uint16_t e_ehsize;      // ELF header size
    uint16_t e_phentsize;   // Program header table entry size
    uint16_t e_phnum;       // Program header table entry count
    uint16_t e_shentsize;   // Section header table entry size
    uint16_t e_shnum;       // Section header table entry count
    uint16_t e_shstrndx;    // Section header string table index
};

// ELF constants
const uint8_t ELFMAG[] = {0x7f, 'E', 'L', 'F'};
const int EI_CLASS = 4;     // File class
const int EI_DATA = 5;      // Data encoding
const int EI_VERSION = 6;   // File version

const int ELFCLASS32 = 1;   // 32-bit objects
const int ELFCLASS64 = 2;   // 64-bit objects

const int ELFDATA2LSB = 1;  // Little endian
const int ELFDATA2MSB = 2;  // Big endian

const int EV_CURRENT = 1;   // Current version

void print_elf_info(const ELFHeader& header) {
    std::cout << "ELF Header Information:" << std::endl;
    
    // Print class
    std::cout << "Class: ";
    if (header.e_ident[EI_CLASS] == ELFCLASS32) {
        std::cout << "32-bit" << std::endl;
    } else if (header.e_ident[EI_CLASS] == ELFCLASS64) {
        std::cout << "64-bit" << std::endl;
    } else {
        std::cout << "Unknown" << std::endl;
    }
    
    // Print data encoding
    std::cout << "Data: ";
    if (header.e_ident[EI_DATA] == ELFDATA2LSB) {
        std::cout << "Little endian" << std::endl;
    } else if (header.e_ident[EI_DATA] == ELFDATA2MSB) {
        std::cout << "Big endian" << std::endl;
    } else {
        std::cout << "Unknown" << std::endl;
    }
    
    // Print version
    std::cout << "Version: " << (int)header.e_ident[EI_VERSION] << std::endl;
    
    // Print type
    std::cout << "Type: " << header.e_type << std::endl;
    
    // Print machine
    std::cout << "Machine: " << header.e_machine << std::endl;
    
    // Print entry point
    std::cout << "Entry point: 0x" << std::hex << header.e_entry << std::dec << std::endl;
}

// Bug function - triggers when specific ELF conditions are met
void check_dangerous_elf_combination(const ELFHeader& header) {
    // Bug trigger condition: 64-bit + big endian + version 1
    // This is a realistic but rare combination that could cause issues
    if (header.e_ident[EI_CLASS] == ELFCLASS64 && 
        header.e_ident[EI_DATA] == ELFDATA2MSB && 
        header.e_ident[EI_VERSION] == EV_CURRENT) {
        
        std::cerr << "bug location reached" << std::endl;
        
        // Additional check on entry point to make bug more specific
        // Need to handle endianness when comparing entry point
        uint64_t entry = header.e_entry;
        if (header.e_ident[EI_DATA] == ELFDATA2MSB) {
            // For big endian files, we need to consider the byte order
            // The entry point might be stored in big endian format
            entry = __builtin_bswap64(header.e_entry);
        }
        
        if (entry == 0x400000 || entry == 0x8048000 || header.e_entry == 0x400000 || header.e_entry == 0x8048000) {
            std::cerr << "bug location triggered" << std::endl;
            std::cerr << "Fatal: Dangerous ELF combination detected!" << std::endl;
            abort(); // This is the actual bug - program crashes
        }
    }
}

int main(int argc, char* argv[]) {
    if (argc != 2) {
        std::cerr << "Usage: " << argv[0] << " <elf_file>" << std::endl;
        return 1;
    }
    
    const char* filename = argv[1];
    std::ifstream file(filename, std::ios::binary);
    
    if (!file.is_open()) {
        std::cerr << "Error: Cannot open file " << filename << std::endl;
        return 1;
    }
    
    ELFHeader header;
    file.read(reinterpret_cast<char*>(&header), sizeof(header));
    
    if (!file) {
        std::cerr << "Error: Cannot read ELF header" << std::endl;
        return 1;
    }
    
    // Verify ELF magic
    bool valid_elf = true;
    for (int i = 0; i < 4; i++) {
        if (header.e_ident[i] != ELFMAG[i]) {
            valid_elf = false;
            break;
        }
    }
    
    if (!valid_elf) {
        std::cerr << "Error: Not a valid ELF file" << std::endl;
        return 1;
    }
    
    std::cout << "Valid ELF file detected" << std::endl;
    
    // Print ELF information
    print_elf_info(header);
    
    // Check for dangerous combination (this contains the bug)
    check_dangerous_elf_combination(header);
    
    std::cout << "ELF analysis completed successfully" << std::endl;
    file.close();
    return 0;
}
// clang-14 -emit-llvm -g -O0 -c readelf.cpp -o readelf.bc