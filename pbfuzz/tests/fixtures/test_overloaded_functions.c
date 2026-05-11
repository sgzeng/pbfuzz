#include <stdio.h>

// Same function name "foo" with different signatures in same file
int foo(int x) {
    printf("foo(int): %d\n", x);
    return x * 2;
}

char foo(char c) {
    printf("foo(char): %c\n", c);
    return c + 1;
}

// Another set of overloaded functions
void process(int data) {
    printf("Processing int: %d\n", data);
}

void process(char* str) {
    printf("Processing string: %s\n", str);
}

int main() {
    foo(42);
    foo('A');
    process(123);
    process("hello");
    return 0;
}
