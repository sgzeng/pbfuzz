#include <stdio.h>

int work_basic(int n) {
    int sum = 0;
    for (int i = 0; i < n; i++) {

        sum += i;                  // BREAK HERE (loop body)
        // (watch i, sum)
    }
    return sum;                    // convenient post-loop anchor
}

int main(void) {
    int n = 5;
    int s = work_basic(n);
    printf("sum=%d\n", s);
    return 0;
}

