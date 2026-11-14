const socket = io();
const $ = (id) => document.getElementById(id);
let roomCode = null;
let roomState = null;
let player = null;
let playerReady = false;

// --- Playback model -------------------------------------------------------
// The server owns the timeline. This page never tells the server "I played",
// "I paused" or "I'm at 1:23". It only (a) follows the server's state and
// (b) sends a request when someone presses Play/Pause/Skip.
const DRIFT_LIMIT = 0.5;       // seconds of drift tolerated before re-seeking
const SEEK_SETTLE_MS = 2500;   // don't re-check drift right after a seek
let clockOffset = 0;           // serverTime - clientTime (ms)
let clockReady = false;
let playerLoadId = null;       // which server load is currently cued in the player
let cuedReported = false;
let lastSeekAt = 0;
let stuckTicks = 0;
let startTimer = null;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const serverNow = () => Date.now() + clockOffset;

function nameValue() { return $("displayName").value.trim() || "Guest"; }
function showError(message) { $("lobbyError").textContent = message || ""; }

$("createRoom").addEventListener("click", () => {
  socket.emit("room:create", { name: nameValue() }, handleRoomReply);
});
$("joinRoom").addEventListener("click", joinFromInput);
$("roomCode").addEventListener("keydown", e => { if (e.key === "Enter") joinFromInput(); });
function joinFromInput() {
  socket.emit("room:join", { code: $("roomCode").value.trim(), name: nameValue() }, handleRoomReply);
}
function handleRoomReply(reply) {
  if (!reply?.ok) return showError(reply?.error || "Could not enter that room.");
  roomCode = reply.code;
  roomState = reply.state;
  $("lobby").classList.add("hidden");
  $("watch").classList.remove("hidden");
  createPlayer();
  $("roomCodeLabel").textContent = roomCode;
  renderRoom(reply.state);
  history.replaceState({}, "", `/?room=${roomCode}`);
}
const params = new URLSearchParams(location.search);
if (params.get("room")) $("roomCode").value = params.get("room").toUpperCase();

$("copyInvite").addEventListener("click", async () => {
  const url = `${location.origin}/?room=${roomCode}`;
  try { await navigator.clipboard.writeText(url); $("copyInvite").textContent = "Copied!"; }
  catch { window.prompt("Copy this invite link:", url); }
  setTimeout(() => $("copyInvite").textContent = "Copy invite link", 1600);
});

// --- Clock sync: estimate server clock so every user shares one timeline ----
async function syncClock(samples = 6) {
  let best = null;
  for (let i = 0; i < samples; i++) {
    const t0 = Date.now();
    const serverTime = await new Promise(resolve => {
      const timeout = setTimeout(() => resolve(null), 2000);
      socket.emit("time:ping", t => { clearTimeout(timeout); resolve(t); });
    });
    const t1 = Date.now();
    if (serverTime != null) {
      const rtt = t1 - t0;
      // Samples with the smallest round trip are the most accurate.
      if (!best || rtt < best.rtt) best = { rtt, offset: serverTime + rtt / 2 - t1 };
    }
    await sleep(120);
  }
  if (best) { clockOffset = best.offset; clockReady = true; reconcile(); }
}
socket.on("connect", () => {
  syncClock();
  // After a network drop the socket gets a new id and the server forgets us: rejoin.
  if (roomCode) {
    socket.emit("room:join", { code: roomCode, name: nameValue() }, reply => {
      if (!reply?.ok) { location.href = "/"; return; }
      roomState = reply.state;
      renderRoom(reply.state);
    });
  }
});
setInterval(() => { if (socket.connected) syncClock(3); }, 30000);

// --- YouTube player ---------------------------------------------------------
let ytApiReady = false;
window.onYouTubeIframeAPIReady = () => { ytApiReady = true; createPlayer(); };
const YT_ERRORS = {
  2: "YouTube rejected this video link.",
  5: "Your browser's video player hit an error. Try reloading the page.",
  100: "This video was removed or is private.",
  101: "The owner of this video doesn't allow it to be played on other sites.",
  150: "The owner of this video doesn't allow it to be played on other sites."
};
function setPlayerStatus(text) {
  $("playerStatus").textContent = text || "";
  $("playerStatus").classList.toggle("hidden", !text);
}
// Create the player only once the room view is on screen. An embed created inside a
// display:none container fails to load in some browsers (notably Firefox and Safari).
function createPlayer() {
  if (player || !ytApiReady || !roomCode) return;
  player = new YT.Player("player", {
    width: "100%", height: "100%", videoId: "",
    // controls:0 + blocked pointer events (see CSS): the embedded player can't
    // be paused/seeked locally, which is what used to knock users out of sync.
    playerVars: { playsinline: 1, rel: 0, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, origin: location.origin },
    events: {
      onReady: () => { playerReady = true; applyVolume(); ensureLoaded(); reconcile(); updateControls(); },
      onStateChange: onPlayerStateChange,
      onError: (e) => {
        setPlayerStatus(YT_ERRORS[e.data] || `The video player reported error ${e.data}.`);
        reportReady(); // don't make everyone else wait on a video that can't load here
      }
    }
  });
}
// If the YouTube script never loaded (ad blocker, firewall), say so instead of showing nothing.
setTimeout(() => { if (!ytApiReady) setPlayerStatus("The YouTube player didn't load. An ad blocker or network filter may be blocking youtube.com."); }, 8000);

