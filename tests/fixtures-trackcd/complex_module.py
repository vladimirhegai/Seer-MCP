# Complexity fixture: deliberately nested branches for cyclomatic / cognitive tests.

def simple_function(x):
    return x + 1


def branchy_function(x, y):
    if x > 0:
        if y > 0:
            if x > y:
                return "x"
            else:
                return "y"
        else:
            return "x-only"
    elif x < 0:
        return "neg"
    else:
        return "zero"


def loopy_function(items):
    total = 0
    for item in items:
        if item > 0:
            for sub in item:
                if sub != 0:
                    total += sub
                else:
                    continue
        elif item < 0:
            try:
                total -= item
            except Exception:
                pass
    return total


class Calculator:
    def add(self, a, b):
        return a + b

    def divide(self, a, b):
        if b == 0:
            raise ValueError("zero")
        if a < 0 and b < 0:
            return abs(a) / abs(b)
        elif a < 0:
            return -abs(a) / b
        return a / b
