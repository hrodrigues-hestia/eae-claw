// Eae Claw - Main frontend logic
// Communicates with OpenClaw gateway via HTTP API

const GATEWAY_URL = "http://localhost:18789";
const GATEWAY_TOKEN = localStorage.getItem("claw-token") || "";

// --- State ---
let isRecording = false;
let mediaRecorder = null;
let audioChunks = [];
let recStartTime = null;
let recTimer = null;

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

function init() {
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

  // Welcome message
  addMessage("claw", "Eae! 🦀 Manda texto ou clica no microfone pra falar.", new Date());
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

// --- Connection ---
async function checkConnection() {
  setStatus("connecting");
  try {
    const res = await fetch(`${GATEWAY_URL}/api/health`, {
      headers: { Authorization: `Bearer ${GATEWAY_TOKEN}` },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      setStatus("online");
    } else if (res.status === 401) {
      setStatus("offline");
      addMessage("claw", "⚠️ Token inválido. Clica no status pra reconfigurar.", new Date());
      statusDot.style.cursor = "pointer";
      statusDot.onclick = () => {
        localStorage.removeItem("claw-token");
        promptToken();
      };
    } else {
      setStatus("offline");
    }
  } catch {
    setStatus("offline");
    addMessage(
      "claw",
      "⚠️ Não consegui conectar no OpenClaw em localhost:18789.\nVerifica se o port forwarding da VirtualBox tá ativo.",
      new Date()
    );
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
async function sendToGateway(text, audioBase64 = null) {
  showTyping();

  try {
    const body = {
      message: text,
    };

    if (audioBase64) {
      body.audio = audioBase64;
    }

    const res = await fetch(`${GATEWAY_URL}/api/tools/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        tool: "agent_turn",
        params: {
          message: text || "[audio]",
          sessionKey: "agent:main:main",
        },
      }),
      signal: AbortSignal.timeout(120000),
    });

    hideTyping();

    if (!res.ok) {
      const errText = await res.text();
      addMessage("claw", `⚠️ Erro (${res.status}): ${errText}`, new Date());
      return;
    }

    const data = await res.json();
    const reply = data?.result?.message || data?.result?.text || data?.message || JSON.stringify(data);
    addMessage("claw", reply, new Date());
  } catch (err) {
    hideTyping();
    addMessage("claw", `⚠️ Erro de conexão: ${err.message}`, new Date());
  }
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

      addMessage("user", "🎤 [áudio]", new Date(), true);

      // Send audio to OpenClaw for transcription + response
      await sendAudioToGateway(base64);
    };

    mediaRecorder.start(100);
    isRecording = true;
    recStartTime = Date.now();

    btnMic.classList.add("recording");
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
  recIndicator.classList.add("hidden");
  clearInterval(recTimer);
}

function updateRecTime() {
  const elapsed = Math.floor((Date.now() - recStartTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  recTimeEl.textContent = `${mins}:${secs.toString().padStart(2, "0")}`;
}

async function sendAudioToGateway(base64Audio) {
  showTyping();

  try {
    // Use the webhook endpoint to send audio as a message
    const res = await fetch(`${GATEWAY_URL}/api/tools/invoke`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        tool: "session_message",
        params: {
          sessionKey: "agent:main:main",
          message: "[audio message from Eae Claw desktop app]",
          media: {
            data: base64Audio,
            mimeType: "audio/webm",
            filename: "voice.webm",
          },
        },
      }),
      signal: AbortSignal.timeout(120000),
    });

    hideTyping();

    if (!res.ok) {
      const errText = await res.text();
      addMessage("claw", `⚠️ Erro (${res.status}): ${errText}`, new Date());
      return;
    }

    const data = await res.json();
    const reply = data?.result?.message || data?.result?.text || data?.message || JSON.stringify(data);
    addMessage("claw", reply, new Date());
  } catch (err) {
    hideTyping();
    addMessage("claw", `⚠️ Erro: ${err.message}`, new Date());
  }
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
    <div class="text">${escapeHtml(text)}</div>
    <div class="meta">${timeStr}</div>
  `;

  messagesEl.appendChild(el);
  scrollToBottom();
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

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      resolve(reader.result);
    };
    reader.readAsDataURL(blob);
  });
}