function safeTime() {
  try { return player && typeof player.getCurrentTime === "function" ? player.getCurrentTime() : 0; }
  catch { return 0; }
}
function safeState() {
  try { return player && typeof player.getPlayerState === "function" ? player.getPlayerState() : undefined; }
  catch { return undefined; }
}
function reportReady() {
  if (cuedReported || playerLoadId == null) return;
  cuedReported = true;
  socket.emit("video:ready", { loadId: playerLoadId });
}
function onPlayerStateChange(event) {
  if (!playerReady || !roomState) return;
  // The only things the page reports: "my player is cued" and "the video ended".
  // Neither changes the timeline by itself; the server decides what happens next.
  if (event.data === YT.PlayerState.CUED) { setPlayerStatus(""); reportReady(); }
  else if (event.data === YT.PlayerState.ENDED && playerLoadId === roomState.playback.loadId) {
    socket.emit("video:ended", { loadId: playerLoadId });
  }
  reconcile();
}

// Cue (never autoplay) whichever video the server says is current, at 0:00.
function ensureLoaded() {
  if (!playerReady || !roomState) return;
  const video = roomState.currentVideo;
  if (!video) {
    if (playerLoadId !== null) {
      playerLoadId = null;
      try { player.stopVideo(); } catch {}
    }
    return;
  }
  const loadId = roomState.playback.loadId;
  if (playerLoadId === loadId) return;
  playerLoadId = loadId;
  cuedReported = false;
  stuckTicks = 0;
  lastSeekAt = 0;
  cueCurrent(video.videoId, loadId, 0);
}
// Cue the video; if the player never confirms (stalled load), retry a couple of times.
function cueCurrent(videoId, loadId, attempt) {
  setPlayerStatus("Loading video…");
  try { player.cueVideoById(videoId, 0); } catch {}
  setTimeout(() => {
    if (playerLoadId !== loadId || cuedReported) return;
    if (attempt < 2) cueCurrent(videoId, loadId, attempt + 1);
    else setPlayerStatus("This video is taking a long time to load. Try reloading the page.");
  }, 6000);
}

function seek(t) {
  lastSeekAt = Date.now();
  try { player.seekTo(Math.max(0, t), true); } catch {}
}

// Make this player match the server's timeline. Runs on every server update,
// on player state changes, and twice a second.
function reconcile() {
  if (!playerReady || !clockReady || !roomState?.currentVideo) return;
  const pb = roomState.playback;
  if (playerLoadId !== pb.loadId) return;
  if (pb.loading) return;                       // everyone waits, cued at 0:00
  const state = safeState();
  if (state === undefined || state === YT.PlayerState.ENDED) return;

  const now = serverNow();
  const target = pb.playing ? pb.position + Math.max(0, (now - pb.anchor) / 1000) : pb.position;
  const shouldPlay = pb.playing && now >= pb.anchor;

  // Scheduled start/resume: wait for the exact server instant, not "whenever I got the message".
  clearTimeout(startTimer);
  if (pb.playing && now < pb.anchor) startTimer = setTimeout(reconcile, pb.anchor - now);

  const actual = safeTime();
  const settling = Date.now() - lastSeekAt < SEEK_SETTLE_MS;
  const playerRunning = state === YT.PlayerState.PLAYING || state === YT.PlayerState.BUFFERING;

  if (shouldPlay) {
    if (state === YT.PlayerState.PLAYING) {
      stuckTicks = 0;
      hideSyncPrompt();
      if (!settling && Math.abs(actual - target) > DRIFT_LIMIT) seek(target);
    } else if (state !== YT.PlayerState.BUFFERING) {
      if (Math.abs(actual - target) > 0.5) seek(target);
      try { player.playVideo(); } catch {}
      // Browsers can block scripted playback until the user interacts with the video.
      if (++stuckTicks >= 6) showSyncPrompt();
    }
  } else {
    stuckTicks = 0;
    hideSyncPrompt();
    if (playerRunning) { try { player.pauseVideo(); } catch {} }
    if (!settling && Math.abs(actual - target) > 0.1) {
      // Paused (or waiting for a scheduled start): sit exactly where the server says.
      if (playerRunning || state === YT.PlayerState.PAUSED) seek(target);
      else if (target > 0.5) { lastSeekAt = Date.now(); try { player.cueVideoById(roomState.currentVideo.videoId, target); } catch {} }
    }
  }
}
setInterval(reconcile, 500);

