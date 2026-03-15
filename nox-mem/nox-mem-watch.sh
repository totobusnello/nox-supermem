#!/bin/bash
# Debounced file watcher for nox-mem auto-indexation
# Uses lock file for reliable debounce (no subshell variable issues)

WATCH_DIRS=(
    "/root/.openclaw/workspace/memory"
    "/root/.openclaw/workspace/shared"
)
LOCK_DIR="/tmp/nox-mem-locks"
DEBOUNCE_SEC=3

mkdir -p "$LOCK_DIR"

inotifywait -m -r -e modify,create \
    --include '\.(md|json)$' \
    "${WATCH_DIRS[@]}" \
    --format '%w%f' 2>/dev/null | while IFS= read -r file; do

    # Skip MEMORY.md and SESSION-STATE.md
    [[ "$file" == *"/MEMORY.md" ]] && continue
    [[ "$file" == *"/SESSION-STATE.md" ]] && continue

    # Debounce using lock file per source file
    LOCK_FILE="$LOCK_DIR/$(echo "$file" | md5sum | cut -d' ' -f1).lock"

    if [[ -f "$LOCK_FILE" ]]; then
        LOCK_AGE=$(( $(date +%s) - $(stat -c %Y "$LOCK_FILE" 2>/dev/null || echo 0) ))
        if [[ $LOCK_AGE -lt $DEBOUNCE_SEC ]]; then
            continue
        fi
    fi

    # Create/update lock file
    touch "$LOCK_FILE"

    # Ingest with validated path
    if [[ -f "$file" ]]; then
        /usr/local/bin/nox-mem ingest "$file" 2>&1 | logger -t nox-mem-watcher
    fi
done
