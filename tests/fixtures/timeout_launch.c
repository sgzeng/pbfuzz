#include <stdio.h>

int main(void) {
    volatile unsigned long i = 0;
    while (1) { i++; }
    return 0; // unreachable; breakpoint set here
}

