#!/bin/bash

# NXClaw - A zero-dependency, hacker-style CLI AI Agent.
#
# Supports Ollama, OpenAI-compatible, and Anthropic-compatible backends.
# Uses only the Python standard library. Works on Linux, macOS, and Windows.
#
# Run:
#     ./nxclaw.sh

# --------------------------------------------------------------------------
# Globals / constants
# --------------------------------------------------------------------------

CONFIG_FILENAME=".nxclaw_config.json"
VERSION="2.1.0"

IS_WINDOWS=$(uname -s | grep -i "MINGW" > /dev/null && echo "true" || echo "false")
IS_MACOS=$(uname -s | grep -i "Darwin" > /dev/null && echo "true" || echo "false")
IS_LINUX=$(uname -s | grep -i "Linux" > /dev/null && echo "true" || echo "false")

DEFAULT_ENDPOINTS=(
    ["ollama"]="http://localhost:11434"
    ["openai"]="https://api.openai.com/v1"
    ["claude"]="https://api.anthropic.com/v1"
)

FALLBACK_CLAUDE_MODELS=(
    "claude-3-5-sonnet-latest"
    "claude-3-5-haiku-latest"
    "claude-3-opus-latest"
)

DANGEROUS_PATTERNS=(
    "rm\s+-rf\s+/(\s|$)"
    "rm\s+-rf\s+/\*"
    "rm\s+-rf\s+~(\s|$)"
    "rm\s+-rf\s+--no-preserve-root"
    ":\(\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:"
    "mkfs\."
    "dd\s+.*of=/dev/(sd|hd|nvme|disk)"
    ">\s*/dev/(sd|hd|nvme|disk)[a-z0-9]*\s*$"
    "chmod\s+-R\s+000\s+/(\s|$)"
    "chown\s+-R\s+.*\s+/(\s|$)"
    "format\s+[a-z]:\s*/y"
    "diskpart"
)

# --------------------------------------------------------------------------
# Helper functions
# --------------------------------------------------------------------------

now_ts() {
    date +"%H:%M:%S"
}

_iter_lines() {
    # Yields lines from a streaming response in real-time as they arrive.
    while IFS= read -r line; do
        echo "$line"
    done
}

open_file_in_editor() {
    # Opens a file path using the default OS system editor.
    local file_path="$1"

    if [ "$IS_WINDOWS" = "true" ]; then
        if command -v start > /dev/null; then
            start "" "$file_path"
        else
            escaped=$(echo "$file_path" | sed 's/"/\\"/g')
            cmd.exe /c "start \"\" \"$escaped\""
        fi
    elif [ "$IS_MACOS" = "true" ]; then
        open "$file_path"
    else
        if command -v xdg-open > /dev/null; then
            xdg-open "$file_path"
        else
            editor=${EDITOR:-nano}
            "$editor" "$file_path"
        fi
    fi
}

