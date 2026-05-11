#!/bin/bash
# GDB Wrapper - Launch GDB with named pipe for agent communication
#
# USAGE:
#   gdb.sh [-t DURATION] -- <program> [args...]
#
# OPTIONS:
#   -t DURATION   Timeout (default: 180s). Formats: 10, 10s, 5m
#   -h            Show help
#
# AGENT WORKFLOW:
#   1. Run: gdb.sh -t 5m -- ./my_program arg1 arg2
#   2. Script outputs paths for GDB_INPUT and GDB_OUTPUT files
#   3. Write commands: printf "break main\nrun\ninfo registers\n" > $GDB_INPUT
#   4. Read output: cat $GDB_OUTPUT
#   5. Repeat steps 3-4 for interactive debugging
#   6. Set watchpoints on critical variables when context is available:
#      printf "watch critical_var\ncontinue\n" > $GDB_INPUT
#   7. Quit: printf "quit\n" > $GDB_INPUT
#
set -euo pipefail

TIMEOUT=180
PROG_ARGS=()

while [[ $# -gt 0 ]]; do
    case $1 in
        -t) TIMEOUT="$2"; shift 2 ;;
        -h) echo "Usage: gdb.sh [-t DURATION] -- <program> [args...]"; exit 0 ;;
        --) shift; PROG_ARGS=("$@"); break ;;
        *) echo "Unknown option: $1" >&2; exit 1 ;;
    esac
done

if [[ ${#PROG_ARGS[@]} -eq 0 ]]; then
    echo "Usage: gdb.sh [-t DURATION] -- <program> [args...]" >&2
    exit 1
fi

# Parse timeout
if [[ "$TIMEOUT" =~ ^[0-9]+$ ]]; then
    TIMEOUT_S=$TIMEOUT
elif [[ "$TIMEOUT" =~ ^([0-9]+)(s|sec|seconds?)$ ]]; then
    TIMEOUT_S="${BASH_REMATCH[1]}"
elif [[ "$TIMEOUT" =~ ^([0-9]+)(m|min|minutes?)$ ]]; then
    TIMEOUT_S=$((${BASH_REMATCH[1]} * 60))
elif [[ "$TIMEOUT" =~ ^([0-9]+)(h|hr|hours?)$ ]]; then
    TIMEOUT_S=$((${BASH_REMATCH[1]} * 3600))
else
    echo "Invalid timeout: $TIMEOUT" >&2
    exit 2
fi

# Create unique session directory in /tmp
TS=$(date +%s%3N)
RND=$(xxd -l 4 -p /dev/urandom)
SESSION_DIR="/tmp/gdb_session_${TS}_${RND}"
mkdir -m 700 "$SESSION_DIR"

# Create FIFOs, log file, and PID file in session directory
IN_FIFO="${SESSION_DIR}/gdb_in"
OUT_FIFO="${SESSION_DIR}/gdb_out"
LOG_FILE="${SESSION_DIR}/gdb_log"
PID_FILE="${SESSION_DIR}/gdb_pid"
mkfifo -m 600 "$IN_FIFO" "$OUT_FIFO"
touch "$LOG_FILE" "$PID_FILE"
chmod 600 "$LOG_FILE" "$PID_FILE"

# Output agent instructions
cat <<EOF
=== GDB Interactive Session Started in background (timeout: ${TIMEOUT_S}s) ===
Must start new gdb session for testing new input.
Program: ${PROG_ARGS[@]}
Session Directory: $SESSION_DIR

To send GDB commands:
  printf "break main\nrun\n" > $IN_FIFO

To read GDB output (stdout/stderr):
  cat $LOG_FILE

GDB PID (available after ~100ms):
  cat $PID_FILE

Setting watchpoints on critical variables (when context available):
  printf "watch critical_var\ncontinue\n" > $IN_FIFO
  # Wait for execution to reach critical variable
  sleep 0.5
  cat $LOG_FILE

Quit:
  printf "quit\n" > $IN_FIFO

For non-interactive sessions:
gdb -q --nx -batch \
    -ex "set pagination off" \
    -ex "set confirm off" \
    -ex "set python print-stack none" \
    -x your_gdb_script \
    your_program your_args
EOF

# Fork daemon in background
(
    # Cleanup handler
    cleanup() {
        # Close file descriptors first
        exec 3>&- 7>&- 8>&- 2>/dev/null || true
        
        # Kill any remaining GDB processes
        pkill -9 -s $SETSID_PID 2>/dev/null || true
        
        # Wait for log reader to finish (if not already done in main flow)
        kill -0 $LOG_READER_PID 2>/dev/null && {
            kill $LOG_READER_PID 2>/dev/null || true
            wait $LOG_READER_PID 2>/dev/null || true
        }
        
        # Remove session directory
        rm -rf "$SESSION_DIR"
    }
    trap cleanup EXIT INT TERM
    
    # Open FIFOs in RDWR mode for keepalive (Linux-specific but simpler)
    exec 7<>"$IN_FIFO"
    exec 8<>"$OUT_FIFO"
    
    # Open for GDB input
    exec 3<"$IN_FIFO"
    
    # Background process to continuously copy GDB output to log file
    cat "$OUT_FIFO" >> "$LOG_FILE" &
    LOG_READER_PID=$!
    
    # Start GDB in new session with kill-after for robust cleanup
    # setsid creates new process group so we can kill entire tree
    setsid timeout --kill-after=2s "$TIMEOUT_S" \
        gdb -q --nx -ex "set pagination off" -ex "set confirm off" -ex "set python print-stack none" --args "${PROG_ARGS[@]}" \
        <&3 > "$OUT_FIFO" 2>&1 &
    
    SETSID_PID=$!
    
    # Wait for GDB to start and write its PID to file
    sleep 0.2
    GDB_PID=$(pgrep -s $SETSID_PID -x gdb 2>/dev/null | head -1)
    if [[ -n "$GDB_PID" ]]; then
        echo "$GDB_PID" > "$PID_FILE"
    else
        echo "-1" > "$PID_FILE"
    fi
    
    # Wait for GDB process to exit
    wait $SETSID_PID 2>/dev/null || true

    # Try a graceful shutdown first: ask GDB to quit so its Python
    # interpreter can flush stdout/stderr while the pipe is still valid.
    if [[ -p "$IN_FIFO" ]] && [[ -w "$IN_FIFO" ]]; then
        printf "quit\n" > "$IN_FIFO" 2>/dev/null || true
        sleep 0.5
    fi

    # If processes remain in the session, try TERM then KILL.
    pkill -TERM -s $SETSID_PID 2>/dev/null || true
    sleep 0.2
    pkill -9 -s $SETSID_PID 2>/dev/null || true

    # This ensures cat will finish reading and exit cleanly
    exec 8>&- 2>/dev/null || true
    
    # This prevents data loss from premature cleanup
    if kill -0 $LOG_READER_PID 2>/dev/null; then
        # Give cat process up to 5 seconds to finish
        for i in {1..50}; do
            if ! kill -0 $LOG_READER_PID 2>/dev/null; then
                break
            fi
            sleep 0.1
        done
        # Final wait to reap the process
        wait $LOG_READER_PID 2>/dev/null || true
    fi
    
    # Grace period to allow agent to finish reading log file (30s after GDB exits)
    sleep 30

    # Cleanup will be done by trap handler
) </dev/null >/dev/null 2>&1 &

exit 0
