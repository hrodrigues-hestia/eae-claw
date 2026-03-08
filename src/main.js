// Eae Claw - Main frontend logic
// Communicates with OpenClaw gateway via Tauri HTTP plugin (bypasses CORS)

const GATEWAY_URL = "http://localhost:18789";
const GATEWAY_TOKEN = localStorage.getItem("claw-token") || "";

// Dynamic import - works in Tauri, falls back to fetch for browser dev
let tauriFetch = null;
let tauriFs = null;
let tauriPath = null;
let tauriShortcut = null;
let tauriWindow = null;
let isMiniMode = false;
let savedBounds = null;
let unreadCount = 0;
async function loadTauriFetch() {
  try {
    const mod = await import("@tauri-apps/plugin-http");
    tauriFetch = mod.fetch;
    console.log("Using Tauri HTTP plugin (CORS-free)");
  } catch {
    tauriFetch = window.fetch.bind(window);
    console.log("Tauri HTTP plugin not available, using browser fetch");
  }
  try {
    tauriFs = await import("@tauri-apps/plugin-fs");
    const pathMod = await import("@tauri-apps/api/path");
    tauriPath = pathMod;
    console.log("Using Tauri FS plugin for persistent history");
  } catch {
    console.log("Tauri FS not available, using localStorage");
  }
  try {
    tauriShortcut = await import("@tauri-apps/plugin-global-shortcut");
    console.log("Global shortcut plugin loaded");
  } catch {
    console.log("Global shortcut not available");
  }
  try {
    const winMod = await import("@tauri-apps/api/window");
    tauriWindow = winMod.getCurrentWindow();
    console.log("Tauri window API loaded");
  } catch {
    console.log("Tauri window API not available");
  }
}

// --- State ---
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let recStartTime = null;
let recTimer = null;
let chatHistory = [];

// --- Persistent history via Tauri FS (survives app restarts) ---
const HISTORY_FILE = "chat-history.json";

async function loadHistory() {
  try {
    if (tauriFs && tauriPath) {
      const appDataDir = await tauriPath.appDataDir();
      const filePath = `${appDataDir}${HISTORY_FILE}`;
      const exists = await tauriFs.exists(filePath);
      if (exists) {
        const content = await tauriFs.readTextFile(filePath);
        chatHistory = JSON.parse(content);
        return;
      }
    }
  } catch (err) {
    console.warn("FS history load failed, trying localStorage:", err);
  }
  // Fallback to localStorage
  chatHistory = JSON.parse(localStorage.getItem("claw-chat-history") || "[]");
}

async function saveHistory() {
  try {
    if (tauriFs && tauriPath) {
      const appDataDir = await tauriPath.appDataDir();
      // Ensure directory exists
      const dirExists = await tauriFs.exists(appDataDir);
      if (!dirExists) {
        await tauriFs.mkdir(appDataDir, { recursive: true });
      }
      await tauriFs.writeTextFile(`${appDataDir}${HISTORY_FILE}`, JSON.stringify(chatHistory));
      return;
    }
  } catch (err) {
    console.warn("FS history save failed, using localStorage:", err);
  }
  // Fallback to localStorage
  localStorage.setItem("claw-chat-history", JSON.stringify(chatHistory));
}

// --- DOM ---
const messagesEl = document.getElementById("messages");
const textInput = document.getElementById("text-input");
const btnSend = document.getElementById("btn-send");
const btnMic = document.getElementById("btn-mic");
const recIndicator = document.getElementById("recording-indicator");
const recTimeEl = document.getElementById("rec-time");
const btnCancelRec = document.getElementById("btn-cancel-rec");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");

// --- Init ---
init();

