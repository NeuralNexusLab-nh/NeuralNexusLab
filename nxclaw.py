#!/usr/bin/env python3
"""
NXClaw - A zero-dependency, hacker-style CLI AI Agent.

Supports Ollama, OpenAI-compatible, and Anthropic-compatible backends.
Uses only the Python standard library. Works on Linux, macOS, and Windows.

Run:
    python3 nxclaw.py
"""

import os
import re
import sys
import json
import time
import shutil
import signal
import platform
import subprocess
import urllib.request
import urllib.error
import urllib.parse
import getpass
import threading
import itertools
import io
import contextlib
import traceback
from datetime import datetime

# --------------------------------------------------------------------------
# Globals / constants
# --------------------------------------------------------------------------

CONFIG_FILENAME = ".nxclaw_config.json"
VERSION = "1.3.0"

IS_WINDOWS = platform.system().lower().startswith("win")
IS_MACOS = platform.system().lower() == "darwin"
IS_LINUX = platform.system().lower() == "linux"

DEFAULT_ENDPOINTS = {
    "ollama": "http://localhost:11434",
    "openai": "https://api.openai.com/v1",
    "claude": "https://api.anthropic.com/v1",
}

FALLBACK_CLAUDE_MODELS = [
    "claude-fable-5",
    "claude-3-5-sonnet-latest",
    "claude-3-5-haiku-latest",
    "claude-3-opus-latest",
]

RECOMMENDED_MODELS = {
    "ollama": [
        "gemma4:e2b", "gemma4:e4b", "qwen3:32b", "phi4:14b", "glm-4.7-flash", "glm4",
        "qwen2.5-coder", "qwen2.5", "qwen3", "llama3.1", "llama3.3",
        "mistral-nemo", "mixtral", "deepseek-coder-v2", "deepseek-r1",
    ],
    "openai": [
        "gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano", "gpt-5.3", "gpt-5.2",
        "gpt-5.1", "gpt-5", "gpt-5-nano", "gpt-5-mini", "o4-mini", "o3",
        "gpt-4o", "gpt-4-turbo", "deepseek-chat", "deepseek-coder",
    ],
    "claude": [
        "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
        "claude-sonnet-4-6", "claude-sonnet-4-5", "claude-haiku-4-5",
        "claude-3-5-sonnet", "claude-3-opus",
    ],
}

TOOL_MODEL_WARNING = (
    "NXClaw's tool-calling mechanism requires the model to output a specific XML <tool_call> block format.\n"
    "This requires the model to have strong instruction-following capabilities — not all models can do this.\n\n"
    "We highly recommend using models such as:\n"
    "  - Recent instruction-tuned models\n"
    "  - Models explicitly marked with support for 'function calling' or 'tool use'\n"
    "  - e.g., Claude Fable 5, GPT-5.5, Qwen 3, DeepSeek R1, Llama 3.3\n\n"
    "Small or older conversational models (such as <3B parameters) often fail to output structured XML\n"
    "properly, which can cause the agent loop to stall or repeat without making progress."
)

DANGEROUS_PATTERNS = [
    r"rm\s+-rf\s+/(\s|$)",
    r"rm\s+-rf\s+/\*",
    r"rm\s+-rf\s+~(\s|$)",
    r"rm\s+-rf\s+--no-preserve-root",
    r":\(\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:",   # fork bomb
    r"mkfs\.",
    r"dd\s+.*of=/dev/(sd|hd|nvme|disk)",
    r">\s*/dev/(sd|hd|nvme|disk)[a-z0-9]*\s*$",
    r"chmod\s+-R\s+000\s+/(\s|$)",
    r"chown\s+-R\s+.*\s+/(\s|$)",
    r"format\s+[a-z]:\s*/y",   # windows format
    r"diskpart",
]


def now_ts():
    return datetime.now().strftime("%H:%M:%S")


def is_recommended_model(provider, model_name):
    if not model_name:
        return False
    name_lower = model_name.lower()
    for known in RECOMMENDED_MODELS.get(provider, []):
        if known.lower() in name_lower:
            return True
    return False


def _iter_lines(resp):
    """Yields lines from a streaming response in real-time as they arrive."""
    while True:
        line = resp.readline()
        if not line:
            break
        yield line


def open_file_in_editor(file_path):
    """Opens a file path using the default OS system editor."""
    try:
        if IS_WINDOWS:
            try:
                os.startfile(file_path)
            except AttributeError:
                escaped = file_path.replace('"', '\\"')
                subprocess.run(f'start "" "{escaped}"', shell=True)
        elif IS_MACOS:
            subprocess.run(["open", file_path], check=True)
        else:  # Linux
            try:
                subprocess.run(["xdg-open", file_path], check=True)
            except Exception:
                editor = os.environ.get("EDITOR", "nano")
                subprocess.run([editor, file_path])
    except Exception as e:
        raise OSError(f"Failed to open editor: {e}")


