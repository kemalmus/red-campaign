import { NTFY_TOPIC, NTFY_BASE, KALE_MODEL, KALE_FRONTEND, DEFAULT_VOICE } from "./config.js?v=20261121e";
import { KaleTTS } from "./vendor/kale-tts.mjs?v=20261121e";

const ASSET_V = "20261121e";
const SILENCE =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQAAAAA=";
const MODEL_URL = `${KALE_MODEL}kale-tts-1-nano.onnx`;
const REPLY_TIMEOUT_MS = 180000;
const ACK_TIMEOUT_MS = 30000;

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
const muteBtn = document.getElementById("mute");
const voiceSel = document.getElementById("voice");
const statusEl = document.getElementById("status");
const voiceStatus = document.getElementById("voice-status");
const voiceMeter = document.getElementById("voice-meter");
const voiceFill = document.getElementById("voice-meter-fill");
const gate = document.getElementById("gate");
const enterBtn = document.getElementById("enter");
const statusBar = document.getElementById("status-bar");
const statusBarLabel = document.getElementById("status-bar-label");
const statusStop = document.getElementById("status-stop");

const seenNtfy = new Set();
const moves = new Map();
const audioCache = new Map();
const playControls = new Map();

let muted = localStorage.getItem("campaign_muted") === "1";
let voice = localStorage.getItem("campaign_voice") || DEFAULT_VOICE;
let audioCtx = null;
let keepAlive = null;
let htmlPlayer = null;
let currentSource = null;
let currentPlayId = null;
let tts = null;
let ttsMode = "none";
let kaleReady = false;
let lastNtfyId = "10m";
let pollTimer = null;
let barTimer = null;
let activeMoveId = null;

function setLinkStatus(state, label) {
  statusEl.dataset.state = state;
  statusEl.querySelector(".led-label").textContent = label;
}

function setMuteUi() {
  muteBtn.setAttribute("aria-pressed", muted ? "true" : "false");
  muteBtn.querySelector(".mute-label").textContent = muted ? "MUTE" : "LIVE";
}

function setVoiceStatus(text, state) {
  voiceStatus.textContent = text;
  if (state) voiceStatus.dataset.state = state;
}

function isTestEvent(ev) {
  if (!ev) return false;
  if (ev.test === true) return true;
  return /^\s*\[TEST\]/i.test(String(ev.text || ""));
}

