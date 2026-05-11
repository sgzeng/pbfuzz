#include <stdio.h>

// Same function name "foo" but in different file
double foo(double d) {
    printf("foo(double): %f\n", d);
    return d * 3.14;
}

float foo(float f) {
    printf("foo(float): %f\n", f);
    return f + 1.5f;
}

// Same function name "process" but in different file
void process(double value) {
    printf("Processing double: %f\n", value);
}

void helper() {
    foo(3.14159);
    foo(2.5f);
    process(1.618);
}
