#!/bin/bash

# Dev Sessions Script
# Starts N parallel user sessions, each with its own frontend and backend
# Usage: ./scripts/dev-sessions.sh [N] [start|stop|status]
#        ./scripts/dev-sessions.sh 2 start   - Start 2 user sessions
#        ./scripts/dev-sessions.sh stop      - Stop all sessions
#        ./scripts/dev-sessions.sh status    - Show running sessions

set -e

# Resolve script location (works even when called via symlink or PATH)
SCRIPT_PATH="${BASH_SOURCE[0]}"
while [ -h "$SCRIPT_PATH" ]; do
    SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
    SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
    [[ $SCRIPT_PATH != /* ]] && SCRIPT_PATH="$SCRIPT_DIR/$SCRIPT_PATH"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKEND_DIR="$PROJECT_DIR/backend"
FRONTEND_DIR="$PROJECT_DIR/frontend"
LOG_DIR="/tmp/matou-dev"

# Verify directories exist
if [ ! -d "$BACKEND_DIR" ]; then
    echo "Error: Backend directory not found: $BACKEND_DIR"
    exit 1
fi
if [ ! -d "$FRONTEND_DIR" ]; then
    echo "Error: Frontend directory not found: $FRONTEND_DIR"
    exit 1
fi

# Port configuration
# Avoiding conflicts with infrastructure:
#   - KERIA: 3901-3904
#   - Witnesses: 5642-5647
#   - AnySync: 1001-1016, 8001-8006, 8081-8083
#   - MinIO: 9000-9001
#   - Schema: 7723, SMTP: 2525
BACKEND_BASE_PORT=4000
FRONTEND_BASE_PORT=5100

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[OK]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

create_log_dir() {
    mkdir -p "$LOG_DIR"
}

get_data_dir() {
    local session=$1
    if [ "$session" -eq 1 ]; then
        echo "./data"
    else
        echo "./data$session"
    fi
}

start_backend() {
    local session=$1
    local port=$((BACKEND_BASE_PORT + session - 1))
    local data_dir=$(get_data_dir $session)
    local log_file="$LOG_DIR/backend-$session.log"
    local pid_file="$LOG_DIR/backend-$session.pid"

    # Check if already running
    if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
        log_warn "Backend session $session already running on port $port"
        return 0
    fi

    log_info "Starting backend session $session on port $port (data: $data_dir)"

    # Start Go backend in subshell with proper working directory
    (
        cd "$BACKEND_DIR"
        MATOU_DATA_DIR="$data_dir" \
        MATOU_SERVER_PORT="$port" \
        exec go run ./cmd/server
    ) > "$log_file" 2>&1 &

    local pid=$!
    echo "$pid" > "$pid_file"

    # Wait for Go to compile and start (first run takes longer)
    # Poll for up to 30 seconds until the port is listening
    log_info "Waiting for backend to start (this may take a moment on first run)..."
    local attempts=0
    local max_attempts=30
    while [ $attempts -lt $max_attempts ]; do
        if curl -s "http://localhost:$port/health" > /dev/null 2>&1; then
            log_success "Backend session $session started (PID: $pid, Port: $port)"
            return 0
        fi
        if ! kill -0 "$pid" 2>/dev/null; then
            log_error "Backend session $session process died. Check $log_file"
            return 1
        fi
        sleep 1
        attempts=$((attempts + 1))
    done

    log_error "Backend session $session failed to start within ${max_attempts}s. Check $log_file"
    return 1
}

start_frontend() {
    local session=$1
    local port=$((FRONTEND_BASE_PORT + session - 1))
    local backend_port=$((BACKEND_BASE_PORT + session - 1))
    local log_file="$LOG_DIR/frontend-$session.log"
    local pid_file="$LOG_DIR/frontend-$session.pid"

    # Check if already running
    if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
        log_warn "Frontend session $session already running on port $port"
        return 0
    fi

    log_info "Starting frontend session $session on port $port (backend: http://localhost:$backend_port)"

    # Start in subshell with proper working directory
    (
        cd "$FRONTEND_DIR"
        VITE_BACKEND_URL="http://localhost:$backend_port" \
        exec npm run dev -- --port "$port"
    ) > "$log_file" 2>&1 &

    local pid=$!
    echo "$pid" > "$pid_file"

    # Wait a moment and check if it started
    sleep 3
    if kill -0 "$pid" 2>/dev/null; then
        log_success "Frontend session $session started (PID: $pid, Port: $port)"
    else
        log_error "Frontend session $session failed to start. Check $log_file"
        return 1
    fi
}

start_sessions() {
    local num_sessions=$1

    create_log_dir

    echo ""
    echo "========================================"
    echo "  Starting $num_sessions dev session(s)"
    echo "========================================"
    echo ""

    for ((i=1; i<=num_sessions; i++)); do
        start_backend $i
        start_frontend $i
        echo ""
    done

    echo "========================================"
    echo "  Sessions Ready"
    echo "========================================"
    echo ""
    for ((i=1; i<=num_sessions; i++)); do
        local fe_port=$((FRONTEND_BASE_PORT + i - 1))
        local be_port=$((BACKEND_BASE_PORT + i - 1))
        local data_dir=$(get_data_dir $i)
        echo -e "  Session $i: ${GREEN}http://localhost:$fe_port${NC}"
        echo -e "            Backend: http://localhost:$be_port (data: $data_dir)"
        echo ""
    done
    echo "Logs: $LOG_DIR/"
    echo ""
}

stop_sessions() {
    echo ""
    echo "========================================"
    echo "  Stopping all dev sessions"
    echo "========================================"
    echo ""

    # Stop all backend sessions
    for pid_file in "$LOG_DIR"/backend-*.pid; do
        if [ -f "$pid_file" ]; then
            local pid=$(cat "$pid_file")
            local session=$(basename "$pid_file" | sed 's/backend-\([0-9]*\)\.pid/\1/')
            if kill -0 "$pid" 2>/dev/null; then
                kill "$pid" 2>/dev/null || true
                log_success "Stopped backend session $session (PID: $pid)"
            fi
            rm -f "$pid_file"
        fi
    done

    # Stop all frontend sessions
    for pid_file in "$LOG_DIR"/frontend-*.pid; do
        if [ -f "$pid_file" ]; then
            local pid=$(cat "$pid_file")
            local session=$(basename "$pid_file" | sed 's/frontend-\([0-9]*\)\.pid/\1/')
            if kill -0 "$pid" 2>/dev/null; then
                kill "$pid" 2>/dev/null || true
                log_success "Stopped frontend session $session (PID: $pid)"
            fi
            rm -f "$pid_file"
        fi
    done

    # Also kill any orphaned processes on known ports
    for port in $(seq $BACKEND_BASE_PORT $((BACKEND_BASE_PORT + 9))); do
        local pid=$(lsof -ti:$port 2>/dev/null || true)
        if [ -n "$pid" ]; then
            kill "$pid" 2>/dev/null || true
            log_info "Killed process on port $port (PID: $pid)"
        fi
    done

    for port in $(seq $FRONTEND_BASE_PORT $((FRONTEND_BASE_PORT + 9))); do
        local pid=$(lsof -ti:$port 2>/dev/null || true)
        if [ -n "$pid" ]; then
            kill "$pid" 2>/dev/null || true
            log_info "Killed process on port $port (PID: $pid)"
        fi
    done

    echo ""
    log_success "All sessions stopped"
    echo ""
}

show_status() {
    echo ""
    echo "========================================"
    echo "  Dev Session Status"
    echo "========================================"
    echo ""

    local found_any=false

    # Check backend sessions
    for pid_file in "$LOG_DIR"/backend-*.pid; do
        [ -e "$pid_file" ] || continue
        if [ -f "$pid_file" ]; then
            local pid=$(cat "$pid_file")
            local session=$(basename "$pid_file" | sed 's/backend-\([0-9]*\)\.pid/\1/')
            local port=$((BACKEND_BASE_PORT + session - 1))
            local data_dir=$(get_data_dir $session)
            if kill -0 "$pid" 2>/dev/null; then
                echo -e "  Backend $session:  ${GREEN}RUNNING${NC} (PID: $pid, Port: $port, Data: $data_dir)"
                found_any=true
            else
                echo -e "  Backend $session:  ${RED}STOPPED${NC} (stale PID file)"
            fi
        fi
    done

    # Check frontend sessions
    for pid_file in "$LOG_DIR"/frontend-*.pid; do
        [ -e "$pid_file" ] || continue
        if [ -f "$pid_file" ]; then
            local pid=$(cat "$pid_file")
            local session=$(basename "$pid_file" | sed 's/frontend-\([0-9]*\)\.pid/\1/')
            local port=$((FRONTEND_BASE_PORT + session - 1))
            if kill -0 "$pid" 2>/dev/null; then
                echo -e "  Frontend $session: ${GREEN}RUNNING${NC} (PID: $pid, Port: $port)"
                found_any=true
            else
                echo -e "  Frontend $session: ${RED}STOPPED${NC} (stale PID file)"
            fi
        fi
    done

    if [ "$found_any" = false ]; then
        echo "  No sessions running"
    fi

    echo ""
    echo "Logs directory: $LOG_DIR/"
    echo ""
}

show_logs() {
    local session=$1
    local type=$2

    if [ -z "$session" ]; then
        echo "Usage: $0 logs <session> [backend|frontend]"
        exit 1
    fi

    if [ -z "$type" ] || [ "$type" = "backend" ]; then
        local log_file="$LOG_DIR/backend-$session.log"
        if [ -f "$log_file" ]; then
            echo "=== Backend $session logs ==="
            tail -50 "$log_file"
        fi
    fi

    if [ -z "$type" ] || [ "$type" = "frontend" ]; then
        local log_file="$LOG_DIR/frontend-$session.log"
        if [ -f "$log_file" ]; then
            echo "=== Frontend $session logs ==="
            tail -50 "$log_file"
        fi
    fi
}

# Main
case "${1:-}" in
    stop)
        stop_sessions
        ;;
    status)
        show_status
        ;;
    logs)
        show_logs "$2" "$3"
        ;;
    [0-9]*)
        num_sessions=$1
        action="${2:-start}"
        case "$action" in
            start)
                start_sessions "$num_sessions"
                ;;
            *)
                echo "Unknown action: $action"
                echo "Usage: $0 <N> [start]"
                exit 1
                ;;
        esac
        ;;
    *)
        echo "Matou Dev Sessions"
        echo ""
        echo "Usage:"
        echo "  $0 <N>              Start N user sessions (frontend + backend each)"
        echo "  $0 <N> start        Same as above"
        echo "  $0 stop             Stop all running sessions"
        echo "  $0 status           Show status of all sessions"
        echo "  $0 logs <N>         Show logs for session N"
        echo ""
        echo "Examples:"
        echo "  $0 2                Start 2 sessions (admin + user)"
        echo "  $0 3 start          Start 3 sessions"
        echo "  $0 stop             Stop all sessions"
        echo ""
        echo "Sessions:"
        echo "  Session 1: Frontend :5100, Backend :4000 (data: ./data)"
        echo "  Session 2: Frontend :5101, Backend :4001 (data: ./data2)"
        echo "  Session N: Frontend :510(N-1), Backend :400(N-1) (data: ./dataN)"
        echo ""
        exit 1
        ;;
esac