async function init() {
  await loadTauriFetch();
  await loadHistory();

  // Check for saved token, prompt if missing
  if (!GATEWAY_TOKEN) {
    promptToken();
  } else {
    checkConnection();
  }

  // Event listeners
  btnSend.addEventListener("click", sendText);
  textInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendText();
    }
  });

  btnMic.addEventListener("click", toggleRecording);
  btnCancelRec.addEventListener("click", cancelRecording);

  // Global hotkey: Ctrl+Shift+C
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === "C") {
      e.preventDefault();
      toggleRecording();
    }
  });

  // Drag & drop files
  const chatContainer = document.getElementById("chat-container");
  chatContainer.addEventListener("dragover", (e) => {
    e.preventDefault();
    chatContainer.classList.add("drag-over");
  });
  chatContainer.addEventListener("dragleave", () => {
    chatContainer.classList.remove("drag-over");
  });
  chatContainer.addEventListener("drop", async (e) => {
    e.preventDefault();
    chatContainer.classList.remove("drag-over");
    await handleFileDrop(e.dataTransfer.files);
  });

  // File input (click to attach)
  const fileInput = document.getElementById("file-input");
  const btnAttach = document.getElementById("btn-attach");
  if (btnAttach && fileInput) {
    btnAttach.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", async (e) => {
      if (e.target.files.length > 0) {
        await handleFileDrop(e.target.files);
        fileInput.value = "";
      }
    });
  }

  // Welcome message or restore history
  if (chatHistory.length > 0) {
    restoreHistory();
  } else {
    addMessage("claw", "Eae! 🦀 Manda texto ou clica no microfone pra falar.\n\n**F19** — gravar/enviar áudio (global)\n**Ctrl+Shift+C** — gravar/enviar áudio", new Date());
  }

  // Register F19 global hotkey
  registerGlobalHotkey();

  // Mini mode button
  const btnMini = document.getElementById("btn-mini");
  if (btnMini) {
    btnMini.addEventListener("click", toggleMiniMode);
  }

  // Click header in mini mode to restore
  const header = document.getElementById("header");
  header.addEventListener("dblclick", () => {
    if (isMiniMode) toggleMiniMode();
  });

  // Ctrl+M for mini mode
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.key === "m") {
      e.preventDefault();
      toggleMiniMode();
    }
  });
}

// --- Mini mode ---
async function toggleMiniMode() {
  try {
    // Lazy load window API
    if (!tauriWindow) {
      try {
        const winMod = await import("@tauri-apps/api/window");
        tauriWindow = winMod.getCurrentWindow();
      } catch (err) {
        console.error("Cannot load window API:", err);
        return;
      }
    }

    const { LogicalSize, LogicalPosition } = await import("@tauri-apps/api/dpi");

    if (!isMiniMode) {
      // Save current size/position
      const factor = await tauriWindow.scaleFactor();
      const size = await tauriWindow.outerSize();
      const pos = await tauriWindow.outerPosition();
      savedBounds = {
        width: Math.round(size.width / factor),
        height: Math.round(size.height / factor),
        x: Math.round(pos.x / factor),
        y: Math.round(pos.y / factor),
      };

      // Switch to mini mode
      await tauriWindow.setAlwaysOnTop(true);
      await tauriWindow.setDecorations(false);
      await tauriWindow.setSize(new LogicalSize(320, 60));

      // Position at bottom-left, flush to edge (over Windows widget bar)
      try {
        const { currentMonitor } = await import("@tauri-apps/api/window");
        const monitor = await currentMonitor();
        if (monitor) {
          const factor = await tauriWindow.scaleFactor();
          const screenH = Math.round(monitor.size.height / factor);
          await tauriWindow.setPosition(new LogicalPosition(0, screenH - 60));
        }
      } catch (posErr) {
        console.warn("Could not position mini window:", posErr);
      }

      document.body.classList.add("mini-mode");
      isMiniMode = true;
      console.log("Switched to mini mode");
    } else {
      // Restore full mode
      await tauriWindow.setAlwaysOnTop(false);
      await tauriWindow.setDecorations(true);

      if (savedBounds) {
        await tauriWindow.setSize(new LogicalSize(savedBounds.width, savedBounds.height));
        await tauriWindow.setPosition(new LogicalPosition(savedBounds.x, savedBounds.y));
      }

      document.body.classList.remove("mini-mode");
      isMiniMode = false;
      unreadCount = 0;
      updateUnreadBadge();
      console.log("Restored full mode");
    }
  } catch (err) {
    console.error("Mini mode error:", err);
    alert("Mini mode error: " + (err?.message || err?.toString() || JSON.stringify(err)));
  }
}

