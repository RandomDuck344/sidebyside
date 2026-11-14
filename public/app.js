const socket = io();
const $ = (id) => document.getElementById(id);
let roomCode = null;
let roomState = null;
let player = null;
let playerReady = false;
let expectedVideoId = null;
let applyingRemote = false;
let lastControlAt = 0;
let syncTimer = null;

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

window.onYouTubeIframeAPIReady = () => {
  player = new YT.Player("player", {
    width: "100%", height: "100%", videoId: "",
    playerVars: { playsinline: 1, rel: 0, origin: location.origin },
    events: {
      onReady: () => { playerReady = true; updateControls(); },
      onStateChange: onPlayerStateChange,
      onError: () => { $("nowPlaying").textContent = "This video cannot be embedded. Try another one."; }
    }
  });
};

function onPlayerStateChange(event) {
  if (!playerReady || applyingRemote || !roomCode) return;
  if (event.data === YT.PlayerState.PLAYING) {
    sendControl("play", safeTime());
  } else if (event.data === YT.PlayerState.PAUSED) {
    sendControl("pause", safeTime());
  } else if (event.data === YT.PlayerState.ENDED) {
    socket.emit("video:ended");
  }
}
function safeTime() {
  try { return player && typeof player.getCurrentTime === "function" ? player.getCurrentTime() : 0; }
  catch { return 0; }
}
function sendControl(action, position) {
  lastControlAt = Date.now();
  socket.emit("playback:control", { action, position });
}
function loadVideo(video, autoplay) {
  if (!video) {
    expectedVideoId = null;
    $("playerPlaceholder").classList.remove("hidden");
    $("nowPlaying").textContent = "Nothing playing yet";
    updateControls();
    return;
  }
  expectedVideoId = video.videoId;
  $("playerPlaceholder").classList.add("hidden");
  $("nowPlaying").textContent = video.title;
  if (playerReady) {
    applyingRemote = true;
    if (autoplay) player.loadVideoById(video.videoId, 0);
    else player.cueVideoById(video.videoId, 0);
    setTimeout(() => { applyingRemote = false; }, 1000);
  }
  updateControls();
}
function updateControls() {
  const hasVideo = Boolean(roomState?.currentVideo || expectedVideoId);
  $("playPause").disabled = !hasVideo || !playerReady;
  $("skipVideo").disabled = !hasVideo;
  const playing = roomState?.playback?.playing;
  $("playPause").textContent = playing ? "Ⅱ Pause" : "▶ Play";
}
$("playPause").addEventListener("click", () => {
  if (!playerReady) return;
  const playing = player.getPlayerState() === YT.PlayerState.PLAYING;
  sendControl(playing ? "pause" : "play", safeTime());
});
$("skipVideo").addEventListener("click", () => socket.emit("video:ended"));

socket.on("room:state", state => {
  roomState = state;
  renderRoom(state);
});
socket.on("video:load", ({ video, autoplay }) => {
  loadVideo(video, autoplay);
});
socket.on("playback:sync", sync => {
  if (!playerReady || !expectedVideoId) return;
  applyPlayback(sync);
});
function applyPlayback(sync) {
  const desired = Math.max(0, Number(sync.position) || 0) +
    (sync.playing ? Math.max(0, (Date.now() - sync.updatedAt) / 1000) : 0);
  const apply = () => {
    if (!playerReady || !expectedVideoId) return;
    applyingRemote = true;
    try {
      const actual = safeTime();
      const drift = Math.abs(actual - desired);
      if (drift > 1.35) player.seekTo(desired, true);
      if (sync.playing && player.getPlayerState() !== YT.PlayerState.PLAYING) player.playVideo();
      if (!sync.playing && player.getPlayerState() !== YT.PlayerState.PAUSED && player.getPlayerState() !== YT.PlayerState.CUED) player.pauseVideo();
    } catch {}
    setTimeout(() => { applyingRemote = false; }, 900);
  };
  apply();
}
function renderRoom(state) {
  $("roomCodeLabel").textContent = state.code;
  $("peopleCount").textContent = state.members.length;
  $("queueCount").textContent = state.queue.length;
  $("peopleList").innerHTML = state.members.map(m => `<span class="person">${escapeHtml(m.name)}</span>`).join("");
  $("currentTrack").textContent = state.currentVideo ? `Now playing: ${state.currentVideo.title}` : "No video selected";
  $("queueList").innerHTML = state.queue.length ? state.queue.map((v, i) => `
    <div class="queue-item">
      <img src="${escapeAttr(v.thumbnail)}" alt="">
      <div class="track-text">${escapeHtml(v.title)}</div>
      <div class="track-actions"><button class="icon-button" data-play="${i}" title="Play next">▶</button><button class="icon-button" data-remove="${i}" title="Remove">×</button></div>
    </div>`).join("") : '<p class="empty-state">Your queue is empty.</p>';
  $("queueList").querySelectorAll("[data-play]").forEach(b => b.addEventListener("click", () => socket.emit("queue:play", { index: Number(b.dataset.play) })));
  $("queueList").querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click", () => socket.emit("queue:remove", { index: Number(b.dataset.remove) })));
  if (state.currentVideo && state.currentVideo.videoId !== expectedVideoId) loadVideo(state.currentVideo, state.playback.playing);
  if (!state.currentVideo && expectedVideoId) loadVideo(null, false);
  updateControls();
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// Periodic correction prevents small drift from accumulating over time.
setInterval(() => {
  if (!roomState?.currentVideo || !roomState.playback || !playerReady || !expectedVideoId) return;
  if (Date.now() - lastControlAt < 1400) return;
  applyPlayback(roomState.playback);
}, 5000);

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
