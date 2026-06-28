```sh
#!/usr/bin/env sh
# NXClaw - Shell port (simplified)

# ------------------- Globals -------------------
CONFIG_FILE=".nxclaw_config.json"
VERSION="2.0.0"

IS_WINDOWS=$(uname -s | grep -i 'mingw\|cygwin' >/dev/null && echo "yes" || echo "no")
IS_MACOS=$(uname -s | grep -i 'darwin' >/dev/null && echo "yes")
IS_LINUX=$(uname -s | grep -i 'linux' >/dev/null && echo "yes")

DEFAULT_ENDPOINT_OLLAMA="http://localhost:11434"
DEFAULT_ENDPOINT_OPENAI="https://api.openai.com/v1"
DEFAULT_ENDPOINT_CLAUDE="https://api.anthropic.com/v1"

# ------------------- Helpers -------------------
now_ts() {
    date "+%H:%M:%S"
}

open_file_in_editor() {
    file="$1"
    if [ "$IS_WINDOWS" = "yes" ]; then
        start "" "$(cygpath -w "$file")" 2>/dev/null || cmd /c start "" "$(cygpath -w "$file")"
    elif [ "$IS_MACOS" = "yes" ]; then
        open "$file"
    else
        xdg-open "$file" 2>/dev/null || "${EDITOR:-nano}" "$file"
    fi
}

process_file_attachments() {
    input="$1"
    echo "$input" | grep -o '@[^[:space:]]\+' | sed 's/^@//' | sort -u | while IFS= read -r fn; do
        if [ -f "$fn" ]; then
            printf "\n\n=== ATTACHED FILE CONTENT: %s ===\n" "$fn"
            cat "$fn"
            printf "\n=================================\n"
        fi
    done
    printf "\n"
    printf "%s" "$input"
}

# ------------------- Config -------------------
load_config() {
    if [ -f "$CONFIG_FILE" ]; then
        PROVIDER=$(awk -F'"' '/"provider"/{print $4}' "$CONFIG_FILE")
        ENDPOINT=$(awk -F'"' '/"endpoint"/{print $4}' "$CONFIG_FILE")
        API_KEY=$(awk -F'"' '/"api_key"/{print $4}' "$CONFIG_FILE")
        MODEL=$(awk -F'"' '/"model"/{print $4}' "$CONFIG_FILE")
        AUTO_CONFIRM=$(awk -F'"' '/"auto_confirm"/{print $4}' "$CONFIG_FILE")
        WORKSPACE=$(awk -F'"' '/"workspace"/{print $4}' "$CONFIG_FILE")
    else
        PROVIDER="ollama"
        ENDPOINT="$DEFAULT_ENDPOINT_OLLAMA"
        API_KEY=""
        MODEL="qwen2.5-coder:7b"
        AUTO_CONFIRM="false"
        WORKSPACE="${HOME}/NXClaw"
    fi
    mkdir -p "$WORKSPACE"
}

save_config() {
    cat >"$CONFIG_FILE" <<EOF
{
  "provider": "$PROVIDER",
  "endpoint": "$ENDPOINT",
  "api_key": "$API_KEY",
  "model": "$MODEL",
  "auto_confirm": $AUTO_CONFIRM,
  "workspace": "$WORKSPACE"
}
EOF
}

# ------------------- Tools -------------------
run_command() {
    cmd="$1"
    timeout 120 sh -c "$cmd" 2>&1 || echo "[error] Command failed or timed out"
}
write_file() {
    path="$1"
    content="$2"
    dir=$(dirname "$path")
    mkdir -p "$dir"
    printf "%s" "$content" >"$path"
    echo "[ok] Wrote to $path"
}
read_file() {
    path="$1"
    if [ -f "$path" ]; then
        cat "$path"
    else
        echo "[error] File not found: $path"
    fi
}
patch_file() {
    path="$1"
    search="$2"
    replace="$3"
    if [ -f "$path" ]; then
        if grep -Fqx "$search" "$path"; then
            sed -i "0,/$search/{s/$search/$replace/}" "$path"
            echo "[ok] Patched $path"
        else
            echo "[error] Search block not found"
        fi
    else
        echo "[error] File not found: $path"
    fi
}
python_eval() {
    code="$1"
    python3 - <<PY
$code
PY
}
browse_web() {
    url="$1"
    curl -sL "$url" | sed -e 's/<script[^>]*>.*<\/script>//g' \
                        -e 's/<style[^>]*>.*<\/style>//g' \
                        -e 's/<[^>]*>/ /g' \
                        -e 's/&nbsp;/ /g' \
                        -e 's/&amp;/\&/g' \
                        -e 's/&lt;/</g' -e 's/&gt;/>/g' \
                        -e 's/[ \t]\+/ /g' \
                        -e 's/^[ \t]*//g' \
                        -e 's/[ \t]*$//g' \
                        -e 's/^$//g'
}
# ------------------- API -------------------
chat_ollama() {
    # $1: system prompt
    # $2: messages (JSON array)
    payload=$(printf '{"model":"%s","messages":%s,"stream":true}' "$MODEL" "$2")
    curl -s -N -X POST "$ENDPOINT/api/chat" \
        -H "Content-Type: application/json" \
        -d "$payload" | while IFS= read -r line; do
            printf "%s" "$(printf "%s" "$line" | jq -r '.message.content // empty')"
        done
}
chat_openai() {
    payload=$(printf '{"model":"%s","messages":%s,"stream":true}' "$MODEL" "$2")
    curl -s -N -X POST "$ENDPOINT/chat/completions" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $API_KEY" \
        -d "$payload" | while IFS= read -r line; do
        [ -z "$line" ] && continue
        if echo "$line" | grep -q '^data:'; then
            data=$(printf "%s" "$line" | cut -c7-)
            [ "$data" = "[DONE]" ] && break
            printf "%s" "$(printf "%s" "$data" | jq -r '.choices[0].delta.content // empty')"
        fi
    done
}
chat_claude() {
    payload=$(printf '{"model":"%s","max_tokens":4096,"system":"%s","messages":%s,"stream":true}' "$MODEL" "$1" "$2")
    curl -s -N -X POST "$ENDPOINT/messages" \
        -H "Content-Type: application/json" \
        -H "x-api-key: $API_KEY" \
        -H "anthropic-version: 2023-06-01" \
        -d "$payload" | while IFS= read -r line; do
        [ -z "$line" ] && continue
        if echo "$line" | grep -q '^data:'; then
            data=$(printf "%s" "$line" | cut -c7-)
            type=$(printf "%s" "$data" | jq -r '.type')
            if [ "$type" = "content_block_delta" ]; then
                printf "%s" "$(printf "%s" "$data" | jq -r '.delta.text // empty')"
            elif [ "$type" = "message_stop" ]; then
                break
            fi
        fi
    done
}
chat() {
    system_prompt="$1"
    messages_json="$2"
    case "$PROVIDER" in
        ollama) chat_ollama "$system_prompt" "$messages_json" ;;
        openai) chat_openai "$messages_json" ;;
        claude) chat_claude "$system_prompt" "$messages_json" ;;
        *) echo "[error] Unknown provider" ;;
    esac
}
# ------------------- Main Loop -------------------
load_config
save_config

echo "NXClaw v$VERSION"
echo "Workspace: $WORKSPACE"
echo "Provider: $PROVIDER"
echo "Model: $MODEL"
echo "Type /help for commands"

while :; do
    printf "\n> "
    IFS= read -r user_input
    [ -z "$user_input" ] && continue

    case "$user_input" in
        /exit|/quit) echo "Goodbye!"; exit 0 ;;
        /help|\?) 
            cat <<HELP
Commands:
/exit, /quit    - terminate session
/help, /?       - this help
/auto-confirm   - toggle auto‑confirm mode
/ls             - list workspace files
/rm <path>      - remove file/folder
/open <path>    - open file in editor
/help           - show this help
Anything else is sent to the AI.
HELP
            ;;
        /auto-confirm)
            if [ "$AUTO_CONFIRM" = "true" ]; then
                AUTO_CONFIRM="false"
                echo "Auto‑confirm disabled."
            else
                AUTO_CONFIRM="true"
                echo "Auto‑confirm enabled."
            fi
            save_config
            ;;
        /ls)
            ls -1 "$WORKSPACE"
            ;;
        /rm\ *)
            target=$(printf "%s" "$user_input" | cut -d' ' -f2-)
            path="$WORKSPACE/$target"
            if [ -e "$path" ]; then
                rm -rf "$path" && echo "Removed $target"
            else
                echo "[error] Not found: $target"
            fi
            ;;
        /open\ *)
            target=$(printf "%s" "$user_input" | cut -d' ' -f2-)
            path="$WORKSPACE/$target"
            if [ -f "$path" ]; then
                open_file_in_editor "$path"
            else
                echo "[error] Not found: $target"
            fi
            ;;
        *)
            # attach @files
            ATTACH=$(process_file_attachments "$user_input")
            # Build messages JSON (only last user message for simplicity)
            MSGS='[{"role":"user","content":"'"$(printf "%s" "$ATTACH" | sed 's/"/\\"/g')"'" }]'
            # Call AI
            RESPONSE=$(chat "You are NXClaw." "$MSGS")
            # Simple tool call detection
            if printf "%s" "$RESPONSE" | grep -q '<tool_call'; then
                TOOL=$(printf "%s" "$RESPONSE" | grep -oP '(?<=<tool_call name=")[^"]+')
                case "$TOOL" in
                    run_command)
                        CMD=$(printf "%s" "$RESPONSE" | grep -oP '(?<=<command>).*?(?=</command>)')
                        echo ">> Running command: $CMD"
                        run_command "$CMD"
                        ;;
                    write_file)
                        PATH=$(printf "%s" "$RESPONSE" | grep -oP '(?<=<path>).*?(?=</path>)')
                        CONTENT=$(printf "%s" "$RESPONSE" | grep -oP '(?<=<content>).*?(?=</content>)')
                        write_file "$WORKSPACE/$PATH" "$CONTENT"
                        ;;
                    read_file)
                        PATH=$(printf "%s" "$RESPONSE" | grep -oP '(?<=<path>).*?(?=</path>)')
                        read_file "$WORKSPACE/$PATH"
                        ;;
                    patch_file)
                        PATH=$(printf "%s" "$RESPONSE" | grep -oP '(?<=<path>).*?(?=</path>)')
                        SEARCH=$(printf "%s" "$RESPONSE" | grep -oP '(?<=<search_block>).*?(?=</search_block>)')
                        REPLACE=$(printf "%s" "$RESPONSE" | grep -oP '(?<=<replace_block>).*?(?=</replace_block>)')
                        patch_file "$WORKSPACE/$PATH" "$SEARCH" "$REPLACE"
                        ;;
                    python_eval)
                        CODE=$(printf "%s" "$RESPONSE" | grep -oP '(?<=<code>).*?(?=</code>)')
                        python_eval "$CODE"
                        ;;
                    browse_web)
                        URL=$(printf "%s" "$RESPONSE" | grep -oP '(?<=<url>).*?(?=</url>)')
                        browse_web "$URL"
                        ;;
                    *)
                        echo "[error] Unknown tool: $TOOL"
                        ;;
                esac
            else
                echo "$RESPONSE"
            fi
            ;;
    esac
done
```