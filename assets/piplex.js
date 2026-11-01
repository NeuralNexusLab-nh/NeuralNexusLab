export const MAX_BYTES = 500;
export const LANGUAGES = [
  ["en", "English"], ["zh-TW", "繁體中文"], ["zh-CN", "简体中文"],
  ["ja", "日本語"], ["ko", "한국어"], ["es", "Español"], ["fr", "Français"],
  ["de", "Deutsch"], ["it", "Italiano"], ["pt", "Português"], ["nl", "Nederlands"],
  ["ru", "Русский"], ["ar", "العربية"], ["tr", "Türkçe"], ["pl", "Polski"],
  ["cs", "Čeština"], ["da", "Dansk"], ["el", "Ελληνικά"], ["he", "עברית"],
  ["hi", "हिन्दी"], ["id", "Bahasa Indonesia"], ["ms", "Bahasa Melayu"],
  ["no", "Norsk"], ["sv", "Svenska"], ["fi", "Suomi"], ["hu", "Magyar"],
  ["sk", "Slovenčina"], ["sl", "Slovenščina"], ["ro", "Română"],
  ["bg", "Български"], ["uk", "Українська"], ["th", "ไทย"], ["vi", "Tiếng Việt"]
];

export function utf8Length(text) {
  return new TextEncoder().encode(text).length;
}

export class TranslationError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function decodeEntities(text) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, key) => {
    if (key[0] !== "#") return named[key.toLowerCase()] ?? entity;
    const value = key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
      ? String.fromCodePoint(value) : entity;
  });
}

export async function translateSegment(text, source, target, { signal, fetchImpl = globalThis.fetch } = {}) {
  if (!text.trim()) return "";
  if (utf8Length(text) > MAX_BYTES) throw new TranslationError("limit");
  const supported = new Set(LANGUAGES.map(([code]) => code));
  if (!supported.has(source) || !supported.has(target)) throw new TranslationError("language");
  if (source === target) return text;
  const url = new URL("https://api.mymemory.translated.net/get");
  url.search = new URLSearchParams({ q: text, langpair: `${source}|${target}` }).toString();
  const response = await fetchImpl(url.toString(), {
    signal, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", headers: { Accept: "application/json" }
  });
  if (response.status === 429) throw new TranslationError("quota");
  if (!response.ok) throw new TranslationError("unavailable");
  let data;
  try { data = await response.json(); } catch { throw new TranslationError("unavailable"); }
  if (data?.quotaFinished || Number(data?.responseStatus) === 429) {
    throw new TranslationError("quota");
  }
  if (Number(data?.responseStatus) !== 200 || typeof data?.responseData?.translatedText !== "string" || !data.responseData.translatedText.trim()) {
    throw new TranslationError("unavailable");
  }
  return decodeEntities(data.responseData.translatedText);
}

