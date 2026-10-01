/* kanalyzer self-test sample: main -> foo -> target, plus an exit branch in foo.
 * Line numbers are load-bearing: selftest/expect.json names them. Edit both together. */
#include <stdlib.h>
#include <string.h>

int target(int x) {
  int y = x * 2;
  return y + 1;
}

int foo(const char *s) {
  if (s[0] != 'K') {
    exit(1);
  }
  return target((int)strlen(s));
}

int main(int argc, char **argv) {
  if (argc < 2)
    return 0;
  return foo(argv[1]);
}
