#include <stdio.h>
#include <signal.h>

int main(void) {
    fprintf(stderr, "about to segfault\n");
    volatile int *p = (int*)0;
    *p = 42; // SIGSEGV
    return 0;
}