export function initPiPlex(doc = document) {
  const byId = id => doc.getElementById(id);
  const sides = ["left", "right"].map(name => ({
    name, text: byId(`${name}-text`), panel: byId(`${name}-panel`), counter: byId(`${name}-counter`),
    role: byId(`${name}-role`), hint: byId(`${name}-hint`), code: byId(`${name}-code`),
    copy: byId(`copy-${name}`), clear: byId(`clear-${name}`), feedback: byId(`${name}-copy-feedback`),
    language: byId(name === "left" ? "source-language" : "target-language"), copyTimer: null
  }));
  const button = byId("translate-button");
  const buttonLabel = byId("translate-label");
  const auto = byId("auto-translate");
  const status = byId("translation-state");
  const statusText = byId("status-text");
  let active = 0;
  let revision = 0;
  let debounce;
  let controller;
  let loading = false;
  let composing = false;
  let lastSuccess;

  for (const side of sides) {
    side.language.replaceChildren(...LANGUAGES.map(([code, name]) => {
      const option = doc.createElement("option");
      option.value = code; option.textContent = name;
      return option;
    }));
    side.language.value = side.name === "left" ? "en" : "zh-TW";
  }
  const setStatus = (message, state = "idle") => {
    statusText.textContent = message;
    status.dataset.state = state;
  };
  const languageName = side => LANGUAGES.find(([code]) => code === side.language.value)?.[1] || "";

  function render() {
    for (const [index, side] of sides.entries()) {
      const bytes = utf8Length(side.text.value);
      side.counter.textContent = `${Array.from(side.text.value).length} 字元 · ${bytes} / ${MAX_BYTES} bytes`;
      side.counter.dataset.over = String(bytes > MAX_BYTES);
      side.copy.disabled = !side.text.value;
      side.clear.disabled = !side.text.value;
      side.panel.dataset.role = index === active ? "source" : "translation";
      side.role.textContent = index === active ? "原文" : "譯文";
      side.hint.textContent = index === active ? "你的想法，從這裡開始" : "也可以在這一側輸入";
      side.code.textContent = side.language.value.toUpperCase();
      side.text.lang = side.language.value;
      side.text.setAttribute("aria-busy", String(loading && index !== active));
    }
    button.disabled = loading || !sides[active].text.value.trim() || utf8Length(sides[active].text.value) > MAX_BYTES;
    button.dataset.direction = active === 0 ? "forward" : "reverse";
    buttonLabel.textContent = loading ? "翻譯中" : active === 0 ? "翻譯文字" : "反向翻譯";
  }

  function cancel() {
    revision++;
    clearTimeout(debounce);
    controller?.abort();
    loading = false;
  }

  function edited(index) {
    cancel();
    active = index;
    lastSuccess = null;
    sides[index].panel.dataset.stale = "false";
    sides[1 - index].panel.dataset.stale = String(Boolean(sides[1 - index].text.value));
    render();
    if (utf8Length(sides[index].text.value) > MAX_BYTES) {
      setStatus("超過單次 500 bytes，請縮短文字後再試。", "error");
    } else if (!sides[index].text.value.trim()) {
      setStatus("準備好，讓文字跨越語言");
    } else {
      setStatus(`${languageName(sides[index])} → ${languageName(sides[1 - index])}`, "ready");
      if (auto.checked && !composing) debounce = setTimeout(run, 750);
    }
  }

  async function run() {
    cancel();
    const source = sides[active];
    const target = sides[1 - active];
    const text = source.text.value;
    if (!text.trim() || utf8Length(text) > MAX_BYTES) {
      setStatus(!text.trim() ? "請先在任一側輸入要翻譯的文字。" : "超過單次 500 bytes，請縮短文字後再試。", !text.trim() ? "idle" : "error");
      render(); return;
    }
    const key = [active, source.language.value, target.language.value, text].join("\u0000");
    if (lastSuccess?.key === key && target.text.value === lastSuccess.output) {
      setStatus("翻譯已完成，可複製或繼續編輯。", "done");
      render(); return;
    }
    const current = revision;
    controller = new AbortController();
    const currentController = controller;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; currentController.abort(); }, 15000);
    loading = true;
    setStatus(`${languageName(source)} → ${languageName(target)}，翻譯中…`, "loading");
    render();
    try {
      const output = await translateSegment(text, source.language.value, target.language.value, { signal: currentController.signal });
      if (current !== revision) return;
      target.text.value = output;
      target.panel.dataset.stale = "false";
      lastSuccess = { key, output };
      setStatus("翻譯已完成，可複製或繼續編輯。", "done");
    } catch (error) {
      if (current !== revision) return;
      const messages = {
        limit: "超過單次 500 bytes，請縮短文字後再試。",
        quota: "MyMemory 的翻譯額度暫時用完了，請稍後再試。",
        language: "請重新選擇支援的語言。"
      };
      setStatus(timedOut ? "連線逾時，請稍後重新翻譯。" : messages[error.code] || "暫時無法連線至翻譯服務，請再試一次。", "error");
    } finally {
      clearTimeout(timeout);
      if (current === revision) { loading = false; render(); }
    }
  }

  for (const [index, side] of sides.entries()) {
    side.text.addEventListener("compositionstart", () => { composing = true; cancel(); });
    side.text.addEventListener("compositionend", () => { composing = false; edited(index); });
    side.text.addEventListener("input", () => edited(index));
    side.text.addEventListener("keydown", event => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault(); active = index; run();
      }
    });
    side.language.addEventListener("change", () => edited(active));
    side.clear.addEventListener("click", () => {
      cancel();
      side.text.value = ""; side.panel.dataset.stale = "false";
      side.feedback.textContent = ""; clearTimeout(side.copyTimer);
      if (index === active) sides[1 - index].panel.dataset.stale = String(Boolean(sides[1 - index].text.value));
      lastSuccess = null;
      setStatus(`${index === 0 ? "左" : "右"}側文字已清空。`);
      render(); side.text.focus();
    });
    side.copy.addEventListener("click", async () => {
      const value = side.text.value;
      if (!value) return;
      let copied = false;
      try { await navigator.clipboard.writeText(value); copied = true; } catch {
        const focused = doc.activeElement;
        const start = side.text.selectionStart;
        const end = side.text.selectionEnd;
        side.text.focus(); side.text.select();
        try { copied = doc.execCommand("copy"); } catch { copied = false; }
        side.text.setSelectionRange(start, end);
        focused?.focus({ preventScroll: true });
      }
      side.feedback.textContent = copied ? "已複製" : "請選取文字後手動複製";
      clearTimeout(side.copyTimer);
      side.copyTimer = setTimeout(() => { side.feedback.textContent = ""; }, 1800);
    });
  }
  byId("swap-languages").addEventListener("click", () => {
    cancel();
    const [left, right] = sides;
    [left.language.value, right.language.value] = [right.language.value, left.language.value];
    [left.text.value, right.text.value] = [right.text.value, left.text.value];
    active = 0;
    lastSuccess = null;
    for (const side of sides) { side.panel.dataset.stale = "false"; side.feedback.textContent = ""; }
    setStatus("語言與文字已交換。", "ready");
    render();
  });
  auto.addEventListener("change", () => {
    clearTimeout(debounce);
    if (auto.checked) edited(active);
    else { cancel(); setStatus("即時翻譯已關閉，按下翻譯按鈕送出。"); render(); }
  });
  button.addEventListener("click", run);
  const examples = {
    greeting: "Hello! It is lovely to meet you. How has your day been?",
    travel: "A window seat, a good book, and somewhere new to discover.",
    work: "Great ideas start with a conversation. Let's build something meaningful together."
  };
  doc.querySelectorAll("[data-example]").forEach(example => example.addEventListener("click", () => {
    cancel();
    sides[0].language.value = "en";
    sides[1].language.value = "zh-TW";
    sides[0].text.value = examples[example.dataset.example];
    edited(0);
    sides[0].text.focus({ preventScroll: true });
    run();
  }));
  if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) byId("keyboard-hint").firstElementChild.textContent = "⌘";
  render();
}

if (typeof document !== "undefined" && document.getElementById("translator")) initPiPlex();
