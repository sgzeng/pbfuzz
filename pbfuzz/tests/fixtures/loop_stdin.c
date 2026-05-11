#include <stdio.h>
#include <stdlib.h>

static int read_n(void) {
    int n = 0;
    scanf("%d", &n);  // true stdin path
    return n;
}

int work_stdin(int n) {
    int acc = 1;
    for (int i = 1; i <= n; i++) {
        acc *= i;                   // BREAK HERE (loop body)
        // (watch i, acc)
    }
    return acc;
}

int main(void) {
    int n = read_n();
    int a = work_stdin(n);
    printf("acc=%d\n", a);
    return 0;
}