function showSyncPrompt() { $("syncPrompt").classList.remove("hidden"); }
function hideSyncPrompt() { $("syncPrompt").classList.add("hidden"); }
$("syncPrompt").addEventListener("click", () => {
  stuckTicks = 0;
  hideSyncPrompt();
  try { player.playVideo(); } catch {}
  reconcile();
});

// --- Buttons: send a request, the server decides ----------------------------
function updateControls() {
  const pb = roomState?.playback;
  const hasVideo = Boolean(roomState?.currentVideo);
  $("playPause").disabled = !hasVideo || !playerReady || Boolean(pb?.loading);
  $("skipVideo").disabled = !hasVideo;
  $("playPause").textContent = pb?.loading && hasVideo ? "Syncing…" : pb?.playing ? "Ⅱ Pause" : "▶ Play";
}
$("playPause").addEventListener("click", () => {
  const pb = roomState?.playback;
  if (!pb || pb.loading) return;
  socket.emit("playback:request", { action: pb.playing ? "pause" : "play" });
});
$("skipVideo").addEventListener("click", () => {
  if (roomState?.currentVideo) socket.emit("video:skip", { loadId: roomState.playback.loadId });
});

// Volume is the one purely local control (it doesn't affect anyone else or sync).
function applyVolume() {
  try { player.setVolume(Number($("volume").value)); } catch {}
}
$("volume").addEventListener("input", applyVolume);

socket.on("room:state", state => {
  roomState = state;
  renderRoom(state);
});
function renderRoom(state) {
  $("roomCodeLabel").textContent = state.code;
  $("peopleCount").textContent = state.members.length;
  $("queueCount").textContent = state.queue.length;
  $("peopleList").innerHTML = state.members.map(m => `<span class="person">${escapeHtml(m.name)}</span>`).join("");
  $("currentTrack").textContent = state.currentVideo ? `Now playing: ${state.currentVideo.title}` : "No video selected";
  $("nowPlaying").textContent = state.currentVideo ? state.currentVideo.title : "Nothing playing yet";
  $("playerPlaceholder").classList.toggle("hidden", Boolean(state.currentVideo));
  $("queueList").innerHTML = state.queue.length ? state.queue.map((v, i) => `
    <div class="queue-item">
      <img src="${escapeAttr(v.thumbnail)}" alt="">
      <div class="track-text">${escapeHtml(v.title)}</div>
      <div class="track-actions"><button class="icon-button" data-play="${i}" title="Play next">▶</button><button class="icon-button" data-remove="${i}" title="Remove">×</button></div>
    </div>`).join("") : '<p class="empty-state">Your queue is empty.</p>';
  $("queueList").querySelectorAll("[data-play]").forEach(b => b.addEventListener("click", () => socket.emit("queue:play", { index: Number(b.dataset.play) })));
  $("queueList").querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click", () => socket.emit("queue:remove", { index: Number(b.dataset.remove) })));
  ensureLoaded();
  reconcile();
  updateControls();
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

$("searchForm").addEventListener("submit", async e => {
  e.preventDefault();
  const query = $("searchInput").value.trim();
  if (!query) return;
  $("searchStatus").textContent = "Searching YouTube…";
  $("searchResults").innerHTML = "";
  try {
    const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Search failed.");
    $("searchStatus").textContent = data.results.length ? `${data.results.length} results` : "No matching videos found.";
    $("searchResults").innerHTML = data.results.map(v => `
      <div class="result">
        <img src="${escapeAttr(v.thumbnail)}" alt="">
        <div class="result-info"><div class="result-title">${escapeHtml(v.title)}</div><div class="result-meta">${escapeHtml(v.author)}${v.duration ? " · " + escapeHtml(v.duration) : ""}</div></div>
        <button class="primary add-button" data-add="${escapeAttr(v.videoId)}">＋ Add</button>
      </div>`).join("");
    const byId = new Map(data.results.map(v => [v.videoId, v]));
    $("searchResults").querySelectorAll("[data-add]").forEach(button => {
      button.addEventListener("click", () => {
        socket.emit("queue:add", byId.get(button.dataset.add));
        button.textContent = "Added";
        button.disabled = true;
      });
    });
  } catch (error) {
    $("searchStatus").textContent = error.message;
  }
});

$("chatForm").addEventListener("submit", e => {
  e.preventDefault();
  const input = $("chatInput");
  const message = input.value.trim();
  if (!message) return;
  socket.emit("chat:send", { message });
  input.value = "";
});
socket.on("chat:message", msg => {
  const line = document.createElement("div");
  line.className = "chat-line";
  const name = document.createElement("strong");
  name.textContent = msg.name;
  const body = document.createElement("span");
  body.textContent = msg.message;
  line.append(name, body);
  $("chatMessages").append(line);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
});
