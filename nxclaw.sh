#!/usr/bin/env bash
# nxclaw.sh - Bash port of NXClaw (simplified)

set -euo pipefail

# ---------------------------------------------------------------------------
# Globals / constants
# ---------------------------------------------------------------------------
CONFIG_FILENAME=".nxclaw_config.json"
VERSION="1.3.0"

IS_WINDOWS=false
case "$(uname -s)" in
    CYGWIN*|MINGW*|MSYS*) IS_WINDOWS=true ;;
esac

DEFAULT_ENDPOINTS=(
    ["ollama"]="http://localhost:11434"
    ["openai"]="https://api.openai.com/v1"
    ["claude"]="https://api.anthropic.com/v1"
)

FALLBACK_CLAUDE_MODELS=(
    "claude-fable-5"
    "claude-3-5-sonnet-latest"
    "claude-3-5-haiku-latest"
    "claude-3-opus-latest"
)

# ---------------------------------------------------------------------------
# Helper functions
# ---------------------------------------------------------------------------
now_ts() {
    date +"%H:%M:%S"
}

color() {
    local txt=$1 code=$2
    if [[ -t 1 ]]; then
        echo -e "\e[${code}m${txt}\e[0m"
    else
        echo "$txt"
    fi
}

red()   { color "$1" 31; }
green() { color "$1" 32; }
yellow(){ color "$1" 33; }
cyan()  { color "$1" 36; }
gray()  { color "$1" 90; }

# ---------------------------------------------------------------------------
# Config handling (requires jq)
# ---------------------------------------------------------------------------
load_config() {
    local ws=${1:-$(pwd)}
    CONFIG_PATH="${ws}/${CONFIG_FILENAME}"
    if [[ -f "$CONFIG_PATH" ]]; then
        CONFIG_JSON=$(cat "$CONFIG_PATH")
    else
        CONFIG_JSON='{}'
    fi
    # Ensure required keys exist
    provider=$(echo "$CONFIG_JSON" | jq -r '.provider // "ollama"')
    endpoint=$(echo "$CONFIG_JSON" | jq -r ".endpoint // \"${DEFAULT_ENDPOINTS[$provider]}\"")
    api_key=$(echo "$CONFIG_JSON" | jq -r '.api_key // ""')
    model=$(echo "$CONFIG_JSON" | jq -r '.model // ""')
    auto_confirm=$(echo "$CONFIG_JSON" | jq -r '.auto_confirm // false')
    workspace=$(echo "$CONFIG_JSON" | jq -r '.workspace // "'"$ws"'"')
}

save_config() {
    local ws=${1:-$(pwd)}
    cat > "${ws}/${CONFIG_FILENAME}" <<EOF
{
  "provider": "$provider",
  "endpoint": "$endpoint",
  "api_key": "$api_key",
  "model": "$model",
  "auto_confirm": $auto_confirm,
  "workspace": "$workspace"
}
EOF
}

# ---------------------------------------------------------------------------
# UI / simple banners
# ---------------------------------------------------------------------------
banner() {
    clear
    echo -e "$(green " _   _ __  _______ _")"
    echo -e "$(green "| | | |\ \/ /  ___| |")"
    echo -e "$(green "| |_| \  /| |   | |    ____  __ ___      __")"
    echo -e "$(green "|  _  | \/ | |   | |   / __ \\ \ /\ / /")"
    echo -e "$(green "| | | /  \\| |___| |__| (__) |\\ V  V /")"
    echo -e "$(green "|_| |_/_/\\_\\____/|_____\\____/  \\_/\\_/")"
    echo -e "$(cyan "  >> Autonomous Terminal Agent <<")"
    echo -e "$(gray "  v${VERSION}  |  stdlib-only  |  $(uname -s)")"
    echo
}

