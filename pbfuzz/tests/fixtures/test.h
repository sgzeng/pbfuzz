#ifndef TEST_H
#define TEST_H

#include <stdio.h>
#include <string>

/* Function declarations */
int calculate_sum(int a, int b);
void process_data(const char *data);
int complex_function(int x, int y);
void print_message(const char *msg);

/* Inline utility function */
static inline int add_numbers(int x, int y) {
    return x + y;
}

/* Header-only function */
void debug_print(const char *msg) {
    printf("[DEBUG] %s\n", msg);
}

/* Macro definitions */
#define MAX_SIZE 100
#define MIN(a, b) ((a) < (b) ? (a) : (b))
#define MAX(a, b) ((a) > (b) ? (a) : (b))

/* Constants defined in header */
const int HEADER_BUFFER_SIZE = 2048;
const double HEADER_PI = 3.141592653589793;
const char* HEADER_VERSION = "v1.2.3";

/* Enum constants in header */
enum NetworkStatus {
    NET_DISCONNECTED = 0,
    NET_CONNECTING = 1,
    NET_CONNECTED = 2,
    NET_ERROR = -1
};

enum class LogLevel : int {
    DEBUG_LVL = 0,
    INFO_LVL = 10,
    WARN_LVL = 20,
    ERROR_LVL = 30
};

/* Additional test structures for find_* methods */

/* Enum definitions */
enum FileType {
    FILE_TEXT = 1,
    FILE_BINARY = 2,
    FILE_EXECUTABLE = 3
};

enum class Priority : short {
    LOW = 1,
    MEDIUM = 5,
    HIGH = 10,
    CRITICAL = 100
};

/* Struct definitions */
struct Point {
    int x;
    int y;
    double distance_from_origin() const;
};

struct Rectangle {
    Point top_left;
    Point bottom_right;
    int width;
    int height;
};

/* Class definitions */
class Logger {
private:
    std::string log_file;
public:
    Logger(const std::string& filename);
    void log(const std::string& message);
    virtual ~Logger();
};

class FileLogger : public Logger {
private:
    FILE* file_handle;
public:
    explicit FileLogger(const std::string& filename);
    void flush();
    ~FileLogger();
};

/* Function declarations */
int calculate_area(const Rectangle& rect);
bool validate_point(const Point& p);
void process_file(FileType type, const char* filename);
Priority get_task_priority(int task_id);

/* External constants (defined elsewhere) */
extern const int BUFFER_SIZE;
extern const char* DEFAULT_MESSAGE;

#endif /* TEST_H */