function updateUnreadBadge() {
  const badge = document.getElementById("unread-badge");
  if (!badge) return;
  if (unreadCount > 0) {
    badge.textContent = unreadCount;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

async function registerGlobalHotkey() {
  if (!tauriShortcut) return;
  try {
    await tauriShortcut.register("F19", (event) => {
      if (event.state === "Pressed") {
        toggleRecording();
      }
    });
    console.log("F19 global hotkey registered (push-to-talk)");
  } catch (err) {
    console.warn("Failed to register F19:", err);
  }
  try {
    await tauriShortcut.register("F18", (event) => {
      if (event.state === "Pressed") {
        toggleMiniMode();
      }
    });
    console.log("F18 global hotkey registered (mini mode toggle)");
  } catch (err) {
    console.warn("Failed to register F18:", err);
  }
}

function restoreHistory() {
  for (const msg of chatHistory) {
    const el = document.createElement("div");
    el.className = `message ${msg.sender}`;
    const senderName = msg.sender === "user" ? "Henrique" : "Claw 🦀";
    const timeStr = new Date(msg.time).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    el.innerHTML = `
      <div class="sender">${senderName}</div>
      ${msg.isAudio ? '<div class="audio-tag">🎤 Mensagem de voz</div>' : ""}
      <div class="text">${renderMarkdown(msg.text)}</div>
      <div class="meta">${timeStr}</div>
    `;
    messagesEl.appendChild(el);
  }
  scrollToBottom();
}

// --- Token ---
function promptToken() {
  const token = prompt(
    "Eae Claw 🦀\n\nCola o token do gateway do OpenClaw:\n(openclaw config get gateway.auth.token)"
  );
  if (token) {
    localStorage.setItem("claw-token", token.trim());
    location.reload();
  }
}

// --- HTTP helper (uses Tauri plugin or browser fetch) ---
async function gatewayPost(tool, args = {}, timeoutMs = 120000) {
  const res = await tauriFetch(`${GATEWAY_URL}/tools/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GATEWAY_TOKEN}`,
    },
    body: JSON.stringify({ tool, args }),
    connectTimeout: timeoutMs,
  });
  return res;
}

// --- Connection ---
async function checkConnection() {
  setStatus("connecting");
  try {
    const res = await gatewayPost("session_status", {}, 5000);
    if (res.ok) {
      setStatus("online");
    } else if (res.status === 401 || res.status === 403) {
      setStatus("offline");
      addMessage("claw", "⚠️ Token inválido. Clica no status pra reconfigurar.", new Date());
      statusDot.style.cursor = "pointer";
      statusDot.onclick = () => {
        localStorage.removeItem("claw-token");
        promptToken();
      };
    } else {
      setStatus("offline");
      addMessage("claw", `⚠️ Gateway respondeu com status ${res.status}.`, new Date());
    }
  } catch (err) {
    setStatus("offline");
    addMessage(
      "claw",
      "⚠️ Não consegui conectar no OpenClaw em localhost:18789.\nVerifica se o port forwarding da VirtualBox tá ativo.",
      new Date()
    );
    console.error("Connection check failed:", err);
  }
}

function setStatus(state) {
  statusDot.className = `status-dot ${state}`;
  const labels = { online: "Online", offline: "Offline", connecting: "Conectando..." };
  statusText.textContent = labels[state] || state;
}

// --- Send text ---
async function sendText() {
  const text = textInput.value.trim();
  if (!text) return;

  textInput.value = "";
  addMessage("user", text, new Date());
  await sendToGateway(text);
}

// --- Send to OpenClaw gateway ---
async function sendToGateway(text) {
  showTyping();

  try {
    const res = await gatewayPost("sessions_send", {
      message: text,
      sessionKey: "agent:main:main",
      timeoutSeconds: 120,
    });

    hideTyping();

    if (!res.ok) {
      const errText = await res.text();
      addMessage("claw", `⚠️ Erro (${res.status}): ${errText}`, new Date());
      return;
    }

    const data = await res.json();
    const reply = extractReply(data);
    addMessage("claw", reply, new Date());
  } catch (err) {
    hideTyping();
    addMessage("claw", `⚠️ Erro de conexão: ${err.message}`, new Date());
  }
}

// --- Extract reply text from various response shapes ---
function extractReply(data) {
  // The API returns: { ok, result: { content: [{ type: "text", text: "..." }], details: {...} } }
  // The text field contains JSON string with { runId, status, reply, ... }
  
  // First, extract the text content
  let text = "";
  if (data?.result?.content && Array.isArray(data.result.content)) {
    text = data.result.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
  } else if (data?.result?.reply) {
    return data.result.reply;
  } else if (data?.result?.message) {
    return data.result.message;
  } else if (typeof data?.result === "string") {
    text = data.result;
  }

  // Try to parse the text as JSON to extract the reply field
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (parsed.reply) return parsed.reply;
      if (parsed.message) return parsed.message;
      if (parsed.text) return parsed.text;
      if (parsed.status === "timeout") return "⏱️ Timeout — tenta de novo.";
    } catch {
      // Not JSON, return as-is
      return text;
    }
  }

  return text || JSON.stringify(data, null, 2);
}