function formatClock(ts) {
  if (!ts) return "";
  const d = new Date(typeof ts === "number" && ts < 1e12 ? ts * 1000 : ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function scrollToLatest() {
  const run = () => {
    logEl.scrollTop = logEl.scrollHeight;
  };
  run();
  requestAnimationFrame(() => {
    run();
    requestAnimationFrame(run);
  });
}

function syncKeyboard() {
  const vv = window.visualViewport;
  if (!vv) return;
  const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  document.documentElement.style.setProperty("--kb", kb + "px");
  scrollToLatest();
}

function resumeAudio() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (Ctx && !audioCtx) audioCtx = new Ctx();
  if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
  if (audioCtx && !keepAlive) {
    try {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      gain.gain.value = 0;
      osc.connect(gain).connect(audioCtx.destination);
      osc.start();
      keepAlive = { osc, gain };
    } catch (_) {
      /* ignore */
    }
  }
  if (!htmlPlayer) {
    htmlPlayer = new Audio();
    htmlPlayer.preload = "auto";
    htmlPlayer.playsInline = true;
    htmlPlayer.setAttribute("playsinline", "");
    htmlPlayer.setAttribute("webkit-playsinline", "");
  }
}

async function unlockAudio() {
  resumeAudio();
  try {
    if (audioCtx && audioCtx.resume) await audioCtx.resume();
    htmlPlayer.src = SILENCE;
    await htmlPlayer.play();
    htmlPlayer.pause();
    htmlPlayer.currentTime = 0;
  } catch (_) {
    /* next gesture retries */
  }
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
  if (!data) return null;
  if (data.event && data.event !== "message") {
    if (data.message == null) return null;
  }
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
    stage: payload.stage,
    test: payload.test === true,
    ts: data.time || Date.now() / 1000,
    ntfyId: data.id,
  };
  if (!ev.id) return null;
  if (ev.type === "ack") return ev;
  if (!ev.text) return null;
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

function stageCopy(move) {
  const stage = move.stage;
  if (stage === "sending") return "SENDING…";
  if (stage === "delivered") return "DELIVERED";
  if (stage === "writing") {
    const ms = Date.now() - (move.writingStartedAt || Date.now());
    return `GM IS WRITING  ${formatElapsed(ms)}`;
  }
  if (stage === "voicing") return "VOICING…";
  if (stage === "speaking") return "SPEAKING";
  if (stage === "error") return move.error || "SOMETHING WENT WRONG";
  if (stage === "done") return "DONE";
  return "IDLE";
}

function refreshStatusBar() {
  const move = (activeMoveId && moves.get(activeMoveId)) ||
    [...moves.values()].reverse().find((m) => !["done", "idle"].includes(m.stage));
  const stage = move ? move.stage : "idle";
  statusBar.dataset.stage = stage;
  statusBarLabel.textContent = move ? stageCopy(move) : "IDLE";
  statusStop.hidden = !(move && move.stage === "speaking");
}

function setPlayState(id, state) {
  const btn = playControls.get(id);
  if (!btn) return;
  btn.dataset.state = state;
  btn.textContent = state === "loading" ? "LOADING" : state === "playing" ? "STOP" : audioCache.has(id) ? "REPLAY" : "PLAY";
}

function stopPlayback() {
  if (currentSource) {
    try { currentSource.stop(); } catch (_) {}
    currentSource = null;
  }
  if (htmlPlayer) {
    try { htmlPlayer.pause(); } catch (_) {}
  }
  if (window.speechSynthesis) speechSynthesis.cancel();
  if (currentPlayId) {
    const row = logEl.querySelector(`.msg.narration[data-id="${currentPlayId}"]`);
    if (row) row.classList.remove("speaking");
    setPlayState(currentPlayId, "idle");
    const move = moves.get(currentPlayId);
    if (move && move.stage === "speaking") setMoveStage(currentPlayId, "done");
    currentPlayId = null;
  }
  refreshStatusBar();
}

function setMoveStage(id, stage, extra = {}) {
  const move = moves.get(id) || { id, stage: "idle" };
  move.stage = stage;
  Object.assign(move, extra);
  if (stage === "writing" && !move.writingStartedAt) move.writingStartedAt = Date.now();
  if (stage === "sending") move.sentAt = Date.now();
  moves.set(id, move);
  if (!["done"].includes(stage)) activeMoveId = id;
  if (move.stageEl) {
    move.stageEl.dataset.stage = stage;
    if (stage === "writing") {
      move.stageEl.innerHTML = "";
      const ticker = document.createElement("span");
      ticker.className = "ticker";
      ticker.innerHTML = 'GM IS WRITING<span class="tick">.</span><span class="tick">.</span><span class="tick">.</span>';
      const elapsed = document.createElement("span");
      elapsed.className = "elapsed";
      elapsed.textContent = formatElapsed(Date.now() - move.writingStartedAt);
      move.elapsedEl = elapsed;
      move.stageEl.append(ticker, elapsed);
    } else if (stage === "error") {
      move.stageEl.textContent = move.error || "ERROR";
      if (!move.stageEl.querySelector(".retry-btn")) {
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "retry-btn";
        retry.textContent = move.retryMode === "wait" ? "KEEP WAITING" : "RETRY";
        retry.addEventListener("click", () => retryMove(id));
        move.stageEl.append(retry);
      }
    } else {
      move.elapsedEl = null;
      move.stageEl.textContent = stageCopy(move);
    }
  }
  clearMoveTimers(move);
  if (stage === "sending") {
    move.ackTimer = setTimeout(() => {
      if (moves.get(id)?.stage === "sending") {
        setMoveStage(id, "error", {
          error: "SEND NOT CONFIRMED",
          retryMode: "resend",
        });
      }
    }, ACK_TIMEOUT_MS);
  }
  if (stage === "writing" || stage === "delivered") {
    const started = move.writingStartedAt || Date.now();
    const remain = REPLY_TIMEOUT_MS - (Date.now() - started);
    move.replyTimer = setTimeout(() => {
      if (["writing", "delivered"].includes(moves.get(id)?.stage)) {
        setMoveStage(id, "error", {
          error: "NO REPLY AFTER 3 MIN",
          retryMode: "wait",
        });
      }
    }, Math.max(1000, remain));
  }
  refreshStatusBar();
  scrollToLatest();
}

function clearMoveTimers(move) {
  if (move.ackTimer) { clearTimeout(move.ackTimer); move.ackTimer = null; }
  if (move.replyTimer) { clearTimeout(move.replyTimer); move.replyTimer = null; }
}

function tickBars() {
  for (const move of moves.values()) {
    if (move.stage === "writing" && move.elapsedEl) {
      move.elapsedEl.textContent = formatElapsed(Date.now() - (move.writingStartedAt || Date.now()));
    }
  }
  const current = activeMoveId && moves.get(activeMoveId);
  if (current && current.stage === "writing") refreshStatusBar();
}

function ensureActionRow(ev) {
  let move = moves.get(ev.id);
  if (move && move.el) return move;
  const row = document.createElement("article");
  row.className = "msg action" + (isTestEvent(ev) ? " test" : "");
  row.dataset.id = ev.id;
  const who = document.createElement("p");
  who.className = "who";
  const name = document.createElement("span");
  name.textContent = isTestEvent(ev) ? "YOU · TEST" : "YOU";
  const time = document.createElement("span");
  time.textContent = formatClock(ev.ts);
  who.append(name, time);
  const body = document.createElement("p");
  body.className = "body";
  body.textContent = ev.text || "";
  const stageEl = document.createElement("p");
  stageEl.className = "stage";
  row.append(who, body, stageEl);
  logEl.appendChild(row);
  move = Object.assign(move || {}, {
    id: ev.id,
    text: ev.text,
    voice: ev.voice || voice,
    test: isTestEvent(ev),
    el: row,
    stageEl,
    stage: move?.stage || "idle",
  });
  moves.set(ev.id, move);
  return move;
}

function renderNarration(ev) {
  if (logEl.querySelector(`.msg.narration[data-id="${ev.id}"][data-ntfy="${ev.ntfyId || ""}"]`)) return;
  if (logEl.querySelector(`.msg.narration[data-id="${ev.id}"]`) && !ev.ntfyId) return;
  const existing = logEl.querySelector(`.msg.narration[data-id="${ev.id}"]`);
  if (existing && ev.id) return existing;
  const row = document.createElement("article");
  row.className = "msg narration" + (isTestEvent(ev) ? " test" : "");
  row.dataset.id = ev.id;
  if (ev.ntfyId) row.dataset.ntfy = ev.ntfyId;
  const who = document.createElement("p");
  who.className = "who";
  const name = document.createElement("span");
  name.textContent = isTestEvent(ev) ? "TEST" : "GM";
  const time = document.createElement("span");
  time.textContent = formatClock(ev.ts);
  who.append(name, time);
  const body = document.createElement("p");
  body.className = "body";
  body.textContent = ev.text || "";
  const actions = document.createElement("div");
  actions.className = "msg-actions";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "play-btn";
  btn.dataset.state = "idle";
  btn.textContent = "PLAY";
  const onPlay = (e) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    resumeAudio();
    if (currentPlayId === ev.id && btn.dataset.state === "playing") {
      stopPlayback();
      return;
    }
    playNarration(ev, row);
  };
  btn.addEventListener("click", onPlay);
  btn.addEventListener("touchstart", (e) => { resumeAudio(); }, { passive: true });
  actions.append(btn);
  playControls.set(ev.id, btn);
  row.append(who, body, actions);
  logEl.appendChild(row);
  if (audioCache.has(ev.id)) setPlayState(ev.id, "idle");
  return row;
}

