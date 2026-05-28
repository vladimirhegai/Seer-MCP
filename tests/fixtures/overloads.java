// Overload fixture: two methods with the same name inside the same class.
// javaOnly1 / javaOnly2 are unique names used to verify call-edge attribution.

class OverloadHelper {
    static int javaOnly1() { return 1; }
    static int javaOnly2() { return 2; }
}

class Overload {
    void run(int value) {
        OverloadHelper.javaOnly1();
    }

    void run(String value) {
        OverloadHelper.javaOnly2();
    }
}