// --- File drop/attach handler ---
async function handleFileDrop(files) {
  for (const file of files) {
    const sizeMb = (file.size / 1024 / 1024).toFixed(1);
    addMessage("user", `📎 ${file.name} (${sizeMb} MB)`, new Date());

    showTyping();
    try {
      // Save file to shared folder for the VM to read
      if (tauriFs && tauriPath) {
        const appDataDir = await tauriPath.appDataDir();
        const sharedDir = `${appDataDir}shared/`;
        const dirExists = await tauriFs.exists(sharedDir);
        if (!dirExists) {
          await tauriFs.mkdir(sharedDir, { recursive: true });
        }
        // Read file as bytes and write to shared folder
        const arrayBuffer = await file.arrayBuffer();
        await tauriFs.writeFile(`${sharedDir}${file.name}`, new Uint8Array(arrayBuffer));
      }

      // Send message telling Claw about the file
      const messageText = `[Arquivo enviado pelo Eae Claw]\nNome: ${file.name}\nTipo: ${file.type || "desconhecido"}\nTamanho: ${sizeMb} MB\nLocal: AppData/shared/${file.name}\n\nPor favor, leia e analise este arquivo.`;

      const res = await gatewayPost("sessions_send", {
        message: messageText,
        sessionKey: "agent:main:main",
        timeoutSeconds: 120,
      });

      hideTyping();

      if (!res.ok) {
        const errText = await res.text();
        addMessage("claw", `⚠️ Erro (${res.status}): ${errText}`, new Date());
        return;
      }

      const data = await res.json();
      const reply = extractReply(data);
      addMessage("claw", reply, new Date());
    } catch (err) {
      hideTyping();
      addMessage("claw", `⚠️ Erro: ${err.message}`, new Date());
    }
  }
}

function fileToBase64(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.readAsDataURL(file);
  });
}

// --- Audio recording ---
async function toggleRecording() {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());

      if (audioChunks.length === 0) return;

      const blob = new Blob(audioChunks, { type: "audio/webm" });
      const base64 = await blobToBase64(blob);

      // Show audio message placeholder - will be updated with transcript
      const audioMsgEl = addMessage("user", "🎤 Transcrevendo...", new Date(), true);
      await sendAudioToGateway(base64, audioMsgEl);
    };

    mediaRecorder.start(100);
    isRecording = true;
    recStartTime = Date.now();

    btnMic.classList.add("recording");
    document.body.classList.add("recording");
    recIndicator.classList.remove("hidden");
    updateRecTime();
    recTimer = setInterval(updateRecTime, 1000);
  } catch (err) {
    addMessage("claw", `⚠️ Erro ao acessar microfone: ${err.message}`, new Date());
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
  isRecording = false;
  btnMic.classList.remove("recording");
  document.body.classList.remove("recording");
  recIndicator.classList.add("hidden");
  clearInterval(recTimer);
}

function cancelRecording() {
  audioChunks = [];
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.onstop = () => {
      mediaRecorder.stream.getTracks().forEach((t) => t.stop());
    };
    mediaRecorder.stop();
  }
  isRecording = false;
  btnMic.classList.remove("recording");
  document.body.classList.remove("recording");
  recIndicator.classList.add("hidden");
  clearInterval(recTimer);
}

