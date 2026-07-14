#!/usr/bin/env bash
# Format C# code using dotnet format
# This script formats C# files using the nearest solution file
# Groups files by solution and formats them in batches for better performance
# Usage: bash format-code.sh <file-path1> [<file-path2> [<file-path3> ...]]
# Example: bash format-code.sh "src/File1.cs" "src/File2.cs" "src/File3.cs"

set -euo pipefail

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Determine project root (script is at .claude/skills/format-code/format-code.sh)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

LOG_FILE="$PROJECT_ROOT/.claude/format-code.log"
mkdir -p "$(dirname "$LOG_FILE")"

log() {
    local timestamp
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "$timestamp | $1" >> "$LOG_FILE" 2>/dev/null || true
}

log "=== Format script started ==="
log "Project root: $PROJECT_ROOT"
log "File paths (raw): $*"

# Function to find .sln file in directory or parent directories
find_solution() {
    local current_path="$1"
    local depth=0

    while [[ -n "$current_path" && $depth -lt 10 ]]; do
        log "  Searching in: $current_path (depth: $depth)"
        if [[ -d "$current_path" ]]; then
            local sln_file
            sln_file=$(find "$current_path" -maxdepth 1 -name "*.sln" -print -quit 2>/dev/null)
            if [[ -n "$sln_file" ]]; then
                log "  Found solution: $sln_file"
                echo "$sln_file"
                return 0
            fi
            log "  No .sln files found in: $current_path"
        else
            log "  Path does not exist: $current_path"
        fi

        local parent_path
        parent_path="$(dirname "$current_path")"
        if [[ "$parent_path" == "$current_path" ]]; then
            log "  Reached root directory"
            break
        fi
        current_path="$parent_path"
        ((depth++))
    done
    log "  Solution not found after searching $depth levels"
    return 1
}

if [[ $# -eq 0 ]]; then
    echo -e "${YELLOW}Usage: bash format-code.sh <file-path1> [<file-path2> ...]${NC}"
    exit 0
fi

# Resolve and filter C# files
declare -a resolved_files=()

for file_path in "$@"; do
    # Resolve to absolute path
    if [[ "$file_path" != /* ]]; then
        file_path="$(cd "$PROJECT_ROOT" && realpath --no-symlinks "$file_path" 2>/dev/null || echo "$PROJECT_ROOT/$file_path")"
    fi

    # Check if file exists
    if [[ ! -f "$file_path" ]]; then
        log "WARNING: File does not exist: $file_path"
        echo -e "${YELLOW}Warning: File not found: $file_path${NC}"
        continue
    fi

    # Only process C# files
    if [[ "$file_path" == *.cs ]]; then
        resolved_files+=("$file_path")
        log "Added C# file: $file_path"
    else
        log "Skipping non-C# file: $file_path"
    fi
done

if [[ ${#resolved_files[@]} -eq 0 ]]; then
    log "No C# files to format"
    echo -e "${YELLOW}No C# files to format${NC}"
    exit 0
fi

log "Processing ${#resolved_files[@]} C# file(s)"

# Group files by solution
# Using associative arrays: solution_path -> space-separated file list
declare -A files_by_solution
declare -a files_without_solution=()

for file_path in "${resolved_files[@]}"; do
    solution_path=""
    file_dir="$(dirname "$file_path")"

    if [[ -n "$file_dir" ]]; then
        log "Searching for .sln for file: $file_path"
        solution_path=$(find_solution "$file_dir") || true
    fi

    # If not found, search in project root
    if [[ -z "$solution_path" ]]; then
        log "Solution not found in file directory, searching project root"
        solution_path=$(find_solution "$PROJECT_ROOT") || true
    fi

    if [[ -n "$solution_path" ]]; then
        solution_path="$(realpath "$solution_path")"
        if [[ -v files_by_solution["$solution_path"] ]]; then
            files_by_solution["$solution_path"]+=$'\n'"$file_path"
        else
            files_by_solution["$solution_path"]="$file_path"
        fi
    else
        files_without_solution+=("$file_path")
    fi
done

# Format files grouped by solution
total_formatted=0
total_errors=0

for solution_path in "${!files_by_solution[@]}"; do
    IFS=$'\n' read -r -d '' -a files <<< "${files_by_solution[$solution_path]}" || true
    solution_dir="$(dirname "$solution_path")"
    solution_name="$(basename "$solution_path")"

    log "Formatting ${#files[@]} file(s) with solution: $solution_path"
    log "Solution directory: $solution_dir"

    # Build include args with relative paths
    include_args=()
    for file_path in "${files[@]}"; do
        relative_path="$(realpath --relative-to="$solution_dir" "$file_path" 2>/dev/null || echo "$file_path")"
        log "Relative file path: $relative_path"
        include_args+=("--include" "$relative_path")
    done

    log "Command: cd \"$solution_dir\" ; dotnet format --no-restore $solution_name ${include_args[*]}"

    if (cd "$solution_dir" && dotnet format --no-restore "$solution_name" "${include_args[@]}" 2>&1); then
        echo -e "${GREEN}Formatted ${#files[@]} file(s) with solution: $solution_name${NC}"
        ((total_formatted += ${#files[@]}))
    else
        echo -e "${YELLOW}Formatting completed with warnings for ${#files[@]} file(s): $solution_name${NC}"
        ((total_formatted += ${#files[@]}))
    fi
done

# Handle files without solution (fallback)
for file_path in "${files_without_solution[@]}"; do
    log "WARNING: No solution file found for: $file_path, trying fallback"
    file_dir="$(dirname "$file_path")"
    file_name="$(basename "$file_path")"

    if (cd "$file_dir" && dotnet format --no-restore . --include "$file_name" 2>&1); then
        echo -e "${GREEN}Formatted (fallback): $file_path${NC}"
        ((total_formatted++))
    else
        echo -e "${RED}Error formatting $file_path (fallback)${NC}"
        ((total_errors++))
    fi
done

log "=== Format script completed ==="
log "Total formatted: $total_formatted, Total errors: $total_errors"

if [[ $total_formatted -gt 0 ]]; then
    echo -e "${GREEN}Formatting completed: $total_formatted file(s) formatted${NC}"
fi
if [[ $total_errors -gt 0 ]]; then
    echo -e "${RED}Formatting errors: $total_errors file(s) failed${NC}"
    exit 1
fi

exit 0