def process_file_attachments(user_input, tools_instance):
    """Finds all @filename references, reads valid workspace files, and appends context."""
    matches = re.findall(r"@([a-zA-Z0-9_\-\.\/]+)", user_input)
    if not matches:
        return user_input
    
    unique_matches = list(dict.fromkeys(matches))
    appended_context = ""
    for filename in unique_matches:
        try:
            safe_path = tools_instance._resolve_safe_path(filename)
            if os.path.isfile(safe_path):
                with open(safe_path, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
                appended_context += f"\n\n=== ATTACHED FILE CONTENT: {filename} ===\n{content}\n================================="
        except Exception:
            pass
            
    if appended_context:
        return user_input + "\n" + appended_context
    return user_input


# --------------------------------------------------------------------------
# Stream Printing Filter
# --------------------------------------------------------------------------

class StreamFilter:
    """
    State machine that processes a raw chunk stream and filters out <tool_call> XML
    blocks so they are not printed directly to terminal, while keeping normal dialogue.
    """
    def __init__(self, callback):
        self.callback = callback
        self.buffer = ""
        self.in_tool_call = False

    def feed(self, chunk):
        for char in chunk:
            self.buffer += char
            
            if not self.in_tool_call:
                if self.buffer.startswith("<"):
                    target = "<tool_call"
                    if len(self.buffer) <= len(target):
                        if target.startswith(self.buffer):
                            continue
                        else:
                            self.callback(self.buffer)
                            self.buffer = ""
                    else:
                        if self.buffer.startswith("<tool_call"):
                            self.in_tool_call = True
                            continue
                        else:
                            self.callback(self.buffer)
                            self.buffer = ""
                else:
                    self.callback(self.buffer)
                    self.buffer = ""
            else:
                end_tag = "</tool_call>"
                if self.buffer.endswith(end_tag):
                    self.buffer = ""
                    self.in_tool_call = False
                    self.callback("\n\n[NXClaw Intercepted Tool Call...]\n")
                else:
                    continue

    def flush(self):
        if self.buffer and not self.in_tool_call:
            self.callback(self.buffer)
            self.buffer = ""


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

class NXClawConfig:
    def __init__(self, workspace=None):
        self.workspace = workspace or os.getcwd()
        self.path = os.path.join(self.workspace, CONFIG_FILENAME)
        self.data = {}
        self.load_error = None

    def exists(self):
        return os.path.isfile(self.path)

    def load(self):
        self.load_error = None
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                raw = f.read()
        except OSError as e:
            self.data = {}
            self.load_error = f"Could not read config file: {e}"
            return False

        try:
            parsed = json.loads(raw)
            if not isinstance(parsed, dict):
                raise ValueError("Config content is not a valid JSON object.")
            self.data = parsed
            return True
        except (json.JSONDecodeError, ValueError) as e:
            self.load_error = f"Config file corrupted: {e}"
            try:
                backup_path = self.path + ".bak"
                shutil.copy2(self.path, backup_path)
            except OSError:
                pass
            self.data = {}
            return False

    def save(self):
        try:
            os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
            tmp_path = self.path + ".tmp"
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(self.data, f, indent=2, ensure_ascii=False)
            os.replace(tmp_path, self.path)
            return True
        except OSError as e:
            print(f"[!] Saving config failed: {e}")
            return False

    def set_workspace(self, workspace):
        self.workspace = workspace
        self.path = os.path.join(self.workspace, CONFIG_FILENAME)

    @property
    def provider(self):
        return self.data.get("provider", "ollama")

    @property
    def endpoint(self):
        return self.data.get("endpoint", DEFAULT_ENDPOINTS["ollama"])

    @property
    def api_key(self):
        return self.data.get("api_key", "")

    @property
    def model(self):
        return self.data.get("model", "")

    @model.setter
    def model(self, value):
        self.data["model"] = value

    @property
    def auto_confirm(self):
        return bool(self.data.get("auto_confirm", False))

    @auto_confirm.setter
    def auto_confirm(self, value):
        self.data["auto_confirm"] = bool(value)

    @property
    def tutorial_completed(self):
        return bool(self.data.get("tutorial_completed", False))

    @tutorial_completed.setter
    def tutorial_completed(self, value):
        self.data["tutorial_completed"] = bool(value)


# --------------------------------------------------------------------------
# UI: colors, ASCII art, spinners, boxes
# --------------------------------------------------------------------------

class NXClawUI:
    _ansi_ready = False
    _color_enabled = True

    RESET = "\033[0m"
    BOLD = "\033[1m"
    DIM = "\033[2m"

    GREEN = "\033[38;5;46m"
    BRIGHT_GREEN = "\033[38;5;82m"
    CYAN = "\033[38;5;51m"
    BRIGHT_CYAN = "\033[38;5;87m"
    RED = "\033[38;5;196m"
    YELLOW = "\033[38;5;220m"
    GRAY = "\033[38;5;240m"
    WHITE = "\033[38;5;231m"
    MAGENTA = "\033[38;5;201m"

    BANNER = r"""
 _   _ __  _______ _
| | | |\ \/ /  ___| |
| |_| \  /| |   | |    ____  __ ___      __
|  _  | \/ | |   | |   / __ \\ \ /\ / /
| | | /  \| |___| |__| (__) |\ V  V /
|_| |_/_/\_\____/|_____\____/  \_/\_/

"""

    @classmethod
    def enable_ansi(cls):
        if cls._ansi_ready:
            return
        cls._ansi_ready = True

        try:
            if not sys.stdout.isatty():
                cls._color_enabled = False
                return
        except (AttributeError, ValueError):
            cls._color_enabled = False
            return

        if IS_WINDOWS:
            try:
                import ctypes
                kernel32 = ctypes.windll.kernel32
                handle = kernel32.GetStdHandle(-11)
                if handle == 0 or handle == -1:
                    cls._color_enabled = False
                    return
                mode = ctypes.c_uint32()
                if not kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
                    cls._color_enabled = False
                    return
                ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
                new_mode = mode.value | ENABLE_VIRTUAL_TERMINAL_PROCESSING
                if not kernel32.SetConsoleMode(handle, new_mode):
                    cls._color_enabled = False
                    return
                cls._color_enabled = True
            except Exception:
                cls._color_enabled = False
        else:
            cls._color_enabled = True

    @classmethod
    def clear(cls):
        if cls._color_enabled:
            sys.stdout.write("\033[H\033[2J\033[3J")
            sys.stdout.flush()
        else:
            try:
                os.system("cls" if IS_WINDOWS else "clear")
            except Exception:
                print("\n" * 50)

    @classmethod
    def c(cls, text, color):
        if not cls._color_enabled:
            return text
        return f"{color}{text}{cls.RESET}"

    @classmethod
    def banner(cls):
        cls.clear()
        print(cls.c(cls.BANNER, cls.BRIGHT_GREEN))
        sub = "  >> Autonomous Terminal Agent <<"
        print(cls.c(sub, cls.CYAN))
        print(cls.c(f"  v{VERSION}  |  stdlib-only  |  {platform.system()}", cls.GRAY))
        print()

    @classmethod
    def boot_sequence(cls):
        steps = [
            "Initializing NXClaw Core...",
            "Loading Neural Link...",
            "Calibrating ANSI render pipeline...",
            "Detecting local environment... OK",
            "Mounting workspace sandbox...",
            "Spinning up REPL kernel...",
        ]
        for step in steps:
            sys.stdout.write(cls.c("  [boot] ", cls.GREEN) + cls.c(step, cls.GRAY) + "\n")
            sys.stdout.flush()
            time.sleep(0.5 / len(steps) * 1.6)
        print()

    @staticmethod
    def _display_width(text):
        import unicodedata
        width = 0
        for ch in text:
            if unicodedata.east_asian_width(ch) in ("W", "F"):
                width += 2
            else:
                width += 1
        return width

    @classmethod
    def _wrap_by_width(cls, text, max_width):
        if cls._display_width(text) <= max_width:
            return [text]
        lines = []
        current = ""
        current_width = 0
        for ch in text:
            ch_width = 2 if __import__("unicodedata").east_asian_width(ch) in ("W", "F") else 1
            if current_width + ch_width > max_width:
                lines.append(current)
                current = ch
                current_width = ch_width
            else:
                current += ch
                current_width += ch_width
        if current:
            lines.append(current)
        return lines

    @classmethod
    def hr(cls, char="─", width=None, color=None):
        width = width or shutil.get_terminal_size((80, 20)).columns
        color = color or cls.GRAY
        print(cls.c(char * width, color))

    @classmethod
    def box(cls, title, body, color=None, width=None):
        color = color or cls.CYAN
        term_width = shutil.get_terminal_size((80, 20)).columns
        width = width or min(term_width - 2, 100)
        inner_width = width - 4

        lines = []
        for raw_line in body.split("\n"):
            if raw_line == "":
                lines.append("")
                continue
            lines.extend(cls._wrap_by_width(raw_line, inner_width))

        title_width = cls._display_width(title)
        top = "╭─ " + title + " " + "─" * max(0, width - title_width - 4) + "╮"
        bottom = "╰" + "─" * (width - 2) + "╯"

        print(cls.c(top, color))
        for line in lines:
            pad = inner_width - cls._display_width(line)
            print(cls.c("│ ", color) + line + (" " * max(0, pad)) + cls.c(" │", color))
        print(cls.c(bottom, color))

    @classmethod
    def error_box(cls, title, body):
        cls.box(title, body, color=cls.RED)

    @classmethod
    def success_box(cls, title, body):
        cls.box(title, body, color=cls.BRIGHT_GREEN)

    @classmethod
    def info_box(cls, title, body):
        cls.box(title, body, color=cls.CYAN)


class Spinner:
    FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

    def __init__(self, message="Thinking", color=None):
        self.message = message
        self.color = color or NXClawUI.CYAN
        self._stop_event = threading.Event()
        self._thread = None

    def _spin(self):
        for frame in itertools.cycle(self.FRAMES):
            if self._stop_event.is_set():
                break
            sys.stdout.write(
                NXClawUI.c(f"{frame} {self.message}...", self.color) + "   "
                if NXClawUI._color_enabled
                else f"{frame} {self.message}...   "
            )
            sys.stdout.write("\r")
            sys.stdout.flush()
            time.sleep(0.08)
        sys.stdout.write("\r" + " " * (len(self.message) + 14) + "\r")
        sys.stdout.flush()

    def __enter__(self):
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._spin, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=1)


class TaskCancelled(Exception):
    pass


class InterruptibleCall:
    def __init__(self, func, *args, **kwargs):
        self.func = func
        self.args = args
        self.kwargs = kwargs
        self._done = threading.Event()
        self._result = None
        self._exception = None

    def _runner(self):
        try:
            self._result = self.func(*self.args, **self.kwargs)
        except Exception as e:
            self._exception = e
        finally:
            self._done.set()

    def run(self, poll_interval=0.1):
        thread = threading.Thread(target=self._runner, daemon=True)
        thread.start()
        try:
            while not self._done.wait(timeout=poll_interval):
                pass
        except KeyboardInterrupt:
            raise TaskCancelled("Cancelled by the user via Ctrl+C.")

        if self._exception is not None:
            raise self._exception
        return self._result


