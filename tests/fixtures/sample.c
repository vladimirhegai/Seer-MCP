#include <stdio.h>

static int c_helper(int value) {
  return value + 1;
}

static void c_emit(const char *message) {
  puts(message);
}

int c_entrypoint(int seed) {
  int value = c_helper(seed);
  c_emit("indexed from C");
  return value;
}
