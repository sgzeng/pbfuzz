// test.cpp moved into tests/
#include "test.h"
#include <cmath>
#include <cstdio>
#include <string>

#define SQUARE(x) ((x) * (x))
#define FOUR 4
#define ANSWER SQUARE(FOUR)

// Constants for testing find_constant method
const int BUFFER_SIZE = 1024;
const char* DEFAULT_MESSAGE = "Hello World";
const double PI_VALUE = 3.14159;

enum Status {
    STATUS_OK = 0,
    STATUS_ERROR = 1,
    STATUS_PENDING = 2
};

enum class Color : int {
    RED = 10,
    GREEN = 20,
    BLUE = 30
};

template<typename T>
T add(T a, T b) {
    return a + b;
}

int main() {
    int result = ANSWER; // macro (line 29)
    int sum = add(5, 10); // template call (line 30)
    int m1 = MIN(3, 5);  // from test.h
    int m2 = MAX(7, 2);  // from test.h
    
    // Use constants for testing
    int buffer = BUFFER_SIZE; // const variable (line 35)
    Status status = STATUS_OK; // enum constant (line 36)
    Color color = Color::RED; // enum class constant (line 37)
    const char* msg = DEFAULT_MESSAGE; // const variable (line 38)
    double pi = PI_VALUE; // const variable (line 39)
    
    // Use constants from test.h header file  
    int header_buffer = HEADER_BUFFER_SIZE; // header const variable (line 42)
    double header_pi = HEADER_PI; // header const variable (line 43)
    const char* version = HEADER_VERSION; // header const variable (line 44)
    NetworkStatus net_status = NET_CONNECTED; // header enum constant (line 45)
    LogLevel log_level = LogLevel::INFO_LVL; // header enum class constant (line 46)
    
    return 0;
}

// Additional test definitions for find_* methods

/* Local enum in cpp file */
enum LocalState {
    STATE_INIT = 0,
    STATE_RUNNING = 1,
    STATE_STOPPED = 2
};

/* Local struct in cpp file */
struct Config {
    int timeout;
    bool debug_mode;
    const char* output_dir;
};

/* Local class in cpp file */
class SimpleCalculator {
private:
    double result;
    
public:
    SimpleCalculator() : result(0.0) {}
    
    void add(double value) {
        result += value;
    }
    
    void multiply(double factor) {
        result *= factor;
    }
    
    double get_result() const {
        return result;
    }
    
    void reset() {
        result = 0.0;
    }
};

/* Implementations of header functions */
double Point::distance_from_origin() const {
    return sqrt(x * x + y * y);
}

int calculate_area(const Rectangle& rect) {
    return rect.width * rect.height;
}

bool validate_point(const Point& p) {
    return p.x >= 0 && p.y >= 0;
}

void process_file(FileType type, const char* filename) {
    // Implementation for testing
    switch (type) {
        case FILE_TEXT:
            printf("Processing text file: %s\n", filename);
            break;
        case FILE_BINARY:
            printf("Processing binary file: %s\n", filename);
            break;
        case FILE_EXECUTABLE:
            printf("Processing executable file: %s\n", filename);
            break;
    }
}

Priority get_task_priority(int task_id) {
    if (task_id < 10) return Priority::LOW;
    if (task_id < 50) return Priority::MEDIUM;
    if (task_id < 100) return Priority::HIGH;
    return Priority::CRITICAL;
}

/* Local function definitions */
static int local_helper_function(int a, int b) {
    return a * 2 + b;
}

/* Logger class implementations */
Logger::Logger(const std::string& filename) : log_file(filename) {
    // Base logger constructor
}

void Logger::log(const std::string& message) {
    printf("LOG: %s\n", message.c_str());
}

Logger::~Logger() {
    // Base logger destructor
}

/* FileLogger class implementations */
FileLogger::FileLogger(const std::string& filename) : Logger(filename), file_handle(nullptr) {
    file_handle = fopen(filename.c_str(), "w");
    if (!file_handle) {
        printf("Warning: Could not open log file %s\n", filename.c_str());
    }
}

void FileLogger::flush() {
    if (file_handle) {
        fflush(file_handle);
    }
}

FileLogger::~FileLogger() {
    if (file_handle) {
        fclose(file_handle);
        file_handle = nullptr;
    }
}

void demonstrate_usage() {
    Config cfg = {30, true, "/tmp/output"};
    SimpleCalculator calc;
    calc.add(10.5);
    calc.multiply(2.0);
    
    Point p = {3, 4};
    Rectangle rect = {{0, 0}, {10, 5}, 10, 5};
    FileLogger logger("test.log");
    
    LocalState state = STATE_RUNNING;
    printf("Calculator result: %f\n", calc.get_result());
    printf("Point distance: %f\n", p.distance_from_origin());
}