# ---------------------------------------------------------------------------
# API client (supports Ollama, OpenAI, Claude) using curl
# ---------------------------------------------------------------------------
api_chat() {
    local system_prompt=$1
    local messages_json=$2   # JSON array string
    local on_chunk_cb=$3    # name of function to call with chunk text

    local url data response
    case "$provider" in
        ollama)
            url="${endpoint%/}/api/chat"
            data=$(jq -n \
                --arg model "$model" \
                --argjson messages "$messages_json" \
                --arg system "$system_prompt" \
                '{model:$model, messages:([$system]|map({role:"system",content:.}))+ $messages, stream:true}')
            ;;
        openai)
            url="${endpoint%/}/chat/completions"
            data=$(jq -n \
                --arg model "$model" \
                --argjson messages "$messages_json" \
                --arg system "$system_prompt" \
                '{model:$model, messages:([$system]|map({role:"system",content:.}))+ $messages, stream:true}')
            ;;
        claude)
            url="${endpoint%/}/messages"
            data=$(jq -n \
                --arg model "$model" \
                --argjson messages "$messages_json" \
                --arg system "$system_prompt" \
                '{model:$model, max_tokens:4096, system:$system, messages:$messages, stream:true}')
            ;;
        *)
            echo "Unsupported provider: $provider" >&2
            return 1
            ;;
    esac

    # Build headers
    headers=("-H" "Content-Type: application/json")
    if [[ -n "$api_key" ]]; then
        case "$provider" in
            openai)  headers+=("-H" "Authorization: Bearer $api_key") ;;
            claude)  headers+=("-H" "x-api-key: $api_key" "-H" "anthropic-version: 2023-06-01") ;;
        esac
    fi

    # Stream response line‑by‑line
    curl -s "${headers[@]}" -d "$data" "$url" | while IFS= read -r line; do
        # Remove leading "data: " if present
        [[ "$line" == data:* ]] && line="${line#data: }"
        [[ -z "$line" || "$line" == "[DONE]" ]] && continue
        # Extract content depending on provider
        case "$provider" in
            ollama)
                content=$(echo "$line" | jq -r '.message.content // empty')
                ;;
            openai|claude)
                content=$(echo "$line" | jq -r '.choices[0].delta.content // empty')
                ;;
        esac
        [[ -n "$content" ]] && {
            echo -n "$content"
            if [[ -n "$on_chunk_cb" ]]; then
                "$on_chunk_cb" "$content"
            fi
        }
    done
    echo
}

list_models() {
    local url response
    case "$provider" in
        ollama)
            url="${endpoint%/}/api/tags"
            response=$(curl -s "$url")
            echo "$response" | jq -r '.models[].name' ;;
        openai)
            url="${endpoint%/}/models"
            response=$(curl -s -H "Authorization: Bearer $api_key" "$url")
            echo "$response" | jq -r '.data[].id' ;;
        claude)
            printf "%s\n" "${FALLBACK_CLAUDE_MODELS[@]}" ;;
    esac
}

# ---------------------------------------------------------------------------
# Tool implementations (subset)
# ---------------------------------------------------------------------------
run_command() {
    local cmd=$1
    timeout 120 bash -c "$cmd" 2>&1 || echo "[error] Command failed or timed out"
}

write_file() {
    local path=$1 content=$2
    mkdir -p "$(dirname "$path")"
    echo -n "$content" > "$path"
    echo "[ok] Wrote to $path"
}

read_file() {
    local path=$1
    if [[ -f "$path" ]]; then
        cat "$path"
    else
        echo "[error] File not found: $path"
    fi
}

patch_file() {
    local path=$1 search=$2 replace=$3
    if [[ ! -f "$path" ]]; then
        echo "[error] File not found: $path"
        return
    fi
    if grep -Fq "$search" "$path"; then
        sed -i "0,/${search}/s//${replace}/" "$path"
        echo "[ok] Patched $path"
    else
        echo "[error] Search block not found"
    fi
}

python_eval() {
    local code=$1
    python3 - <<PY
import sys, traceback, io, contextlib
stdout = io.StringIO()
stderr = io.StringIO()
with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
    try:
        exec("""$code""", {"__name__":"__nxclaw_eval__"})
    except Exception:
        traceback.print_exc()
out = stdout.getvalue()
err = stderr.getvalue()
if out:
    print("--- stdout ---")
    print(out)
if err:
    print("--- stderr/traceback ---")
    print(err)
PY
}