function showSystemError(text) {
  const row = document.createElement("article");
  row.className = "msg error";
  const body = document.createElement("p");
  body.className = "body";
  body.textContent = text;
  row.append(body);
  logEl.appendChild(row);
  scrollToLatest();
}

async function fetchWithProgress(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error("download " + res.status);
  const total = Number(res.headers.get("content-length")) || 0;
  if (!res.body || !res.body.getReader) {
    const buf = await res.arrayBuffer();
    onProgress(buf.byteLength, buf.byteLength || total);
    return;
  }
  const reader = res.body.getReader();
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    onProgress(received, total);
  }
}

async function loadKale() {
  setVoiceStatus("Voice: downloading model…", "loading");
  voiceMeter.hidden = false;
  voiceFill.style.width = "0%";
  try {
    await fetchWithProgress(MODEL_URL, (got, total) => {
      if (total) {
        const pct = Math.min(100, Math.round((got / total) * 100));
        voiceFill.style.width = pct + "%";
        const mb = (got / 1048576).toFixed(1);
        const tot = (total / 1048576).toFixed(1);
        setVoiceStatus(`Voice: downloading model… ${mb} / ${tot} MB (${pct}%)`, "loading");
      } else {
        const mb = (got / 1048576).toFixed(1);
        setVoiceStatus(`Voice: downloading model… ${mb} MB`, "loading");
      }
    });
    voiceFill.style.width = "100%";
    setVoiceStatus("Voice: warming up the narrator…", "loading");
    tts = await KaleTTS.load(KALE_MODEL, {
      frontend: KALE_FRONTEND,
      graph: "int8",
      executionProviders: ["wasm"],
    });
    try { await tts.preload(DEFAULT_VOICE); } catch (_) {}
    kaleReady = true;
    ttsMode = "kale";
    if (typeof tts.listVoices === "function") fillVoices(tts.listVoices());
    voiceMeter.hidden = true;
    setVoiceStatus("Voice ready · Kale TTS (Magnus)", "ready");
  } catch (err) {
    console.warn("Kale load failed", err);
    tts = null;
    kaleReady = false;
    voiceMeter.hidden = true;
    if (window.speechSynthesis) {
      ttsMode = "speechSynthesis";
      setVoiceStatus("Voice: using this device’s speech (Kale failed to load)", "fallback");
    } else {
      ttsMode = "none";
      setVoiceStatus("Voice: unavailable", "fallback");
    }
  }
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

async function getAudioBuffer(cached) {
  if (cached.buffer && audioCtx) return cached.buffer;
  if (!audioCtx) resumeAudio();
  if (!audioCtx) return null;
  const wav = encodeWav(cached.audio, cached.sampleRate || 24000);
  const buffer = await audioCtx.decodeAudioData(wav.slice(0));
  cached.buffer = buffer;
  return buffer;
}

function playViaWebAudio(buffer) {
  return new Promise((resolve, reject) => {
    try {
      const src = audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(audioCtx.destination);
      currentSource = src;
      src.onended = () => {
        if (currentSource === src) currentSource = null;
        resolve();
      };
      src.start(0);
    } catch (err) {
      reject(err);
    }
  });
}

function playViaElement(cached) {
  return new Promise((resolve) => {
    const wav = encodeWav(cached.audio, cached.sampleRate || 24000);
    const url = URL.createObjectURL(new Blob([wav], { type: "audio/wav" }));
    const done = () => {
      htmlPlayer.removeEventListener("ended", done);
      htmlPlayer.removeEventListener("error", done);
      URL.revokeObjectURL(url);
      resolve();
    };
    htmlPlayer.addEventListener("ended", done);
    htmlPlayer.addEventListener("error", done);
    htmlPlayer.src = url;
    const start = htmlPlayer.play();
    if (start && start.catch) start.catch(() => done());
  });
}

async function synthesize(text, chosenVoice) {
  if (kaleReady && tts) {
    const { audio, sampleRate } = await tts.speak(text, { voice: chosenVoice || voice });
    return { audio, sampleRate: sampleRate || 24000, mode: "kale" };
  }
  throw new Error("kale not ready");
}

async function playNarration(ev, row) {
  resumeAudio();
  if (audioCtx && audioCtx.resume) {
    try { await audioCtx.resume(); } catch (_) {}
  }
  stopPlayback();
  currentPlayId = ev.id;
  const move = moves.get(ev.id);
  setPlayState(ev.id, "loading");
  if (move && ev && !isTestEvent(ev)) setMoveStage(ev.id, "voicing");
  try {
    let cached = audioCache.get(ev.id);
    if (!cached) {
      if (kaleReady && tts) {
        cached = await synthesize(ev.text, ev.voice || voice);
        audioCache.set(ev.id, cached);
      } else if (ttsMode === "speechSynthesis") {
        if (move && !isTestEvent(ev)) setMoveStage(ev.id, "speaking");
        setPlayState(ev.id, "playing");
        if (row) row.classList.add("speaking");
        await new Promise((resolve) => {
          const u = new SpeechSynthesisUtterance(ev.text);
          u.lang = "en-US";
          u.onend = resolve;
          u.onerror = resolve;
          speechSynthesis.speak(u);
        });
        if (row) row.classList.remove("speaking");
        setPlayState(ev.id, "idle");
        if (move && !isTestEvent(ev)) setMoveStage(ev.id, "done");
        currentPlayId = null;
        return;
      } else {
        throw new Error("no voice");
      }
    }
    if (move && !isTestEvent(ev)) setMoveStage(ev.id, "speaking");
    setPlayState(ev.id, "playing");
    if (row) row.classList.add("speaking");
    let played = false;
    try {
      const buffer = await getAudioBuffer(cached);
      if (buffer && audioCtx) {
        await playViaWebAudio(buffer);
        played = true;
      }
    } catch (err) {
      console.warn("webaudio play failed", err);
    }
    if (!played) await playViaElement(cached);
  } catch (err) {
    console.warn("play failed", err);
    showSystemError("could not play the narration");
  } finally {
    if (row) row.classList.remove("speaking");
    if (currentPlayId === ev.id) {
      setPlayState(ev.id, "idle");
      currentPlayId = null;
      if (move && !isTestEvent(ev) && move.stage === "speaking") setMoveStage(ev.id, "done");
    }
    refreshStatusBar();
  }
}

async function handleEvent(ev, { historic = false } = {}) {
  if (!ev) return;
  if (ev.ntfyId) {
    if (seenNtfy.has(ev.ntfyId)) return;
    seenNtfy.add(ev.ntfyId);
    lastNtfyId = ev.ntfyId;
  }
  if (ev.type === "ack") {
    const move = moves.get(ev.id) || ensureActionRow({ id: ev.id, text: ev.text || "…", test: ev.test });
    if (["sending", "idle"].includes(move.stage || "idle") || !move.stage) {
      setMoveStage(ev.id, "delivered");
      setTimeout(() => {
        if (moves.get(ev.id)?.stage === "delivered") setMoveStage(ev.id, "writing");
      }, 700);
    }
    return;
  }
  if (ev.type === "action") {
    const move = ensureActionRow(ev);
    if (historic) {
      if (move.stage === "idle" || !move.stage) {
        const started = (ev.ts && ev.ts < 1e12 ? ev.ts * 1000 : ev.ts) || Date.now();
        if (Date.now() - started > REPLY_TIMEOUT_MS) {
          setMoveStage(ev.id, "done");
        } else {
          setMoveStage(ev.id, "writing", { writingStartedAt: started });
        }
      }
    } else if (move.stage === "idle" || !move.stage) {
      setMoveStage(ev.id, "sending");
    }
    scrollToLatest();
    return;
  }
  if (ev.type === "narration") {
    const row = renderNarration(ev);
    const move = moves.get(ev.id);
    if (move) {
      clearMoveTimers(move);
      if (isTestEvent(ev) || historic || muted) {
        setMoveStage(ev.id, "done");
      } else {
        setMoveStage(ev.id, "voicing");
        playNarration(ev, row);
      }
    } else {
      /* narration without a stored move — still show it */
    }
    scrollToLatest();
    setLinkStatus("on", "LIVE");
  }
}

async function loadHistory() {
  const url = `${NTFY_BASE}/${encodeURIComponent(NTFY_TOPIC)}/json?poll=1&since=all`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("history " + r.status);
  const raw = await r.text();
  const events = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const ev = parseNtfy(line);
    if (ev) events.push(ev);
  }
  events.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const narrated = new Set(events.filter((e) => e.type === "narration").map((e) => e.id));
  for (const ev of events) {
    if (ev.type === "narration") {
      handleEvent(ev, { historic: true });
    } else if (ev.type === "action") {
      handleEvent(ev, { historic: true });
      if (narrated.has(ev.id)) setMoveStage(ev.id, "done");
    } else if (ev.type === "ack") {
      if (!narrated.has(ev.id)) handleEvent(ev, { historic: true });
    }
  }
}

