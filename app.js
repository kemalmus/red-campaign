import { NTFY_TOPIC, NTFY_BASE, KALE_MODEL, KALE_FRONTEND, DEFAULT_VOICE } from "./config.js";
import { KaleTTS } from "./vendor/kale-tts.mjs";

const SILENCE =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";

const FALLBACK_VOICES = [
  { name: "Magnus", id: "h013f", label: "Magnus · deep dramatic trailer narrator" },
  { name: "Kenzie", id: "s057b", label: "Kenzie · esports hype woman" },
  { name: "Simone", id: "f06", label: "Simone · deep and confident woman" },
  { name: "Amy", id: "d03", label: "Amy · british woman, crisp news-style" },
  { name: "Frankie", id: "w165", label: "Frankie · hard-boiled detective's partner" },
  { name: "Darlene", id: "w602", label: "Darlene · rough low-voiced old trucker woman" },
  { name: "Owen", id: "m3", label: "Owen · bright young host" },
  { name: "Toby", id: "t071", label: "Toby · mischievous prankster" },
  { name: "Jack", id: "d13", label: "Jack · british man, crisp news-style" },
  { name: "Earl", id: "x328", label: "Earl · African American jazz granddad" },
];

const logEl = document.getElementById("log");
const form = document.getElementById("composer");
const input = document.getElementById("action");
const sendBtn = document.getElementById("send");
const waitEl = document.getElementById("waiting");
const muteBtn = document.getElementById("mute");
const voiceSel = document.getElementById("voice");
const statusEl = document.getElementById("status");
const voiceStatus = document.getElementById("voice-status");
const gate = document.getElementById("gate");
const enterBtn = document.getElementById("enter");

const seen = new Set();
const spoken = new Set();
const playQueue = [];
let muted = localStorage.getItem("campaign_muted") === "1";
let voice = localStorage.getItem("campaign_voice") || DEFAULT_VOICE;
let audioUnlocked = false;
let player = null;
let playing = false;
let pendingId = null;
let tts = null;
let ttsMode = "none"; // kale | speechSynthesis | none
let kaleReady = false;

function setStatus(state, label) {
  statusEl.dataset.state = state;
  statusEl.querySelector(".led-label").textContent = label;
}

function showWaiting(on) {
  waitEl.hidden = !on;
  if (on) setStatus("wait", "WAITING");
}

function setMuteUi() {
  muteBtn.setAttribute("aria-pressed", muted ? "true" : "false");
  muteBtn.querySelector(".mute-label").textContent = muted ? "MUTE" : "LIVE";
}

function setVoiceStatus(text) {
  voiceStatus.textContent = text;
}

function isTestEvent(ev) {
  if (!ev) return false;
  if (ev.test === true) return true;
  const text = String(ev.text || "");
  return /^\s*\[TEST\]/i.test(text);
}

function keyOf(ev) {
  return `${ev.type}:${ev.id}:${ev.ntfyId || ev.ts || ""}`;
}

function formatTime(ts) {
  if (!ts) return "";
  const d = new Date(typeof ts === "number" && ts < 1e12 ? ts * 1000 : ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function parseNtfy(raw) {
  let data = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || data.event && data.event !== "message") {
    if (data && data.message != null) {
      /* continue, it's a message object */
    } else {
      return null;
    }
  }
  if (data.event && data.event !== "message") return null;
  let payload = data.message;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = { type: "narration", id: data.id, text: payload };
    }
  }
  if (!payload || typeof payload !== "object") return null;
  const ev = {
    type: payload.type || "narration",
    id: String(payload.id || data.id || ""),
    text: String(payload.text || ""),
    voice: payload.voice,
    test: payload.test === true,
    ts: data.time || Date.now() / 1000,
    ntfyId: data.id,
  };
  if (!ev.text || !ev.id) return null;
  return ev;
}

function fillVoices(list) {
  const voices = list && list.length ? list : FALLBACK_VOICES;
  voiceSel.innerHTML = "";
  let selected = null;
  for (const v of voices) {
    const opt = document.createElement("option");
    opt.value = v.name || v.id;
    opt.textContent = v.label || v.name || v.id;
    voiceSel.append(opt);
    const id = String(v.name || v.id || "").toLowerCase();
    if (id === voice.toLowerCase() || String(v.id || "").toLowerCase() === voice.toLowerCase()) {
      selected = opt.value;
    }
  }
  if (!selected) {
    const mag = [...voiceSel.options].find((o) => o.textContent.toLowerCase().includes("magnus"));
    selected = mag ? mag.value : voiceSel.options[0]?.value;
  }
  if (selected) voiceSel.value = selected;
  voice = voiceSel.value;
}

