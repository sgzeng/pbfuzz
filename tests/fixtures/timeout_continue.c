#include <stdio.h>

int main(void) {
    int x = 0;
    x += 1; // BREAKPOINT HERE
    volatile unsigned long i = 0;
    while (1) { i++; }
    return 0; // unreachable
}

