const socket = io();
const $ = id => document.getElementById(id);
let roomState = null;
let player = null;
let playerReady = false;
let currentVideoId = null;
let isApplyingRemote = false;
let playbackTimer = null;
let toastTimer = null;

function showToast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 2300);
}
function setError(id, message) { $(id).textContent = message || ""; }
function getName() { return $("displayName").value.trim() || "Guest"; }
function extractVideoId(input) {
  const value = String(input || "").trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.hostname === "youtu.be" || url.hostname === "www.youtu.be") return url.pathname.split("/").filter(Boolean)[0] || null;
    if (url.hostname.endsWith("youtube.com") || url.hostname.endsWith("youtube-nocookie.com")) {
      if (url.searchParams.get("v")) return url.searchParams.get("v");
      const parts = url.pathname.split("/").filter(Boolean);
      if (["embed", "shorts", "live"].includes(parts[0])) return parts[1] || null;
    }
  } catch (_) {}
  return null;
}
function enterRoom(state) {
  roomState = state;
  $("landing").classList.add("hidden");
  $("watch").classList.remove("hidden");
  $("roomCodeLabel").textContent = state.code;
  renderState(state);
  if (state.videoId) loadVideo(state.videoId);
}
function renderState(state) {
  roomState = state;
  $("roomCodeLabel").textContent = state.code;
  $("peopleCount").textContent = `${state.users.length} ${state.users.length === 1 ? "person" : "people"} watching`;
  $("queueCount").textContent = `${state.queue.length} ${state.queue.length === 1 ? "video" : "videos"} in the queue`;
  $("peopleList").innerHTML = "";
  state.users.forEach((user, i) => {
    const div = document.createElement("div"); div.className = "person" + (user.id === state.hostId ? " host" : "");
    const avatar = document.createElement("span"); avatar.className = "avatar " + ["avatar-peach","avatar-blue","avatar-lilac","avatar-green","avatar-yellow"][i % 5]; avatar.textContent = user.name.slice(0,1).toUpperCase();
    const name = document.createElement("span"); name.textContent = user.name;
    div.append(avatar, name); $("peopleList").append(div);
  });
  $("hostNote").classList.toggle("hidden", state.hostId !== socket.id);
  $("queueList").innerHTML = "";
  if (!state.queue.length) {
    const empty = document.createElement("div"); empty.className = "empty-queue"; empty.textContent = "Your queue is waiting for its first video."; $("queueList").append(empty);
  } else {
    state.queue.forEach((item, i) => {
      const row = document.createElement("div"); row.className = "queue-item";
      const img = document.createElement("img"); img.className = "queue-thumb"; img.src = `https://i.ytimg.com/vi/${item.videoId}/mqdefault.jpg`; img.alt = "";
      const info = document.createElement("div"); info.className = "queue-info";
      const title = document.createElement("strong"); title.textContent = item.title || "YouTube video";
      const by = document.createElement("span"); by.textContent = `Added by ${item.addedBy}`;
      info.append(title, by); row.append(img, info);
      if (state.hostId === socket.id) {
        const play = document.createElement("button"); play.textContent = "Play next"; play.addEventListener("click", () => socket.emit("queue:play", { itemId: item.id }, result => { if (!result.ok) showToast(result.error); }));
        row.append(play);
      }
      $("queueList").append(row);
    });
  }
}
function loadVideo(videoId) {
  $("playerPlaceholder").classList.add("hidden");
  if (!playerReady) { currentVideoId = videoId; return; }
  if (player && currentVideoId === videoId) return;
  currentVideoId = videoId;
  if (player) player.loadVideoById(videoId);
  else player = new YT.Player("youtubePlayer", {
    videoId,
    playerVars: { autoplay: 0, controls: 1, rel: 0, playsinline: 1, modestbranding: 1 },
    events: { onReady: () => { playerReady = true; if (roomState?.videoId) applyRemoteState(roomState.position, roomState.playing); },
      onStateChange: onPlayerStateChange,
      onError: () => showToast("This video may not allow embedded playback.") }
  });
}
window.onYouTubeIframeAPIReady = function() {
  playerReady = true;
  if (currentVideoId && !player) {
    const id = currentVideoId; currentVideoId = null; loadVideo(id);
  }
};
function onPlayerStateChange(event) {
  if (isApplyingRemote || !roomState || roomState.hostId !== socket.id) return;
  if (event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.ENDED) {
    const playing = event.data === YT.PlayerState.PLAYING;
    socket.emit("playback:update", { position: player.getCurrentTime(), playing });
    if (event.data === YT.PlayerState.ENDED && roomState.queue.length) {
      // Queue advancement remains a deliberate host action.
    }
  }
}
function applyRemoteState(position, playing) {
  if (!playerReady || !player || typeof player.seekTo !== "function") return;
  isApplyingRemote = true;
  const current = player.getCurrentTime() || 0;
  if (Math.abs(current - position) > 2.2) player.seekTo(position, true);
  if (playing && player.getPlayerState() !== YT.PlayerState.PLAYING) player.playVideo();
  if (!playing && player.getPlayerState() === YT.PlayerState.PLAYING) player.pauseVideo();
  setTimeout(() => { isApplyingRemote = false; }, 500);
}
socket.on("room:joined", state => enterRoom(state));
socket.on("room:state", state => {
  const previousVideo = roomState?.videoId;
  renderState(state);
  if (state.videoId && state.videoId !== previousVideo) loadVideo(state.videoId);
  if (!state.videoId) $("playerPlaceholder").classList.remove("hidden");
});
socket.on("playback:sync", data => applyRemoteState(data.position, data.playing));
socket.on("chat:message", msg => {
  const wrap = $("chatMessages");
  const welcome = wrap.querySelector(".chat-welcome"); if (welcome) welcome.remove();
  const item = document.createElement("div"); item.className = "chat-message";
  const meta = document.createElement("div"); meta.className = "chat-meta";
  const name = document.createElement("strong"); name.textContent = msg.name;
  const time = document.createElement("time"); time.textContent = new Date(msg.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const body = document.createElement("p"); body.textContent = msg.message;
  meta.append(name, time); item.append(meta, body); wrap.append(item); wrap.scrollTop = wrap.scrollHeight;
});

$("createRoom").addEventListener("click", () => {
  setError("landingError", "");
  socket.emit("room:create", { name: getName() }, result => {
    if (!result?.ok) setError("landingError", "Couldn't create a room. Please try again.");
  });
});
function join(code) {
  setError("landingError", "");
  socket.emit("room:join", { code, name: getName() }, result => {
    if (!result?.ok) setError("landingError", result.error);
  });
}
$("joinRoom").addEventListener("click", () => join($("roomCode").value));
$("roomCode").addEventListener("keydown", e => { if (e.key === "Enter") join($("roomCode").value); });
$("videoForm").addEventListener("submit", e => {
  e.preventDefault(); setError("videoError", "");
  const videoId = extractVideoId($("videoUrl").value);
  if (!videoId) return setError("videoError", "That doesn't look like a valid YouTube link.");
  const isHost = roomState?.hostId === socket.id;
  if (isHost) {
    socket.emit("video:set", { videoId }, result => { if (!result.ok) setError("videoError", result.error); else $("videoUrl").value = ""; });
  } else {
    socket.emit("queue:add", { videoId }, result => { if (!result.ok) setError("videoError", result.error); else { $("videoUrl").value = ""; showToast("Added to the shared queue."); } });
  }
});
$("chatForm").addEventListener("submit", e => {
  e.preventDefault(); const message = $("chatInput").value.trim(); if (!message) return;
  socket.emit("chat:send", { message }, result => { if (!result.ok) showToast(result.error); else $("chatInput").value = ""; });
});
$("copyInvite").addEventListener("click", async () => {
  const url = `${location.origin}/?room=${roomState.code}`;
  try { await navigator.clipboard.writeText(url); showToast("Invite link copied."); }
  catch (_) { showToast(url); }
});
$("leaveRoom").addEventListener("click", () => location.href = "/");
const params = new URLSearchParams(location.search);
if (params.get("room")) $("roomCode").value = params.get("room").toUpperCase();

// Host broadcasts periodic position updates to correct drift, even if playback state hasn't changed.
setInterval(() => {
  if (roomState && roomState.hostId === socket.id && playerReady && player && player.getPlayerState() === YT.PlayerState.PLAYING) {
    socket.emit("playback:update", { position: player.getCurrentTime(), playing: true });
  }
}, 4000);