async function unlockAudio() {
  if (audioUnlocked) return;
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) {
      const ctx = new Ctx();
      const buf = ctx.createBuffer(1, 1, 22050);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      src.start(0);
      if (ctx.resume) await ctx.resume();
    }
    if (!player) {
      player = new Audio();
      player.preload = "auto";
    }
    player.src = SILENCE;
    await player.play();
    player.pause();
    audioUnlocked = true;
  } catch (_) {
    /* try again on a later gesture */
  }
}

function clearSpeaking() {
  logEl.querySelectorAll(".msg.speaking").forEach((el) => el.classList.remove("speaking"));
}

function playBuffer(audio, sampleRate, row) {
  return new Promise((resolve) => {
    const wav = encodeWav(audio, sampleRate || 24000);
    const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
    if (!player) {
      player = new Audio();
      player.preload = "auto";
    }
    clearSpeaking();
    if (row) row.classList.add("speaking");
    const done = () => {
      player.removeEventListener("ended", done);
      player.removeEventListener("error", done);
      if (row) row.classList.remove("speaking");
      URL.revokeObjectURL(url);
      resolve();
    };
    player.addEventListener("ended", done);
    player.addEventListener("error", done);
    player.src = url;
    const start = player.play();
    if (start && start.catch) start.catch(() => done());
  });
}

function encodeWav(float32, sampleRate) {
  const pcm = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const write = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + pcm.length * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, pcm.length * 2, true);
  new Uint8Array(buffer, 44).set(new Uint8Array(pcm.buffer));
  return buffer;
}

async function speakFallback(text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) {
      resolve();
      return;
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    const voices = speechSynthesis.getVoices();
    const deep = voices.find((v) => /english/i.test(v.lang) && /male|daniel|fred|alex|david/i.test(v.name)) ||
      voices.find((v) => /^en/i.test(v.lang));
    if (deep) u.voice = deep;
    u.onend = resolve;
    u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}

async function synthesize(text, chosenVoice) {
  if (kaleReady && tts) {
    const { audio, sampleRate } = await tts.speak(text, { voice: chosenVoice || voice });
    return { audio, sampleRate, mode: "kale" };
  }
  throw new Error("kale not ready");
}

async function pumpQueue() {
  if (playing || muted || !playQueue.length) return;
  playing = true;
  const item = playQueue.shift();
  try {
    if (item.audio) {
      await playBuffer(item.audio, item.sampleRate, item.row);
    } else if (ttsMode === "speechSynthesis") {
      await speakFallback(item.text);
    }
  } catch (err) {
    console.warn("speak failed", err);
  } finally {
    playing = false;
    pumpQueue();
  }
}

async function enqueueSpeak(ev, row) {
  if (muted || isTestEvent(ev) || !ev.text) return;
  const sid = ev.ntfyId || keyOf(ev);
  if (spoken.has(sid)) return;
  spoken.add(sid);
  try {
    if (kaleReady && tts) {
      const { audio, sampleRate } = await synthesize(ev.text, ev.voice || voice);
      playQueue.push({ audio, sampleRate, row, text: ev.text });
    } else if (ttsMode === "speechSynthesis") {
      playQueue.push({ text: ev.text, row });
    } else {
      spoken.delete(sid);
      return;
    }
    pumpQueue();
  } catch (err) {
    console.warn("tts", err);
    spoken.delete(sid);
    if (window.speechSynthesis) {
      ttsMode = "speechSynthesis";
      playQueue.push({ text: ev.text, row });
      pumpQueue();
    }
  }
}

async function replay(ev, row) {
  await unlockAudio();
  playQueue.length = 0;
  if (player) player.pause();
  if (window.speechSynthesis) speechSynthesis.cancel();
  playing = false;
  spoken.delete(ev.ntfyId || keyOf(ev));
  const wasMuted = muted;
  muted = false;
  await enqueueSpeak(ev, row);
  muted = wasMuted;
}

function renderEvent(ev, { speak = false } = {}) {
  if (!ev || !ev.type) return;
  const key = keyOf(ev);
  if (seen.has(key)) return;
  seen.add(key);

  const row = document.createElement("article");
  row.className = "msg " + ev.type + (isTestEvent(ev) ? " test" : "");
  row.dataset.id = ev.id || "";

  if (ev.type === "action" || ev.type === "narration") {
    const who = document.createElement("p");
    who.className = "who";
    const name = document.createElement("span");
    name.textContent = ev.type === "action" ? "YOU" : isTestEvent(ev) ? "TEST" : "GM";
    const time = document.createElement("span");
    time.textContent = formatTime(ev.ts);
    who.append(name, time);
    const body = document.createElement("p");
    body.className = "body";
    body.textContent = ev.text || "";
    row.append(who, body);
    if (ev.type === "narration") {
      const actions = document.createElement("div");
      actions.className = "msg-actions";
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "replay";
      btn.textContent = "Replay";
      btn.addEventListener("click", () => replay(ev, row));
      actions.append(btn);
      row.append(actions);
    }
  } else {
    const body = document.createElement("p");
    body.className = "body";
    body.textContent = ev.text || ev.error || ev.type;
    row.append(body);
  }

  logEl.appendChild(row);
  logEl.scrollTop = logEl.scrollHeight;

  if (ev.type === "action") {
    pendingId = ev.id;
    showWaiting(true);
  }
  if (ev.type === "narration") {
    pendingId = null;
    showWaiting(false);
    if (speak && !isTestEvent(ev)) enqueueSpeak(ev, row);
  }
  return row;
}