async function pollOnce() {
  try {
    const url = `${NTFY_BASE}/${encodeURIComponent(NTFY_TOPIC)}/json?poll=1&since=${encodeURIComponent(lastNtfyId)}`;
    const r = await fetch(url);
    if (!r.ok) return;
    const raw = await r.text();
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const ev = parseNtfy(line);
      if (ev) handleEvent(ev, { historic: false });
    }
  } catch (_) {
    /* keep polling */
  }
}

function connectChannel() {
  const url = `${NTFY_BASE}/${encodeURIComponent(NTFY_TOPIC)}/sse`;
  const es = new EventSource(url);
  const onMsg = (e) => {
    const ev = parseNtfy(e.data);
    if (ev) handleEvent(ev, { historic: false });
  };
  es.addEventListener("message", onMsg);
  es.onmessage = onMsg;
  es.onopen = () => setLinkStatus("on", "LIVE");
  es.onerror = () => setLinkStatus("wait", "RECONNECT");
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(pollOnce, 2000);
}

async function publishAction(id, text, chosenVoice, test = false) {
  const body = { type: "action", id, text, voice: chosenVoice };
  if (test) body.test = true;
  const r = await fetch(`${NTFY_BASE}/${encodeURIComponent(NTFY_TOPIC)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Title: test ? "test-action" : "action" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("channel " + r.status);
}

async function retryMove(id) {
  const move = moves.get(id);
  if (!move) return;
  resumeAudio();
  if (move.retryMode === "wait") {
    setMoveStage(id, "writing", { writingStartedAt: Date.now(), error: "", retryMode: "" });
    return;
  }
  setMoveStage(id, "sending", { error: "", retryMode: "" });
  try {
    publishedIds.delete(id);
    publishedIds.add(id);
    await publishAction(id, move.text, move.voice, move.test);
  } catch (err) {
    publishedIds.delete(id);
    setMoveStage(id, "error", { error: "SEND FAILED", retryMode: "resend" });
  }
}

const publishedIds = new Set();
let sendInFlight = false;

function newMoveId() {
  return (crypto.randomUUID && crypto.randomUUID().replace(/-/g, "")) ||
    Math.random().toString(16).slice(2) + Date.now().toString(16);
}

// Capture the move synchronously on the first tap: disable Send, clear the
// field, and show SENDING before any await. A second tap then cannot start
// another send (iOS often fires a delayed click, or the first tap was only
// unlocking audio / dismissing the keyboard).
function captureSend() {
  if (sendInFlight || sendBtn.disabled) return null;
  const text = input.value.trim();
  if (!text) return null;
  sendInFlight = true;
  sendBtn.disabled = true;
  input.value = "";
  input.style.height = "auto";
  const ev = {
    type: "action",
    id: newMoveId(),
    text,
    voice: voiceSel.value,
    ts: Date.now() / 1000,
  };
  ensureActionRow(ev);
  setMoveStage(ev.id, "sending");
  scrollToLatest();
  return ev;
}

async function dispatchSend(ev) {
  resumeAudio();
  unlockAudio().catch(() => {});
  try {
    if (publishedIds.has(ev.id)) return;
    publishedIds.add(ev.id);
    await publishAction(ev.id, ev.text, ev.voice, !!ev.test);
  } catch (err) {
    publishedIds.delete(ev.id);
    setMoveStage(ev.id, "error", { error: "SEND FAILED", retryMode: "resend" });
    console.warn(err);
  } finally {
    sendInFlight = false;
    sendBtn.disabled = false;
    input.focus();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  resumeAudio();
  const ev = captureSend();
  if (ev) dispatchSend(ev);
});

// First tap on iOS: don't wait for the delayed click, and prevent that click
// from submitting a second copy of the same move.
sendBtn.addEventListener("pointerdown", () => resumeAudio());
sendBtn.addEventListener("touchend", (e) => {
  e.preventDefault();
  resumeAudio();
  const ev = captureSend();
  if (ev) dispatchSend(ev);
}, { passive: false });

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
input.addEventListener("focus", syncKeyboard);

voiceSel.addEventListener("change", () => {
  voice = voiceSel.value;
  localStorage.setItem("campaign_voice", voice);
});

muteBtn.addEventListener("click", () => {
  muted = !muted;
  localStorage.setItem("campaign_muted", muted ? "1" : "0");
  setMuteUi();
  if (muted) stopPlayback();
});

statusStop.addEventListener("click", () => {
  resumeAudio();
  stopPlayback();
});

window.addEventListener("resize", syncKeyboard);
if (window.visualViewport) {
  visualViewport.addEventListener("resize", syncKeyboard);
  visualViewport.addEventListener("scroll", syncKeyboard);
}

fillVoices(FALLBACK_VOICES);
setMuteUi();
setLinkStatus("off", "OFFLINE");
refreshStatusBar();
barTimer = setInterval(tickBars, 500);

async function startChannel() {
  resumeAudio();
  await unlockAudio();
  gate.hidden = true;
  setLinkStatus("wait", "CONNECTING");
  loadKale();
  try {
    await loadHistory();
  } catch (err) {
    console.warn("history", err);
    showSystemError("could not load earlier messages");
  }
  connectChannel();
}

enterBtn.addEventListener("click", startChannel);
enterBtn.addEventListener("touchstart", () => resumeAudio(), { passive: true });

window.__netlink = {
  version: ASSET_V,
  moves,
  publishedIds,
  captureSend,
  dispatchSend,
  setMoveStage,
  ensureActionRow,
  handleEvent,
  parseNtfy,
  audioCache,
  playNarration,
  stopPlayback,
  isTestEvent,
};