process_file_attachments() {
    # Finds all @filename references, reads valid workspace files, and appends context.
    local user_input="$1"
    local tools_instance="$2"

    local matches=($(echo "$user_input" | grep -oE '@([a-zA-Z0-9_\-\.\/]+)' | sed 's/@//'))
    if [ ${#matches[@]} -eq 0 ]; then
        echo "$user_input"
        return
    fi

    # Remove duplicates
    local unique_matches=($(echo "${matches[@]}" | tr ' ' '\n' | sort -u | tr '\n' ' '))
    local appended_context=""

    for filename in "${unique_matches[@]}"; do
        local safe_path=$(_resolve_safe_path "$filename" "$tools_instance")
        if [ -f "$safe_path" ]; then
            content=$(cat "$safe_path" 2>/dev/null)
            appended_context+=$'\n\n=== ATTACHED FILE CONTENT: '"$filename"$'\n'"$content"$'\n=================================\n'
        fi
    done

    if [ -n "$appended_context" ]; then
        echo "$user_input"$'\n'"$appended_context"
    else
        echo "$user_input"
    fi
}

generate_diff_view() {
    # Generates a Git/GitHub style unified diff with colorful red and green outputs.
    local old_content="$1"
    local new_content="$2"
    local file_path="$3"
    local ui="$4"

    # Create temporary files for diff
    old_file=$(mktemp)
    new_file=$(mktemp)

    echo "$old_content" > "$old_file"
    echo "$new_content" > "$new_file"

    # Generate diff
    diff -u "$old_file" "$new_file" | sed \
        -e "s/^+/${ui}[GREEN]/g" \
        -e "s/^-/${ui}[RED]/g" \
        -e "s/^@@/${ui}[CYAN]/g" \
        -e "s/^.*/${ui}[GRAY]/g"

    # Clean up
    rm -f "$old_file" "$new_file"
}

# --------------------------------------------------------------------------
# Stream Printing Filter
# --------------------------------------------------------------------------

StreamFilter() {
    # State machine that processes a raw chunk stream and filters out <tool_call> XML
    # blocks so they are not printed to the console.
    local state="content"
    local buffer=""
    local tool_call_buffer=""
    local in_tool_call=false

    while IFS= read -r line; do
        for ((i=0; i<${#line}; i++)); do
            char="${line:$i:1}"

            case "$state" in
                "content")
                    if [ "$char" = "<" ]; then
                        buffer+="$char"
                        state="tag_start"
                    else
                        echo -n "$char"
                    fi
                    ;;
                "tag_start")
                    if [ "$char" = "/" ]; then
                        buffer+="$char"
                        state="tag_end"
                    elif [[ "$char" =~ [a-zA-Z] ]]; then
                        buffer+="$char"
                        state="tag_name"
                    else
                        echo -n "$buffer$char"
                        state="content"
                        buffer=""
                    fi
                    ;;
                "tag_name")
                    if [ "$char" = ">" ]; then
                        buffer+="$char"
                        if [[ "$buffer" =~ ^<tool_call ]]; then
                            in_tool_call=true
                            tool_call_buffer="$buffer"
                            buffer=""
                        else
                            echo -n "$buffer"
                            buffer=""
                        fi
                        state="content"
                    else
                        buffer+="$char"
                    fi
                    ;;
                "tag_end")
                    if [ "$char" = ">" ]; then
                        buffer+="$char"
                        if [[ "$buffer" =~ ^</tool_call ]]; then
                            in_tool_call=false
                            buffer=""
                        else
                            echo -n "$buffer"
                            buffer=""
                        fi
                        state="content"
                    else
                        buffer+="$char"
                    fi
                    ;;
            esac
        done
    done

    # Flush any remaining buffer
    if [ -n "$buffer" ]; then
        echo -n "$buffer"
    fi
}

# --------------------------------------------------------------------------
# Main execution
# --------------------------------------------------------------------------

main() {
    # Main function to handle the script execution
    echo "NXClaw v$VERSION - Hacker-style CLI AI Agent"
    echo "Type 'help' for available commands or 'exit' to quit."

    # Initialize configuration
    if [ ! -f "$CONFIG_FILENAME" ]; then
        cat > "$CONFIG_FILENAME" <<EOF
{
    "endpoints": {
        "ollama": "http://localhost:11434",
        "openai": "https://api.openai.com/v1",
        "claude": "https://api.anthropic.com/v1"
    },
    "default_model": "ollama",
    "workspace": "$(pwd)"
}
EOF
    fi

    # Main loop
    while true; do
        read -p "> " user_input

        case "$user_input" in
            "exit"|"quit")
                break
                ;;
            "help")
                echo "Available commands:"
                echo "  help - Show this help message"
                echo "  exit - Quit the program"
                echo "  config - Show current configuration"
                echo "  workspace - Show current workspace"
                ;;
            "config")
                cat "$CONFIG_FILENAME"
                ;;
            "workspace")
                jq -r '.workspace' "$CONFIG_FILENAME"
                ;;
            *)
                # Process user input and interact with AI
                processed_input=$(process_file_attachments "$user_input" "$tools_instance")
                # Here you would add the actual AI interaction logic
                echo "Processing: $processed_input"
                ;;
        esac
    done
}

# Start the main function
main