function showError(text) {
  renderEvent({
    type: "error",
    id: "err-" + Date.now(),
    ts: Date.now() / 1000,
    text,
  });
}

async function loadHistory() {
  const url = `${NTFY_BASE}/${encodeURIComponent(NTFY_TOPIC)}/json?poll=1&since=all`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("history " + r.status);
  const raw = await r.text();
  const events = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = parseNtfy(line);
      if (ev) events.push(ev);
    } catch (_) {
      /* skip */
    }
  }
  events.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  for (const ev of events) {
    // History is shown, never auto-spoken (avoids stale / test lines on open).
    renderEvent(ev, { speak: false });
  }
}

function connectSSE() {
  const url = `${NTFY_BASE}/${encodeURIComponent(NTFY_TOPIC)}/sse`;
  const es = new EventSource(url);
  const onMsg = (e) => {
    try {
      const ev = parseNtfy(e.data);
      if (!ev) return;
      const row = renderEvent(ev, { speak: ev.type === "narration" && !isTestEvent(ev) });
      if (ev.type === "narration") setStatus("on", "LIVE");
      return row;
    } catch (err) {
      console.warn("sse parse", err);
    }
  };
  es.addEventListener("message", onMsg);
  es.onmessage = onMsg;
  es.onopen = () => setStatus("on", "LIVE");
  es.onerror = () => setStatus("wait", "RECONNECT");
}

async function loadKale() {
  setVoiceStatus("Voice: loading Kale TTS…");
  try {
    tts = await KaleTTS.load(KALE_MODEL, {
      frontend: KALE_FRONTEND,
      graph: "int8",
      executionProviders: ["wasm"],
    });
    try {
      await tts.preload(DEFAULT_VOICE);
    } catch (_) {
      /* first speak will load the voice */
    }
    kaleReady = true;
    ttsMode = "kale";
    if (typeof tts.listVoices === "function") {
      fillVoices(tts.listVoices());
    }
    const backend = tts.backend ? JSON.stringify(tts.backend) : "wasm/int8";
    setVoiceStatus("Voice: Kale TTS ready · " + backend);
  } catch (err) {
    console.warn("Kale load failed, falling back", err);
    tts = null;
    kaleReady = false;
    if (window.speechSynthesis) {
      ttsMode = "speechSynthesis";
      setVoiceStatus("Voice: device speech (Kale failed to load)");
    } else {
      ttsMode = "none";
      setVoiceStatus("Voice: unavailable");
    }
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  await unlockAudio();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  input.style.height = "auto";
  sendBtn.disabled = true;
  const id = (crypto.randomUUID && crypto.randomUUID().replace(/-/g, "")) ||
    Math.random().toString(16).slice(2) + Date.now().toString(16);
  const ev = { type: "action", id, text, voice: voiceSel.value, ts: Date.now() / 1000 };
  renderEvent(ev);
  showWaiting(true);
  try {
    const r = await fetch(`${NTFY_BASE}/${encodeURIComponent(NTFY_TOPIC)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Title: "action",
      },
      body: JSON.stringify({ type: "action", id, text, voice: voiceSel.value }),
    });
    if (!r.ok) throw new Error("channel " + r.status);
    pendingId = id;
  } catch (err) {
    showWaiting(false);
    showError("could not send the move");
    console.warn(err);
  } finally {
    sendBtn.disabled = false;
    input.focus();
  }
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
});

voiceSel.addEventListener("change", () => {
  voice = voiceSel.value;
  localStorage.setItem("campaign_voice", voice);
});

muteBtn.addEventListener("click", () => {
  muted = !muted;
  localStorage.setItem("campaign_muted", muted ? "1" : "0");
  setMuteUi();
  if (muted) {
    playQueue.length = 0;
    if (player) player.pause();
    if (window.speechSynthesis) speechSynthesis.cancel();
    clearSpeaking();
    playing = false;
  }
});

fillVoices(FALLBACK_VOICES);
setMuteUi();
setStatus("off", "OFFLINE");

async function startChannel() {
  await unlockAudio();
  gate.hidden = true;
  setStatus("wait", "CONNECTING");
  loadKale();
  try {
    await loadHistory();
  } catch (err) {
    console.warn("history", err);
    showError("could not load earlier messages");
  }
  connectSSE();
}

enterBtn.addEventListener("click", startChannel);