function updateRecTime() {
  const elapsed = Math.floor((Date.now() - recStartTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  recTimeEl.textContent = `${mins}:${secs.toString().padStart(2, "0")}`;
}

async function sendAudioToGateway(base64Audio, audioMsgEl) {
  showTyping();

  try {
    // Step 1: Transcribe audio via OpenAI Whisper API directly
    const audioBlob = base64ToBlob(base64Audio, "audio/webm");
    const formData = new FormData();
    formData.append("file", audioBlob, "voice.webm");
    formData.append("model", "whisper-1");
    formData.append("language", "pt");

    // Get OpenAI key from gateway config or use stored one
    let openaiKey = localStorage.getItem("claw-openai-key") || "";
    if (!openaiKey) {
      openaiKey = prompt("Eae Claw 🦀\n\nPra transcrever áudio, preciso da OpenAI API key:\n(OPENAI_API_KEY)");
      if (openaiKey) {
        localStorage.setItem("claw-openai-key", openaiKey.trim());
      } else {
        hideTyping();
        addMessage("claw", "⚠️ Sem API key do OpenAI, não consigo transcrever áudio.", new Date());
        return;
      }
    }

    let transcript = "";
    try {
      const whisperRes = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${openaiKey}`,
        },
        body: formData,
      });

      if (!whisperRes.ok) {
        const err = await whisperRes.text();
        hideTyping();
        addMessage("claw", `⚠️ Erro Whisper (${whisperRes.status}): ${err}`, new Date());
        return;
      }

      const whisperData = await whisperRes.json();
      transcript = whisperData.text || "";
    } catch (err) {
      hideTyping();
      addMessage("claw", `⚠️ Erro ao transcrever: ${err.message}`, new Date());
      return;
    }

    if (!transcript.trim()) {
      hideTyping();
      addMessage("claw", "⚠️ Não consegui transcrever o áudio. Tenta de novo.", new Date());
      return;
    }

    // Update the user message with the transcript
    if (audioMsgEl) {
      const textEl = audioMsgEl.querySelector(".text");
      if (textEl) textEl.textContent = transcript;
    }

    // Step 2: Send transcribed text to OpenClaw
    const res = await gatewayPost("sessions_send", {
      message: transcript,
      sessionKey: "agent:main:main",
      timeoutSeconds: 120,
    });

    hideTyping();

    if (!res.ok) {
      const errText = await res.text();
      addMessage("claw", `⚠️ Erro (${res.status}): ${errText}`, new Date());
      return;
    }

    const data = await res.json();
    const reply = extractReply(data);
    addMessage("claw", reply, new Date());
  } catch (err) {
    hideTyping();
    addMessage("claw", `⚠️ Erro: ${err.message}`, new Date());
  }
}

// Convert base64 data URL to Blob
function base64ToBlob(dataUrl, mimeType) {
  const base64 = dataUrl.split(",")[1];
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

// --- UI helpers ---
function addMessage(sender, text, time, isAudio = false) {
  const el = document.createElement("div");
  el.className = `message ${sender}`;

  const senderName = sender === "user" ? "Henrique" : "Claw 🦀";
  const timeStr = time.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });

  el.innerHTML = `
    <div class="sender">${senderName}</div>
    ${isAudio ? '<div class="audio-tag">🎤 Mensagem de voz</div>' : ""}
    <div class="text">${renderMarkdown(text)}</div>
    <div class="meta">${timeStr}</div>
  `;

  messagesEl.appendChild(el);
  scrollToBottom();

  // Save to history
  chatHistory.push({ sender, text, time: time.toISOString(), isAudio });
  if (chatHistory.length > 200) chatHistory = chatHistory.slice(-200);
  saveHistory();

  // Track unread in mini mode
  if (isMiniMode && sender === "claw") {
    unreadCount++;
    updateUnreadBadge();
  }

  return el;
}

function showTyping() {
  const el = document.createElement("div");
  el.className = "typing-indicator";
  el.id = "typing";
  el.innerHTML = `<div class="typing-dots"><span></span><span></span><span></span></div>`;
  messagesEl.appendChild(el);
  scrollToBottom();
}

function hideTyping() {
  const el = document.getElementById("typing");
  if (el) el.remove();
}

function scrollToBottom() {
  const container = document.getElementById("chat-container");
  container.scrollTop = container.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Simple Markdown renderer
function renderMarkdown(text) {
  let html = escapeHtml(text);

  // Code blocks (```...```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    return `<pre><code class="lang-${lang}">${code.trim()}</code></pre>`;
  });

  // Inline code (`...`)
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold (**...**)
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic (*...*)
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Strikethrough (~~...~~)
  html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Headers (### ... / ## ... / # ...)
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');

  // Unordered lists (- item / * item)
  html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');

  // Ordered lists (1. item)
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Links [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

  // Line breaks
  html = html.replace(/\n/g, '<br>');

  // Clean up <br> inside <pre>
  html = html.replace(/<pre><code([^>]*)>([\s\S]*?)<\/code><\/pre>/g, (match, cls, code) => {
    return `<pre><code${cls}>${code.replace(/<br>/g, '\n')}</code></pre>`;
  });

  return html;
}

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      resolve(reader.result);
    };
    reader.readAsDataURL(blob);
  });
}
