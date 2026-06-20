#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Test function for source code extraction */
int main(int argc, char *argv[]) {
    printf("Hello, World!\n");
    
    if (argc > 1) {
        printf("Arguments provided: %d\n", argc);
        for (int i = 1; i < argc; i++) {
            printf("Arg %d: %s\n", i, argv[i]);
        }
    }
    
    int result = calculate_sum(10, 20);
    printf("Sum result: %d\n", result);
    
    return 0;
}

/* Helper function for calculations */
int calculate_sum(int a, int b) {
    int sum = a + b;
    if (sum > 100) {
        printf("Large sum detected: %d\n", sum);
    }
    return sum;
}

/* Another test function */
void process_data(const char *data) {
    if (data == NULL) {
        printf("Error: null data provided\n");
        return;
    }
    
    printf("Processing data: %s\n", data);
    
    int len = strlen(data);
    if (len > 10) {
        printf("Long data string\n");
    } else {
        printf("Short data string\n");
    }
}

/* Function with complex control flow */
int complex_function(int x, int y) {
    int result = 0;
    
    if (x > 0) {
        if (y > 0) {
            result = x * y;
        } else {
            result = x / 2;
        }
    } else {
        switch (y) {
            case 1:
                result = 1;
                break;
            case 2:
                result = 4;
                break;
            default:
                result = -1;
                break;
        }
    }
    
    for (int i = 0; i < 3; i++) {
        result += i;
    }
    
    return result;
}

/* Simple utility function */
void print_message(const char *msg) {
    printf("Message: %s\n", msg);
}