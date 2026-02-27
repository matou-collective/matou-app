#!/usr/bin/env bash
# Monitor network activity across dev sessions in real-time.
# Shows rolling summaries of HTTP requests and any-sync activity.
#
# Usage: ./scripts/monitor-activity.sh [interval_seconds]

set -euo pipefail

INTERVAL=${1:-10}
LOGDIR="/tmp/matou-dev"

# Colors
BOLD='\033[1m'
DIM='\033[2m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
RED='\033[0;31m'
RESET='\033[0m'

# Track byte offsets
OFF1=0; OFF2=0; OFF3=0

init() {
    for s in 1 2 3; do
        local log="$LOGDIR/backend-$s.log"
        if [[ -f "$log" ]]; then
            local sz; sz=$(stat -c%s "$log" 2>/dev/null || echo 0)
            eval "OFF$s=$sz"
        fi
    done
}

# Snapshot new log content since last check into a temp file, then count patterns
snapshot_and_count() {
    local session=$1
    local log="$LOGDIR/backend-$session.log"
    local tmpfile="/tmp/matou-monitor-$session.tmp"

    if [[ ! -f "$log" ]]; then
        > "$tmpfile"
        return
    fi

    local cur_off
    eval "cur_off=\$OFF$session"
    local new_sz; new_sz=$(stat -c%s "$log" 2>/dev/null || echo 0)

    if (( new_sz > cur_off )); then
        head -c "$new_sz" "$log" | tail -c +"$((cur_off + 1))" > "$tmpfile" 2>/dev/null
    else
        > "$tmpfile"
    fi

    eval "OFF$session=$new_sz"
}

count_pattern() {
    local session=$1
    local pattern=$2
    local tmpfile="/tmp/matou-monitor-$session.tmp"
    local n
    n=$(grep -c "$pattern" "$tmpfile" 2>/dev/null) || true
    echo "${n:-0}"
}

extract_pattern() {
    local session=$1
    local pattern=$2
    local tmpfile="/tmp/matou-monitor-$session.tmp"
    grep "$pattern" "$tmpfile" 2>/dev/null || true
}

echo ""
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${RESET}"
echo -e "${BOLD}  Matou Network Activity Monitor  ${DIM}(${INTERVAL}s intervals)${RESET}"
echo -e "${BOLD}═══════════════════════════════════════════════════════════════${RESET}"
echo ""

init

while true; do
    sleep "$INTERVAL"

    # Snapshot all 3 logs
    for s in 1 2 3; do
        snapshot_and_count "$s"
    done

    timestamp=$(date '+%H:%M:%S')
    total_http=0
    total_headsync=0
    total_consensus_err=0

    echo -e "${CYAN}[$timestamp]${RESET} ─────────────────────────────────────────────"

    for s in 1 2 3; do
        http=$(count_pattern "$s" '\[REQ\]')
        hs=$(count_pattern "$s" 'start diffsync')
        ce=$(count_pattern "$s" 'stream read error')

        total_http=$((total_http + http))
        total_headsync=$((total_headsync + hs))
        total_consensus_err=$((total_consensus_err + ce))

        if (( http > 0 )) || (( hs > 0 )); then
            echo -e "  ${BOLD}Session $s:${RESET} ${GREEN}${http} req${RESET}  ${YELLOW}${hs} sync${RESET}"

            if (( http > 0 )); then
                api_lines=$(extract_pattern "$s" '\[REQ\]')
                echo "$api_lines" | \
                    sed 's/.*\[REQ\] //' | \
                    awk '{print $1" "$2}' | \
                    sort | uniq -c | sort -rn | \
                    while read -r count method path; do
                        echo -e "    ${DIM}${count}× ${method} ${path}${RESET}"
                    done
            fi
        else
            echo -e "  ${BOLD}Session $s:${RESET} ${DIM}idle${RESET}"
        fi
    done

    echo -e "  ${DIM}────────────────────────────────────${RESET}"
    echo -e "  ${BOLD}Total:${RESET} ${GREEN}${total_http} req${RESET}  ${YELLOW}${total_headsync} sync${RESET}  ${RED}${total_consensus_err} err${RESET}"

    # Cleanup temp files
    rm -f /tmp/matou-monitor-{1,2,3}.tmp
done