browse_web() {
    local url=$1
    if ! [[ "$url" =~ ^https?:// ]]; then
        echo "[error] Invalid URL"
        return
    fi
    curl -sL "$url" | html2text -width 120 2>/dev/null || echo "[error] Failed to fetch"
}

# ---------------------------------------------------------------------------
# Tool call parsing
# ---------------------------------------------------------------------------
parse_tool_call() {
    local text=$1
    if [[ "$text" =~ \<tool_call[[:space:]]+name=\"([^\"]+)\"\>(.*)\</tool_call\> ]]; then
        tool_name="${BASH_REMATCH[1]}"
        inner="${BASH_REMATCH[2]}"
        declare -A params
        while [[ "$inner" =~ \<([a-zA-Z_]+)\>(.*?)\</\1\> ]]; do
            key="${BASH_REMATCH[1]}"
            val="${BASH_REMATCH[2]}"
            params["$key"]="$val"
            inner="${inner#${BASH_REMATCH[0]}}"
        done
        echo "$tool_name"
        for k in "${!params[@]}"; do
            echo "$k=${params[$k]}"
        done
        return 0
    else
        echo "NO_TOOL"
        return 1
    fi
}

execute_tool() {
    local name=$1; shift
    declare -A args
    while (( "$#" )); do
        IFS='=' read -r k v <<<"$1"
        args["$k"]="$v"
        shift
    done

    case "$name" in
        run_command)   run_command "${args[command]}" ;;
        write_file)    write_file "${args[path]}" "${args[content]}" ;;
        read_file)     read_file "${args[path]}" ;;
        patch_file)    patch_file "${args[path]}" "${args[search_block]}" "${args[replace_block]}" ;;
        python_eval)   python_eval "${args[code]}" ;;
        browse_web)    browse_web "${args[url]}" ;;
        *) echo "[error] Unknown tool $name" ;;
    esac
}

# ---------------------------------------------------------------------------
# Main REPL loop
# ---------------------------------------------------------------------------
main() {
    banner
    load_config "$(pwd)"
    if [[ -z "$model" ]]; then
        model="${DEFAULT_ENDPOINTS[$provider]}"
    fi

    echo "$(green "Configuration loaded:")"
    echo " Provider   : $provider"
    echo " Endpoint   : $endpoint"
    echo " Model      : $model"
    echo " Workspace  : $workspace"
    echo

    while true; do
        printf "$(cyan "> ")" 
        IFS= read -r user_input || break
        [[ -z "$user_input" ]] && continue

        if [[ "$user_input" == /* ]]; then
            case "$user_input" in
                /exit|/quit) echo "Goodbye"; break ;;
                /settings)    # placeholder for settings dialog
                    echo "Settings not implemented in this shim."
                    ;;
                /model)
                    echo "Current model: $model"
                    read -p "Enter new model ID: " new_model
                    [[ -n "$new_model" ]] && model="$new_model"
                    ;;
                /auto-confirm)
                    ((auto_confirm=!auto_confirm))
                    echo "Auto‑confirm now $( $auto_confirm && echo ON || echo OFF )"
                    ;;
                /clear)
                    history=()
                    echo "History cleared."
                    ;;
                /help|/\?)
                    echo "/exit, /quit       – quit"
                    echo "/settings          – reconfigure (not implemented)"
                    echo "/model             – change model"
                    echo "/auto-confirm      – toggle auto‑confirm"
                    echo "/clear             – clear history"
                    echo "/help, /?          – this help"
                    ;;
                *)
                    echo "Unknown command."
                    ;;
            esac
            continue
        fi

        # Build messages JSON array for API call
        msg_user=$(jq -n --arg c "$user_input" '{role:"user",content:$c}')
        messages=("[${msg_user}]")   # simple single‑turn history for demo

        # Call API (streaming)
        response=$(api_chat "$system_prompt" "$(printf '%s' "${messages[@]}" | jq -s '.')" "")
        # Parse tool call if present
        if parse_tool_call "$response" >/dev/null 2>&1; then
            tool=$(parse_tool_call "$response")
            if [[ "$tool" != "NO_TOOL" ]]; then
                echo "$(yellow "[Tool call detected: $tool]")"
                # Re‑parse to get params (simplified)
                parse_tool_call "$response" > /tmp/tool_parse.tmp
                mapfile -t lines < /tmp/tool_parse.tmp
                tool_name="${lines[0]}"
                unset params
                declare -A params
                for ((i=1;i<${#lines[@]};i++)); do
                    IFS='=' read -r k v <<<"${lines[i]}"
                    params["$k"]="$v"
                done
                # Execute
                result=$(execute_tool "$tool_name" "$(printf '%s=%s\n' "${!params[@]}" "${params[@]}")")
                echo "$(cyan "[Tool result]")"
                echo "$result"
                # Feed result back to model (omitted for brevity)
            else
                echo "$response"
            fi
        else
            echo "$response"
        fi
    done
}

main "$@"