# --------------------------------------------------------------------------
# Tools
# --------------------------------------------------------------------------

class ToolError(Exception):
    pass


class NXClawTools:
    MAX_OUTPUT_CHARS = 8000
    BROWSE_MAX_CHARS = 3000
    COMMAND_TIMEOUT_SECS = 120
    PYTHON_TIMEOUT_SECS = 60

    def __init__(self, workspace_root):
        self.workspace_root = os.path.realpath(os.path.abspath(workspace_root))

    def _resolve_safe_path(self, user_path):
        if user_path is None:
            raise ToolError("No path provided.")

        # Strip target @ indicators from physical paths safely
        if user_path.startswith('@'):
            user_path = user_path[1:]

        candidate = user_path if os.path.isabs(user_path) else os.path.join(
            self.workspace_root, user_path
        )
        resolved = os.path.realpath(candidate)

        root_with_sep = self.workspace_root + os.sep
        if resolved != self.workspace_root and not resolved.startswith(root_with_sep):
            raise ToolError(
                f"Path '{user_path}' resolves outside the workspace root "
                f"({self.workspace_root}). Refusing to operate outside the sandbox."
            )
        return resolved

    @staticmethod
    def _truncate(text, limit):
        if text is None:
            return ""
        if len(text) > limit:
            return text[:limit] + f"\n... [truncated, {len(text) - limit} more characters]"
        return text

    @staticmethod
    def is_dangerous_command(command):
        for pattern in DANGEROUS_PATTERNS:
            if re.search(pattern, command, re.IGNORECASE):
                return True
        return False

    def run_command(self, command):
        if not command or not command.strip():
            raise ToolError("Empty command.")
        try:
            proc = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                cwd=self.workspace_root,
                timeout=self.COMMAND_TIMEOUT_SECS,
            )
            out = self._truncate(proc.stdout, self.MAX_OUTPUT_CHARS)
            err = self._truncate(proc.stderr, self.MAX_OUTPUT_CHARS)
            result = f"[exit code: {proc.returncode}]\n"
            if out:
                result += f"--- stdout ---\n{out}\n"
            if err:
                result += f"--- stderr ---\n{err}\n"
            if not out and not err:
                result += "(no output)\n"
            return result
        except subprocess.TimeoutExpired:
            return f"[error] Command timed out after {self.COMMAND_TIMEOUT_SECS}s."
        except Exception as e:
            return f"[error] Failed to execute command: {e}"

    def write_file(self, path, content):
        try:
            safe_path = self._resolve_safe_path(path)
        except ToolError as e:
            return f"[error] {e}"
        try:
            os.makedirs(os.path.dirname(safe_path) or self.workspace_root, exist_ok=True)
            with open(safe_path, "w", encoding="utf-8", newline="") as f:
                f.write(content if content is not None else "")
            rel = os.path.relpath(safe_path, self.workspace_root)
            return f"[ok] Wrote {len(content or '')} characters to '{rel}'."
        except Exception as e:
            return f"[error] Failed to write file: {e}"

    def read_file(self, path):
        try:
            safe_path = self._resolve_safe_path(path)
        except ToolError as e:
            return f"[error] {e}"
        try:
            if not os.path.isfile(safe_path):
                return f"[error] File not found: '{path}'."
            with open(safe_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            return self._truncate(content, self.MAX_OUTPUT_CHARS)
        except Exception as e:
            return f"[error] Failed to read file: {e}"

    def patch_file(self, path, search_block, replace_block):
        try:
            safe_path = self._resolve_safe_path(path)
        except ToolError as e:
            return f"[error] {e}"
        try:
            if not os.path.isfile(safe_path):
                return f"[error] File not found: '{path}'."
            with open(safe_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()

            if search_block is None or search_block == "":
                return "[error] search_block cannot be empty."

            count = content.count(search_block)
            if count == 0:
                return (
                    "[error] search_block not found in file. No changes made. "
                    "Double-check whitespace/indentation match exactly."
                )
            if count > 1:
                return (
                    f"[error] search_block matched {count} locations; it must be "
                    "unique. Add more surrounding context and try again."
                )

            new_content = content.replace(search_block, replace_block or "", 1)
            with open(safe_path, "w", encoding="utf-8", newline="") as f:
                f.write(new_content)
            rel = os.path.relpath(safe_path, self.workspace_root)
            return f"[ok] Patched '{rel}' (1 replacement)."
        except Exception as e:
            return f"[error] Failed to patch file: {e}"

    def python_eval(self, code):
        if not code or not code.strip():
            return "[error] Empty code block."

        stdout_buf = io.StringIO()
        stderr_buf = io.StringIO()

        def target():
            try:
                with contextlib.redirect_stdout(stdout_buf), contextlib.redirect_stderr(stderr_buf):
                    exec_globals = {"__name__": "__nxclaw_eval__"}
                    exec(code, exec_globals)
            except Exception:
                stderr_buf.write(traceback.format_exc())

        thread = threading.Thread(target=target, daemon=True)
        thread.start()
        thread.join(timeout=self.PYTHON_TIMEOUT_SECS)

        if thread.is_alive():
            return f"[error] python_eval timed out after {self.PYTHON_TIMEOUT_SECS}s."

        out = self._truncate(stdout_buf.getvalue(), self.MAX_OUTPUT_CHARS)
        err = self._truncate(stderr_buf.getvalue(), self.MAX_OUTPUT_CHARS)

        result = ""
        if out:
            result += f"--- stdout ---\n{out}\n"
        if err:
            result += f"--- stderr/traceback ---\n{err}\n"
        if not out and not err:
            result = "(no output)"
        return result

    def browse_web(self, url):
        if not url or not re.match(r"^https?://", url.strip(), re.IGNORECASE):
            return "[error] Invalid URL. Must start with http:// or https://."
        try:
            req = urllib.request.Request(
                url,
                headers={
                    "User-Agent": (
                        "Mozilla/5.0 (compatible; NXClaw/1.3; "
                        "+stdlib-only-agent)"
                    )
                },
            )
            with urllib.request.urlopen(req, timeout=15) as resp:
                raw = resp.read()
                charset = resp.headers.get_content_charset() or "utf-8"
                html = raw.decode(charset, errors="replace")
        except urllib.error.HTTPError as e:
            return f"[error] HTTP error fetching '{url}': {e.code} {e.reason}"
        except urllib.error.URLError as e:
            return f"[error] Failed to fetch '{url}': {e.reason}"
        except Exception as e:
            return f"[error] Failed to fetch '{url}': {e}"

        text = self._html_to_text(html)
        return self._truncate(text, self.BROWSE_MAX_CHARS)

    @staticmethod
    def _html_to_text(html):
        html = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", html, flags=re.DOTALL | re.IGNORECASE)
        html = re.sub(r"<(br|/p|/div|/li|/h[1-6]|/tr)[^>]*>", "\n", html, flags=re.IGNORECASE)
        html = re.sub(r"<[^>]+>", " ", html)
        entities = {
            "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">",
            "&quot;": '"', "&#39;": "'", "&apos;": "'", "&mdash;": "-",
            "&ndash;": "-", "&rsquo;": "'", "&lsquo;": "'",
            "&ldquo;": '"', "&rdquo;": '"', "&hellip;": "...",
        }
        for ent, repl in entities.items():
            html = html.replace(ent, repl)
        html = re.sub(r"&#\d+;", " ", html)
        lines = [ln.strip() for ln in html.split("\n")]
        lines = [ln for ln in lines if ln]
        text = "\n".join(lines)
        text = re.sub(r"[ \t]{2,}", " ", text)
        return text.strip()


# --------------------------------------------------------------------------
# API Client with Streaming Support
# --------------------------------------------------------------------------

class APIError(Exception):
    pass


class NXClawAPIClient:
    def __init__(self, provider, endpoint, api_key, model, timeout=120):
        self.provider = provider
        self.endpoint = (endpoint or "").rstrip("/")
        self.api_key = api_key or ""
        self.model = model
        self.timeout = timeout

    def _get(self, url, headers=None):
        req = urllib.request.Request(url, headers=headers or {}, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read().decode("utf-8", errors="replace")
                return json.loads(body)
        except urllib.error.HTTPError as e:
            raise APIError(f"HTTP {e.code} from {url}")
        except urllib.error.URLError as e:
            raise APIError(f"Connection error reaching {url}: {e.reason}")
        except json.JSONDecodeError as e:
            raise APIError(f"Could not parse JSON response from {url}: {e}")

    def chat(self, system_prompt, messages, on_chunk_cb=None):
        if self.provider == "ollama":
            return self._chat_ollama(system_prompt, messages, on_chunk_cb)
        elif self.provider == "openai":
            return self._chat_openai(system_prompt, messages, on_chunk_cb)
        elif self.provider == "claude":
            return self._chat_claude(system_prompt, messages, on_chunk_cb)
        else:
            raise APIError(f"Unknown provider: {self.provider}")

    def _chat_ollama(self, system_prompt, messages, on_chunk_cb=None):
        url = f"{self.endpoint}/api/chat"
        full_messages = [{"role": "system", "content": system_prompt}] + messages
        payload = {
            "model": self.model,
            "messages": full_messages,
            "stream": True,
        }
        headers = {"Content-Type": "application/json"}
        full_text = []
        try:
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(url, data=data, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                for line_bytes in _iter_lines(resp):
                    line = line_bytes.decode("utf-8", errors="replace").strip()
                    if not line:
                        continue
                    try:
                        chunk = json.loads(line)
                        content = chunk.get("message", {}).get("content", "")
                        if content:
                            full_text.append(content)
                            if on_chunk_cb:
                                on_chunk_cb(content)
                    except Exception:
                        pass
            return "".join(full_text)
        except Exception:
            # Fallback to OpenAI completions schema exposed by Ollama
            url2 = f"{self.endpoint}/v1/chat/completions"
            payload2 = {
                "model": self.model,
                "messages": full_messages,
                "stream": True,
            }
            data2 = json.dumps(payload2).encode("utf-8")
            req2 = urllib.request.Request(url2, data=data2, headers=headers, method="POST")
            full_text = []
            with urllib.request.urlopen(req2, timeout=self.timeout) as resp:
                for line_bytes in _iter_lines(resp):
                    line = line_bytes.decode("utf-8", errors="replace").strip()
                    if not line:
                        continue
                    if line.startswith("data: "):
                        data_str = line[6:].strip()
                        if data_str == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data_str)
                            content = chunk.get("choices", [{}])[0].get("delta", {}).get("content", "")
                            if content:
                                full_text.append(content)
                                if on_chunk_cb:
                                    on_chunk_cb(content)
                        except Exception:
                            pass
            return "".join(full_text)

    def _chat_openai(self, system_prompt, messages, on_chunk_cb=None):
        url = f"{self.endpoint}/chat/completions"
        full_messages = [{"role": "system", "content": system_prompt}] + messages
        payload = {
            "model": self.model,
            "messages": full_messages,
            "stream": True,
        }
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        full_text = []
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            for line_bytes in _iter_lines(resp):
                line = line_bytes.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                if line.startswith("data: "):
                    data_str = line[6:].strip()
                    if data_str == "[DONE]":
                        break
                    try:
                        chunk = json.loads(data_str)
                        content = chunk.get("choices", [{}])[0].get("delta", {}).get("content", "")
                        if content:
                            full_text.append(content)
                            if on_chunk_cb:
                                on_chunk_cb(content)
                    except Exception:
                        pass
        return "".join(full_text)

    def _chat_claude(self, system_prompt, messages, on_chunk_cb=None):
        url = f"{self.endpoint}/messages"
        payload = {
            "model": self.model,
            "max_tokens": 4096,
            "system": system_prompt,
            "messages": messages,
            "stream": True,
        }
        headers = {
            "x-api-key": self.api_key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        }
        data = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers=headers, method="POST")
        full_text = []
        with urllib.request.urlopen(req, timeout=self.timeout) as resp:
            for line_bytes in _iter_lines(resp):
                line = line_bytes.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                if line.startswith("data: "):
                    data_str = line[6:].strip()
                    try:
                        chunk = json.loads(data_str)
                        event_type = chunk.get("type")
                        if event_type == "content_block_delta":
                            text = chunk.get("delta", {}).get("text", "")
                            if text:
                                full_text.append(text)
                                if on_chunk_cb:
                                    on_chunk_cb(text)
                    except Exception:
                        pass
        return "".join(full_text)

    def list_models(self):
        if self.provider == "ollama":
            try:
                data = self._get(f"{self.endpoint}/api/tags")
                models = data.get("models", [])
                names = [m.get("name") for m in models if m.get("name")]
                if names:
                    return names
            except APIError:
                pass
            data = self._get(f"{self.endpoint}/v1/models")
            items = data.get("data", [])
            return [m.get("id") for m in items if m.get("id")]

        elif self.provider == "openai":
            headers = {}
            if self.api_key:
                headers["Authorization"] = f"Bearer {self.api_key}"
            data = self._get(f"{self.endpoint}/models", headers=headers)
            items = data.get("data", [])
            names = [m.get("id") for m in items if m.get("id")]
            if not names:
                raise APIError("No models returned.")
            return names

        elif self.provider == "claude":
            return list(FALLBACK_CLAUDE_MODELS)

        else:
            raise APIError(f"Unknown provider: {self.provider}")


# --------------------------------------------------------------------------
# Agent: tool-call protocol, system prompt, ReAct loop
# --------------------------------------------------------------------------

TOOL_CALL_RE = re.compile(
    r"<tool_call\s+name=[\"']([a-zA-Z_]+)[\"']\s*>(.*?)</tool_call>",
    re.DOTALL,
)
PARAM_RE = re.compile(
    r"<([a-zA-Z_]+)>(.*?)</\1>",
    re.DOTALL,
)

TOOL_SPECS = {
    "run_command": ["command"],
    "write_file": ["path", "content"],
    "read_file": ["path"],
    "patch_file": ["path", "search_block", "replace_block"],
    "python_eval": ["code"],
    "browse_web": ["url"],
}

MAX_HISTORY_MESSAGES = 40
MAX_TOOL_ITERATIONS = 25


def build_system_prompt(workspace_root):
    return f"""You are NXClaw, an autonomous, highly proactive terminal coding agent operating inside a sandboxed workspace at: {workspace_root}

YOUR PRIMARY DIRECTIVE:
You must be heavily biased towards action. If a task can be accomplished or verified using a tool, you MUST use that tool immediately rather than writing long prose or explaining hypothetical scenarios. Your name is Claw — use your tools!

To make edits, create scripts, inspect structures, or run tests, issue tool calls immediately. Do not explain your code in conversational text; instead, write or patch the code directly into files using your tools and summarize what was accomplished in brief sentences.

THE "@" SYMBOL FILENAME RULE:
The "@" symbol is an indicator prefix used by users in conversational prompts to reference or mark files (e.g., "Review @main.py"). 
It is NOT part of the physical file path or filename. When you construct paths for your tools, you must always omit the leading "@" (e.g., use "main.py", not "@main.py").

To call a tool, output ONLY a tool_call XML block, exactly in this format (no markdown fences, no extra commentary mixed into the tag):

<tool_call name="TOOL_NAME">
    <param_name>value</param_name>
</tool_call>

You may include normal text before or after a tool call, but the tool_call block itself must be well-formed XML with no nested unescaped '<' or '>' inside parameter values.

Available tools:

1. run_command (run shell commands, test code, inspect environment)
   <tool_call name="run_command">
       <command>shell command here</command>
   </tool_call>

2. write_file (creates or overwrites a file; cannot escape the workspace root)
   <tool_call name="write_file">
       <path>relative/or/absolute/path.ext</path>
       <content>full file content here</content>
   </tool_call>

3. read_file (read file content to gain context)
   <tool_call name="read_file">
       <path>relative/or/absolute/path.ext</path>
   </tool_call>

4. patch_file (search_block must match EXACTLY ONCE in the file, including whitespace)
   <tool_call name="patch_file">
       <path>relative/or/absolute/path.ext</path>
       <search_block>exact text to find</search_block>
       <replace_block>replacement text</replace_block>
   </tool_call>

5. python_eval (runs Python in-process and returns stdout/stderr; use for quick computation)
   <tool_call name="python_eval">
       <code>print("hello")</code>
   </tool_call>

6. browse_web (fetches a URL and returns cleaned, readable text, up to 3000 chars)
   <tool_call name="browse_web">
       <url>https://example.com</url>
   </tool_call>

Rules:
- Issue ONE tool call at a time. Wait for the result before deciding the next step.
- When the task is fully complete, respond with a normal text summary and DO NOT include any tool_call block.
- All file paths are relative to the workspace root unless absolute; absolute paths outside the workspace will be rejected.
- Minimize conversational output. Let your tool actions speak for themselves.
- If a tool call fails, analyze the error and immediately try an alternative tool action to correct it. Do not give up or ask the user for permission to try another path — just try it.
"""


class ParsedToolCall:
    def __init__(self, name, params, raw_match):
        self.name = name
        self.params = params
        self.raw_match = raw_match


def parse_tool_call(llm_text):
    match = TOOL_CALL_RE.search(llm_text)
    if not match:
        return llm_text.strip(), None

    tool_name = match.group(1).strip()
    inner = match.group(2)
    text_before = llm_text[: match.start()].strip()

    params = {}
    for pmatch in PARAM_RE.finditer(inner):
        key, value = pmatch.group(1), pmatch.group(2)
        params[key] = _unescape_param(value)

    return text_before, ParsedToolCall(tool_name, params, match.group(0))


def _unescape_param(value):
    value = value.strip("\n")
    replacements = {
        "&lt;": "<", "&gt;": ">", "&amp;": "&",
        "&quot;": '"', "&apos;": "'",
    }
    for ent, repl in replacements.items():
        value = value.replace(ent, repl)
    return value


class NXClawAgent:
    def __init__(self, config: NXClawConfig, ui: NXClawUI):
        self.config = config
        self.ui = ui
        self.tools = NXClawTools(config.workspace)
        self.client = NXClawAPIClient(
            provider=config.provider,
            endpoint=config.endpoint,
            api_key=config.api_key,
            model=config.model,
        )
        self.history = []
        self.system_prompt = build_system_prompt(self.tools.workspace_root)

    def refresh_client(self):
        self.tools = NXClawTools(self.config.workspace)
        self.client = NXClawAPIClient(
            provider=self.config.provider,
            endpoint=self.config.endpoint,
            api_key=self.config.api_key,
            model=self.config.model,
        )
        self.system_prompt = build_system_prompt(self.tools.workspace_root)

    def clear_history(self):
        self.history = []

    def _trim_history(self):
        if len(self.history) > MAX_HISTORY_MESSAGES:
            overflow = len(self.history) - MAX_HISTORY_MESSAGES
            self.history = self.history[overflow:]

    def _ask_confirmation(self, tool_call: ParsedToolCall):
        ui = self.ui
        print()
        ui.box(
            f"TOOL REQUEST: {tool_call.name}",
            self._format_params_preview(tool_call),
            color=ui.YELLOW,
        )
        if tool_call.name == "run_command" and self.tools.is_dangerous_command(
            tool_call.params.get("command", "")
        ):
            ui.error_box(
                "DANGER WARNING",
                "This command matches a known catastrophic pattern "
                "(e.g., recursive deletion, disk wipe, or fork bomb).",
            )
        try:
            answer = input(
                ui.c("  Allow this action? [y/N]: ", ui.MAGENTA)
            ).strip().lower()
        except (EOFError, KeyboardInterrupt):
            return False
        return answer in ("y", "yes")

    @staticmethod
    def _format_params_preview(tool_call: ParsedToolCall):
        lines = []
        for key, value in tool_call.params.items():
            preview = value if len(value) <= 400 else value[:400] + " ... [truncated]"
            lines.append(f"{key}:\n{preview}")
        return "\n\n".join(lines) if lines else "(no parameters)"

    def _execute_tool(self, tool_call: ParsedToolCall):
        name = tool_call.name
        params = tool_call.params
        expected = TOOL_SPECS.get(name)

        if expected is None:
            return f"[error] Unknown tool '{name}'. Available: {', '.join(TOOL_SPECS)}."

        missing = [p for p in expected if p not in params]
        if missing:
            return f"[error] Tool '{name}' missing required parameter(s): {', '.join(missing)}."

        if name == "run_command" and self.config.auto_confirm:
            if self.tools.is_dangerous_command(params["command"]):
                return (
                    "[blocked] This command matches a known dangerous pattern "
                    "and was blocked even though auto-confirm is enabled. "
                    "Re-run manually if you are confident."
                )

        if not self.config.auto_confirm:
            allowed = self._ask_confirmation(tool_call)
            if not allowed:
                return "[denied] The user declined to execute this tool call."

        try:
            if name == "run_command":
                return self.tools.run_command(params["command"])
            elif name == "write_file":
                return self.tools.write_file(params["path"], params["content"])
            elif name == "read_file":
                return self.tools.read_file(params["path"])
            elif name == "patch_file":
                return self.tools.patch_file(
                    params["path"], params["search_block"], params["replace_block"]
                )
            elif name == "python_eval":
                return self.tools.python_eval(params["code"])
            elif name == "browse_web":
                return self.tools.browse_web(params["url"])
        except Exception as e:
            return f"[error] Tool '{name}' raised unexpected exception: {e}"

    def _print_api_error(self, error: "APIError"):
        ui = self.ui
        msg = str(error)
        hints = []

        if "Connection error" in msg or "Errno 111" in msg or "refused" in msg.lower():
            hints.append(
                "Could not connect to the API. Verify that:\n"
                f"  1) The Endpoint is correct (Current: {self.config.endpoint})\n"
                "  2) Your local provider (like Ollama) is actively running.\n"
                "  3) No firewall, VPN, or proxy is blocking the port."
            )
        elif "HTTP 401" in msg or "HTTP 403" in msg:
            hints.append(
                "Access was denied (401/403). Use /settings to check your API key."
            )
        elif "HTTP 404" in msg:
            hints.append(
                "Endpoint or Model not found (404). Check both endpoint and model name."
            )
        elif "HTTP 429" in msg:
            hints.append("Rate limit reached (429). Please wait before requesting again.")
        elif "HTTP 5" in msg:
            hints.append("Remote server error (5xx). This is likely temporary.")

        body = msg
        if hints:
            body += "\n\n" + "\n\n".join(hints)
        ui.error_box("API ERROR", body)

    def run_task(self, user_input):
        ui = self.ui
        self.history.append({"role": "user", "content": user_input})
        self._trim_history()

        for iteration in range(MAX_TOOL_ITERATIONS):
            try:
                print(ui.c(f"\n[NXClaw] Thinking (Iteration {iteration + 1}/{MAX_TOOL_ITERATIONS})", ui.BRIGHT_GREEN))
                
                # Active character filter that suppresses raw <tool_call> tags while streaming
                filter_stream = StreamFilter(lambda text: (sys.stdout.write(text), sys.stdout.flush()))

                def on_chunk(text):
                    filter_stream.feed(text)

                call = InterruptibleCall(self.client.chat, self.system_prompt, self.history, on_chunk_cb=on_chunk)
                reply = call.run()
                filter_stream.flush()
                print()  # Final newline after stream completes
            except TaskCancelled:
                ui.box(
                    "CANCELLED",
                    "Interrupted waiting for AI response.\n"
                    "Background connections have been abandoned.",
                    color=ui.YELLOW,
                )
                if self.history and self.history[-1]["role"] == "user":
                    self.history.pop()
                return
            except APIError as e:
                self._print_api_error(e)
                if self.history and self.history[-1]["role"] == "user":
                    self.history.pop()
                return
            except Exception as e:
                ui.error_box(
                    "UNEXPECTED ERROR",
                    f"{type(e).__name__}: {e}\n\n"
                    f"{traceback.format_exc(limit=3)}",
                )
                if self.history and self.history[-1]["role"] == "user":
                    self.history.pop()
                return

            text_before, tool_call = parse_tool_call(reply)

            if tool_call is None:
                self.history.append({"role": "assistant", "content": reply})
                self._trim_history()
                return

            self.history.append({"role": "assistant", "content": reply})

            try:
                result = self._execute_tool(tool_call)
            except KeyboardInterrupt:
                result = "[cancelled] Tool action terminated by user."
                ui.box("CANCELLED", "Tool execution aborted.", color=ui.YELLOW)

            self._print_tool_result(tool_call, result)

            tool_feedback = f"[tool_result name=\"{tool_call.name}\"]\n{result}\n[/tool_result]"
            self.history.append({"role": "user", "content": tool_feedback})
            self._trim_history()
        else:
            ui.error_box(
                "ITERATION LIMIT EXCEEDED",
                f"Aborted after {MAX_TOOL_ITERATIONS} recursive loops to avoid runaway charges."
            )

    def _print_tool_result(self, tool_call, result):
        ui = self.ui
        is_error = isinstance(result, str) and (
            result.startswith("[error]") or result.startswith("[blocked]")
        )
        color = ui.RED if is_error else ui.BRIGHT_CYAN
        title = f"RESULT: {tool_call.name}"
        ui.box(title, result if result else "(empty)", color=color)


# --------------------------------------------------------------------------
# Setup / settings menus
# --------------------------------------------------------------------------

PROVIDER_NAMES = {"1": "ollama", "2": "openai", "3": "claude"}
PROVIDER_LABELS = {
    "ollama": "Ollama (Local)",
    "openai": "OpenAI-compatible API",
    "claude": "Claude-compatible API (Anthropic Native)",
}


def prompt_choice(prompt_text_, valid, ui, default=None):
    while True:
        suffix = f" [{default}]" if default else ""
        try:
            raw = input(ui.c(f"{prompt_text_}{suffix}: ", ui.CYAN)).strip()
        except EOFError:
            print()
            sys.exit(1)
        except KeyboardInterrupt:
            print()
            sys.exit(0)
        if not raw and default is not None:
            return default
        if raw in valid:
            return raw
        print(ui.c(f"  [!] Invalid entry. Options: {', '.join(valid)}", ui.YELLOW))


def prompt_text(prompt_text_, default=None, ui=NXClawUI, allow_empty=False):
    suffix = f" [{default}]" if default else ""
    while True:
        try:
            raw = input(ui.c(f"{prompt_text_}{suffix}: ", ui.CYAN)).strip()
        except EOFError:
            print()
            sys.exit(1)
        except KeyboardInterrupt:
            print()
            sys.exit(0)

        if raw:
            return raw
        if default is not None:
            return default
        if allow_empty:
            return ""
        print(ui.c("  [!] Field cannot be empty.", ui.YELLOW))


def prompt_secret(prompt_text_, ui=NXClawUI):
    import warnings
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", category=getpass.GetPassWarning)
            return getpass.getpass(ui.c(f"{prompt_text_}: ", ui.CYAN)).strip()
    except EOFError:
        print()
        sys.exit(1)
    except KeyboardInterrupt:
        print()
        sys.exit(0)
    except Exception:
        print(ui.c("  [!] Command line masking failed. API key will display visibly.", ui.YELLOW))
        try:
            return input(ui.c(f"{prompt_text_}: ", ui.CYAN)).strip()
        except (EOFError, KeyboardInterrupt):
            print()
            sys.exit(0)


def _validate_workspace_path(raw_path, ui):
    try:
        abs_path = os.path.abspath(os.path.expanduser(raw_path))
    except Exception as e:
        return False, f"Could not parse path format: {e}"

    try:
        os.makedirs(abs_path, exist_ok=True)
    except OSError as e:
        return False, f"Could not create folder '{abs_path}': {e}"

    if not os.path.isdir(abs_path):
        return False, f"'{abs_path}' is not a directory."

    test_file = os.path.join(abs_path, ".nxclaw_write_test.tmp")
    try:
        with open(test_file, "w") as f:
            f.write("ok")
        os.remove(test_file)
    except OSError as e:
        return False, f"Directory lacks write permissions: {e}"

    return True, abs_path


def _maybe_warn_unrecommended_model(provider, model, ui):
    if not model:
        return
    if not is_recommended_model(provider, model):
        ui.box(
            "MODEL CAPABILITY NOTICE",
            f"The model '{model}' is not on NXClaw's list of recommended models.\n\n"
            f"{TOOL_MODEL_WARNING}\n\n"
            "If your model fails to emit XML block formatting, "
            "the agent loop may stall or repetitively loop.",
            color=ui.YELLOW,
        )


def run_setup_menu(config: NXClawConfig, ui: NXClawUI, is_reconfigure=False):
    ui.clear()
    ui.banner()
    title = "RECONFIGURE NXCLAW" if is_reconfigure else "INITIAL SETUP"
    ui.hr(color=ui.GREEN)
    print(ui.c(f"  {title}", ui.BOLD + ui.BRIGHT_GREEN))
    ui.hr(color=ui.GREEN)
    print()

    print(ui.c("  Select your AI Backend provider:", ui.WHITE))
    print(ui.c("    1) Ollama (Local open-source models)", ui.CYAN))
    print(ui.c("    2) OpenAI-compatible API (DeepSeek, OpenRouter, etc.)", ui.CYAN))
    print(ui.c("    3) Claude-compatible API (Anthropic Official Endpoints)", ui.CYAN))
    print()
    choice = prompt_choice("  Backend Choice", ["1", "2", "3"], ui, default="1")
    provider = PROVIDER_NAMES[choice]
    config.data["provider"] = provider

    print()
    print(ui.c(f"  >> Setting up: {PROVIDER_LABELS[provider]}", ui.BRIGHT_CYAN))

    default_endpoint = DEFAULT_ENDPOINTS[provider]
    endpoint = prompt_text("  API Endpoint URL", default=default_endpoint, ui=ui)
    config.data["endpoint"] = endpoint.rstrip("/")

    if provider == "ollama":
        print(ui.c("  (Ollama rarely requires an API key; press Enter to skip)", ui.GRAY))
        api_key = prompt_text("  API Key (Optional)", default="", ui=ui, allow_empty=True)
    else:
        api_key = prompt_secret("  API Key (Masked Input)", ui=ui)
        if not api_key:
            print(ui.c("  [!] Warning: Missing API key. Authenticated backends may fail.", ui.YELLOW))
    config.data["api_key"] = api_key

    print()
    print(ui.c("  Choose model selection method:", ui.WHITE))
    print(ui.c("    1) Manually enter model identifier", ui.CYAN))
    print(ui.c("    2) Auto-discover active models from Endpoint", ui.CYAN))
    model_choice = prompt_choice("  Selection method", ["1", "2"], ui, default="2")

    model = None
    if model_choice == "2":
        model = fetch_model_interactively(provider, endpoint, api_key, ui)

    if not model:
        default_model_hint = {
            "ollama": "qwen2.5-coder:7b",
            "openai": "gpt-4o",
            "claude": "claude-3-5-sonnet-latest",
        }[provider]
        print()
        model = prompt_text("  Model ID name", default=default_model_hint, ui=ui)

    _maybe_warn_unrecommended_model(provider, model, ui)
    config.data["model"] = model

    print()
    workspace_default = config.workspace or os.getcwd()
    while True:
        workspace_raw = prompt_text("  Workspace Sandboxed Path", default=workspace_default, ui=ui)
        ok, result = _validate_workspace_path(workspace_raw, ui)
        if ok:
            workspace = result
            break
        ui.error_box("INVALID PATH", result)
    config.set_workspace(workspace)

    if "auto_confirm" not in config.data:
        config.data["auto_confirm"] = False

    config.save()

    print()
    ui.success_box(
        "CONFIGURATION COMPLETED",
        f"Backend:   {PROVIDER_LABELS[provider]}\n"
        f"Endpoint:  {config.endpoint}\n"
        f"Model:     {config.model}\n"
        f"Workspace: {config.workspace}\n"
        f"Config At: {config.path}",
    )
    time.sleep(0.4)


def fetch_model_interactively(provider, endpoint, api_key, ui):
    print(ui.c("  [*] Connecting to list remote models...", ui.GRAY))
    try:
        client = NXClawAPIClient(provider, endpoint, api_key, model="")
        with Spinner("Fetching active models", color=ui.CYAN):
            call = InterruptibleCall(client.list_models)
            models = call.run()
    except TaskCancelled:
        ui.box("CANCELLED", "Model fetching interrupted. Defaulting to manual naming.", color=ui.YELLOW)
        return None
    except APIError as e:
        ui.error_box(
            "DISCOVERY FAILED",
            f"{e}\n\n"
            "Double check Endpoint status and verification tokens."
        )
        return None
    except Exception as e:
        ui.error_box(
            "DISCOVERY FAILED",
            f"Error: {type(e).__name__}: {e}\n\nSwitching to manual selection."
        )
        return None

    if not models:
        ui.error_box("EMPTY RESPONSE", "No active models were returned. Defaulting to manual input.")
        return None

    print()
    print(ui.c(f"  Discovered {len(models)} model targets:", ui.BRIGHT_GREEN))
    for i, m in enumerate(models, 1):
        tag = ""
        if is_recommended_model(provider, m):
            tag = ui.c("  [Recommended: Strong tool support]", ui.BRIGHT_GREEN)
        print(ui.c(f"    {i}) {m}", ui.CYAN) + tag)
    print()

    valid = [str(i) for i in range(1, len(models) + 1)]
    choice = prompt_choice("  Enter index to select model (or Enter to bypass)", valid + [""], ui, default="")
    if choice == "" or choice not in valid:
        return None
    return models[int(choice) - 1]


def run_model_command(config: NXClawConfig, agent: NXClawAgent, ui: NXClawUI):
    print()
    print(ui.c("  Model Selection Target:", ui.WHITE))
    print(ui.c("    1) Manual entry", ui.CYAN))
    print(ui.c("    2) Endpoint auto-discovery", ui.CYAN))
    choice = prompt_choice("  Method", ["1", "2"], ui, default="2")

    model = None
    if choice == "2":
        model = fetch_model_interactively(config.provider, config.endpoint, config.api_key, ui)
    if not model:
        model = prompt_text("  Model Name", default=config.model, ui=ui)

    _maybe_warn_unrecommended_model(config.provider, model, ui)

    config.model = model
    config.save()
    agent.refresh_client()
    ui.success_box("MODEL TARGET UPDATED", f"Active Model: {config.model}")


# --------------------------------------------------------------------------
# Main REPL
# --------------------------------------------------------------------------

def print_status_bar(config: NXClawConfig, ui: NXClawUI):
    auto = "ON" if config.auto_confirm else "OFF"
    auto_color = ui.RED if config.auto_confirm else ui.GRAY
    line = (
        f"{ui.c('[NXClaw]', ui.BRIGHT_GREEN)} "
        f"{ui.c('[Model: ' + (config.model or 'None') + ']', ui.CYAN)} "
        f"{ui.c('[Sandbox: ' + config.workspace + ']', ui.GRAY)} "
        f"{ui.c('[AutoConfirm: ' + auto + ']', auto_color)}"
    )
    print(line)


def print_help(ui: NXClawUI):
    about = (
        "NXClaw is an autonomous terminal agent. You define tasks using standard\n"
        "natural language, and the system coordinates and runs tools to complete them.\n\n"
        "Core Capabilities:\n"
        "  • run_command   Execute shells & verification scripts\n"
        "  • write_file    Write or overwrite full files\n"
        "  • read_file     Inspect file contents\n"
        "  • patch_file    Perform fast, target-based file modifications\n"
        "  • python_eval   Evaluate local mathematical / algorithmic concepts\n"
        "  • browse_web    Crawl remote documentation pages in clean text\n\n"
        "Sandbox Rule:\n"
        "All file inputs, outputs, and updates remain constrained strictly inside your\n"
        "workspace directory. Symlink attacks or directory traversal escape routes are blocked."
    )
    ui.box("NXClaw System Overview", about, color=ui.BRIGHT_CYAN)

    commands = (
        "/settings       Re-configure backend properties (provider, endpoint, key, model)\n"
        "/model          Update active target model identifier on the fly\n"
        "/auto-confirm   Toggle sandbox auto-confirm mode (no command prompts)\n"
        "/clear          Clear prompt context and sliding conversation memory\n"
        "/course         View interactive step-by-step user course tutorial\n"
        "/open {file}    Open a workspace file directly in your system's default editor\n"
        "/ls             List files and directories inside the workspace\n"
        "/rm {file}      Remove a file or folder inside the workspace\n"
        "/help, /?       Show this reference details manual\n"
        "/exit, /quit    Terminate the agent shell workspace"
    )
    ui.info_box("REPL Operational Commands", commands)

    tips = (
        "• Reference local workspace files using @filename (e.g., 'Fix the logic in @main.py') to attach them.\n"
        "• Press Ctrl+C at any time to interrupt reasoning streams immediately.\n"
        "• Use /open to modify local files with your preferred text editor alongside the AI."
    )
    ui.box("Operational Shortcuts", tips, color=ui.GRAY)


def _tutorial_pause(ui, last_step=False):
    prompt = "Press Enter to continue (or type 'q' to bypass)" if not last_step else "Press Enter to finish"
    try:
        raw = input(ui.c(f"\n  {prompt}: ", ui.GRAY)).strip().lower()
    except (EOFError, KeyboardInterrupt):
        print()
        return False
    return raw not in ("q", "quit", "exit")


def run_tutorial(config: NXClawConfig, ui: NXClawUI):
    ui.clear()
    ui.banner()
    ui.hr(color=ui.GREEN)
    print(ui.c("  NXClaw User Interactive Course", ui.BOLD + ui.BRIGHT_GREEN))
    ui.hr(color=ui.GREEN)

    steps = [
        (
            "Step 1/6: What is NXClaw?",
            "NXClaw is an autonomous agent operating directly in your command line.\n\n"
            "Instead of writing files, copying scripts, and testing shells manually, "
            "you feed natural language instructions into the interface. NXClaw will "
            "determine steps, generate scripts, run tests, read results, and iterate "
            "autonomously inside your sandbox root directory.",
        ),
        (
            "Step 2/6: The ReAct Loop Pattern",
            "Whenever you submit a task, the system processes it in loops:\n\n"
            "  1) Sends task prompt + session history context to the model.\n"
            "  2) The model streams a response back — containing raw text or a tool request.\n"
            "  3) Tool call requested: NXClaw intercepts the call and formats a review box.\n"
            "  4) Sandbox Action: On your approval, the tool executes inside the sandbox.\n"
            "  5) Feedback: The execution outcome returns to the model for the next step.\n"
            "  6) This iteration loops until the task is successfully accomplished.",
        ),
        (
            "Step 3/6: Native Toolbox",
            "The AI can pro-actively access these operational tools:\n\n"
            "  • run_command   Runs standard system shell inputs and verifications.\n"
            "  • write_file    Writes full files directly to your workspace.\n"
            "  • read_file     Reads local targets for immediate analysis.\n"
            "  • patch_file    Locates specific matches to replace with clean code.\n"
            "  • python_eval   Executes safe runtime code and captures standard outputs.\n"
            "  • browse_web    Reads online articles and collapses HTML into text.",
        ),
        (
            "Step 4/6: Safety & Sandboxing",
            "Since the agent has direct command execution abilities, safety features include:\n\n"
            "  • Workspace Sandbox: Path traversal attacks are captured and denied.\n"
            "  • Prompt Reviews: Every system change prompts a [y/N] verification box.\n"
            "  • Blocklist Guards: Fork bombs, raw disk writes, and host deletes are blocked.\n\n"
            "Tip: Run /auto-confirm to allow the agent to iterate on files and scripts "
            "unattended, but use extreme caution with system level tasks.",
        ),
        (
            "Step 5/6: Model Compatibility Requirements",
            "NXClaw requests tool executions via structured XML tags.\n"
            "This structural parsing relies on excellent 'Instruction Following' features.\n\n"
            "We highly recommend targeting advanced developer models (such as Qwen 3,\n"
            "Claude Fable 5, or GPT-5.5) to keep the interaction running smoothly. If the agent\n"
            "loops redundantly, use /model to switch to a recommended option.",
        ),
        (
            "Step 6/6: Operational Commands Reference",
            "Type / preceding commands to operate settings:\n\n"
            "  /settings       Re-run configuration parameters properties\n"
            "  /model          Change target model identifier manually or via auto-discovery\n"
            "  /auto-confirm   Toggle execution confirmation alerts\n"
            "  /clear          Purge sliding session history memory\n"
            "  /course         Re-run this interactive instructional course\n"
            "  /open {file}    Open a local workspace file with your OS's default editor\n"
            "  /ls             List files and directories inside the active workspace\n"
            "  /rm {file}      Remove a file or folder inside the workspace safely\n"
            "  /help           Show full functional manual specifications\n"
            "  /exit           Terminate safe session",
        ),
    ]

    for i, (title, body) in enumerate(steps):
        print()
        ui.box(title, body, color=ui.CYAN)
        is_last = (i == len(steps) - 1)
        if not _tutorial_pause(ui, last_step=is_last):
            print(ui.c("\n  Course bypassed. Type /course to view anytime.\n", ui.GRAY))
            return

    print(ui.c("\n  You can run /course at any time to re-read this material.\n", ui.GRAY))


def handle_slash_command(cmd, config: NXClawConfig, agent: NXClawAgent, ui: NXClawUI):
    cmd_strip = cmd.strip()
    cmd_lower = cmd_strip.lower()

    if cmd_lower in ("/exit", "/quit"):
        print(ui.c("\n  [NXClaw] Session terminated. Goodbye.\n", ui.GREEN))
        return False

    elif cmd_lower == "/settings":
        run_setup_menu(config, ui, is_reconfigure=True)
        agent.refresh_client()

    elif cmd_lower == "/model":
        run_model_command(config, agent, ui)

    elif cmd_lower == "/auto-confirm":
        config.auto_confirm = not config.auto_confirm
        config.save()
        state = "ENABLED" if config.auto_confirm else "DISABLED"
        color = ui.RED if config.auto_confirm else ui.GREEN
        if config.auto_confirm:
            ui.box(
                "AUTO-CONFIRM ENABLED",
                "NXClaw will now execute commands and edit files without prompting.\n"
                "Destructive command safety checks remain active, but you must "
                "carefully review instructions before sending them.",
                color=color,
            )
        else:
            ui.box("AUTO-CONFIRM DISABLED", "NXClaw will require validation before executing tool actions.", color=color)

    elif cmd_lower == "/clear":
        agent.clear_history()
        ui.success_box("HISTORY PURGED", "Session memory has been reset to empty context.")

    elif cmd_lower == "/course":
        run_tutorial(config, ui)

    elif cmd_lower == "/ls":
        try:
            files = os.listdir(agent.tools.workspace_root)
            if not files:
                ui.info_box("WORKSPACE", "Workspace directory is empty.")
            else:
                lines = []
                for f in sorted(files):
                    # Skip configuration metadata
                    if f == CONFIG_FILENAME:
                        continue
                    full_path = os.path.join(agent.tools.workspace_root, f)
                    if os.path.isdir(full_path):
                        lines.append(ui.c(f + "/", ui.CYAN + ui.BOLD))
                    else:
                        lines.append(ui.c(f, ui.GRAY))
                ui.box("WORKSPACE FILES", "\n".join(lines) if lines else "No public files found.")
        except Exception as e:
            ui.error_box("ERROR", f"Could not list directory: {e}")

    elif cmd_lower.startswith("/rm "):
        target_file = cmd_strip[4:].strip()
        if target_file.startswith('@'):
            target_file = target_file[1:]
        if not target_file:
            ui.error_box("ERROR", "Please specify a path. E.g., /rm script.py")
        else:
            try:
                safe_path = agent.tools._resolve_safe_path(target_file)
                if os.path.exists(safe_path):
                    if os.path.isdir(safe_path):
                        shutil.rmtree(safe_path)
                        ui.success_box("REMOVED", f"Folder '{target_file}' was successfully removed.")
                    else:
                        os.remove(safe_path)
                        ui.success_box("REMOVED", f"File '{target_file}' was successfully removed.")
                else:
                    ui.error_box("NOT FOUND", f"File '{target_file}' does not exist inside the workspace.")
            except Exception as e:
                ui.error_box("ERROR", f"Could not remove target: {e}")

    elif cmd_lower.startswith("/open "):
        file_to_open = cmd_strip[6:].strip()
        if file_to_open.startswith('@'):
            file_to_open = file_to_open[1:]
        if not file_to_open:
            ui.error_box("ERROR", "Provide a file path. E.g., /open main.py")
        else:
            try:
                safe_path = agent.tools._resolve_safe_path(file_to_open)
                if os.path.exists(safe_path):
                    ui.box("OPENING FILE", f"Opening {file_to_open} in the system default text editor...")
                    open_file_in_editor(safe_path)
                else:
                    ui.error_box("NOT FOUND", f"File '{file_to_open}' does not exist inside the workspace sandbox.")
            except Exception as e:
                ui.error_box("ERROR", f"Could not launch file editor: {e}")

    elif cmd_lower in ("/help", "/?"):
        print_help(ui)

    else:
        ui.error_box("UNKNOWN COMMAND", f"'{cmd_strip}' is not recognized. Type /help for available commands.")

    return True


def main():
    NXClawUI.enable_ansi()
    ui = NXClawUI

    ui.banner()
    ui.boot_sequence()

    workspace_guess = os.getcwd()
    config = NXClawConfig(workspace=workspace_guess)

    if config.exists():
        config.load()
        if not config.data.get("workspace"):
            config.data["workspace"] = workspace_guess
        config.set_workspace(config.data.get("workspace", workspace_guess))
        if config.exists():
            config.load()
        ui.success_box(
            "CONFIGURATION RETRIEVED",
            f"Provider:  {PROVIDER_LABELS.get(config.provider, config.provider)}\n"
            f"Model:     {config.model}\n"
            f"Workspace: {config.workspace}",
        )
    else:
        config.data["workspace"] = workspace_guess
        run_setup_menu(config, ui, is_reconfigure=False)
        config.data["workspace"] = config.workspace
        config.save()

    agent = NXClawAgent(config, ui)

    print()
    ui.hr(color=ui.GREEN)
    print(ui.c("  Enter your request, or type /help for commands. Use Ctrl+C to stop streams.", ui.GRAY))
    ui.hr(color=ui.GREEN)
    print()

    def sigint_handler(signum, frame):
        print(ui.c("\n\n  [!] Interrupted. Type /exit to close, or continue inputting.\n", ui.YELLOW))

    signal.signal(signal.SIGINT, sigint_handler)

    while True:
        print()
        print_status_bar(config, ui)
        try:
            user_input = input(ui.c("> ", ui.BRIGHT_GREEN + ui.BOLD)).strip()
        except (EOFError, KeyboardInterrupt):
            print(ui.c("\n  [NXClaw] Session terminated. Goodbye.\n", ui.GREEN))
            break

        if not user_input:
            continue

        if user_input.startswith("/"):
            should_continue = handle_slash_command(user_input, config, agent, ui)
            if not should_continue:
                break
            continue

        # Process and parse @file notations on the user input
        processed_input = process_file_attachments(user_input, agent.tools)

        try:
            agent.run_task(processed_input)
        except KeyboardInterrupt:
            print(ui.c("\n  [!] Instruction processing cancelled by user.\n", ui.YELLOW))
        except Exception as e:
            ui.error_box("AGENT TERMINATION EXCEPTION", f"{e}\n{traceback.format_exc(limit=3)}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n  [NXClaw] Session terminated. Goodbye.\n")
        sys.exit(0)