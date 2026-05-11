#include <stdio.h>

int work_multiple(int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) {
        sum += i;                  // BREAK HERE (loop body)
        sum += 1;                  // BREAK HERE (loop body 2)
        // (watch i, sum)
    }
    return sum;                    // convenient post-loop anchor
}

int main(void) {
    int n = 5;
    int s = work_multiple(n);
    printf("sum=%d\n", s);
    return 0;
}

