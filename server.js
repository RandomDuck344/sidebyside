const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const yts = require("yt-search");
const crypto = require("crypto");
const sync = require("./sync");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });
const PORT = process.env.PORT || 3000;

app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true }));

const rooms = new Map();
const roomCode = () => crypto.randomBytes(3).toString("hex").toUpperCase();

function makeRoom() {
  let code;
  do { code = roomCode(); } while (rooms.has(code));
  const room = {
    code, members: new Map(), queue: [], currentVideo: null,
    playback: sync.newPlayback(), loadTimer: null
  };
  rooms.set(code, room);
  return room;
}
function getRoom(code) { return code ? rooms.get(String(code).toUpperCase()) : null; }
function snapshot(room) {
  return {
    code: room.code,
    members: [...room.members.values()],
    queue: room.queue,
    currentVideo: room.currentVideo,
    playback: sync.toClient(room.playback)
  };
}
function broadcastRoom(room) {
  io.to(room.code).emit("room:state", snapshot(room));
}

// Choose the video that plays now (or none). Every client cues it at 0:00 and
// reports "ready"; the server then starts them all together (see maybeStart).
function loadVideo(room, video) {
  clearTimeout(room.loadTimer);
  room.currentVideo = video || null;
  const loadId = sync.beginLoad(room.playback, Boolean(video), Date.now());
  if (video) {
    // Safety net: if someone's player never reports ready, start anyway.
    room.loadTimer = setTimeout(() => {
      if (room.playback.loadId === loadId && sync.startPlayback(room.playback, Date.now())) broadcastRoom(room);
    }, sync.READY_TIMEOUT_MS);
  }
}
// Start playback once every current member is ready. Returns true if it started.
function maybeStart(room) {
  const pb = room.playback;
  if (!sync.allReady(pb, [...room.members.keys()])) return false;
  clearTimeout(room.loadTimer);
  return sync.startPlayback(pb, Date.now());
}
function nextVideo(room) {
  loadVideo(room, room.queue.shift() || null);
}
function validVideo(video) {
  return video && /^[\w-]{11}$/.test(String(video.videoId || ""));
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ name } = {}, reply = () => {}) => {
    const room = makeRoom();
    const member = { id: socket.id, name: cleanName(name) };
    room.members.set(socket.id, member);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    reply({ ok: true, code: room.code, state: snapshot(room) });
    broadcastRoom(room);
  });

  socket.on("room:join", ({ code, name } = {}, reply = () => {}) => {
    const room = getRoom(code);
    if (!room) return reply({ ok: false, error: "That room does not exist." });
    if (socket.data.roomCode) leaveRoom(socket);
    room.members.set(socket.id, { id: socket.id, name: cleanName(name) });
    socket.join(room.code);
    socket.data.roomCode = room.code;
    reply({ ok: true, code: room.code, state: snapshot(room) });
    broadcastRoom(room);
  });

  // Clients can ping to estimate the offset between their clock and the server's.
  socket.on("time:ping", (reply) => { if (typeof reply === "function") reply(Date.now()); });

  // A user pressed Play or Pause. The server decides; the new state goes to everyone.
  socket.on("playback:request", ({ action } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || !room.currentVideo) return;
    if (sync.requestAction(room.playback, action, Date.now())) broadcastRoom(room);
  });

  // A member's player has finished cueing the current video.
  socket.on("video:ready", ({ loadId } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || loadId !== room.playback.loadId) return;
    sync.markReady(room.playback, socket.id);
    if (maybeStart(room)) broadcastRoom(room);
  });

  socket.on("queue:add", (video) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || !validVideo(video)) return;
    const item = {
      videoId: String(video.videoId),
      title: String(video.title || "YouTube video").slice(0, 180),
      thumbnail: String(video.thumbnail || ""),
      duration: String(video.duration || ""),
      addedBy: room.members.get(socket.id)?.name || "Guest"
    };
    if (!room.currentVideo) loadVideo(room, item);
    else room.queue.push(item);
    broadcastRoom(room);
  });

  socket.on("queue:play", ({ index } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || !Number.isInteger(index) || index < 0 || index >= room.queue.length) return;
    const [selected] = room.queue.splice(index, 1);
    if (room.currentVideo) room.queue.unshift(room.currentVideo);
    loadVideo(room, selected);
    broadcastRoom(room);
  });

  socket.on("queue:remove", ({ index } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || !Number.isInteger(index) || index < 0 || index >= room.queue.length) return;
    room.queue.splice(index, 1);
    broadcastRoom(room);
  });

  // Every client reports the end of a video, but only the first report for the
  // current load counts, so N viewers can never skip N videos.
  socket.on("video:ended", ({ loadId } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || !room.currentVideo) return;
    if (loadId !== room.playback.loadId || room.playback.loading) return;
    nextVideo(room);
    broadcastRoom(room);
  });

  // Skip button. Same dedupe: two people clicking at once skip one video.
  socket.on("video:skip", ({ loadId } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || !room.currentVideo || loadId !== room.playback.loadId) return;
    nextVideo(room);
    broadcastRoom(room);
  });

  socket.on("chat:send", ({ message } = {}) => {
    const room = getRoom(socket.data.roomCode);
    const text = String(message || "").trim().slice(0, 500);
    if (!room || !text) return;
    io.to(room.code).emit("chat:message", {
      name: room.members.get(socket.id)?.name || "Guest",
      message: text, at: Date.now()
    });
  });

  socket.on("disconnect", () => leaveRoom(socket));
});

function cleanName(value) {
  const name = String(value || "Guest").trim().slice(0, 24);
  return name || "Guest";
}
function leaveRoom(socket) {
  const code = socket.data.roomCode;
  const room = getRoom(code);
  if (!room) return;
  room.members.delete(socket.id);
  socket.leave(code);
  socket.data.roomCode = null;
  if (room.members.size === 0) {
    clearTimeout(room.loadTimer);
    rooms.delete(code);
  } else {
    maybeStart(room);
    broadcastRoom(room);
  }
}

app.get("/api/search", async (req, res) => {
  const query = String(req.query.q || "").trim().slice(0, 120);
  if (!query) return res.json({ results: [] });
  try {
    const result = await yts(query);
    const results = (result.videos || []).slice(0, 10).map(v => ({
      videoId: v.videoId,
      title: v.title,
      thumbnail: v.thumbnail,
      duration: v.timestamp || "",
      author: v.author?.name || ""
    })).filter(validVideo);
    res.json({ results });
  } catch (error) {
    console.error("YouTube search failed:", error.message);
    res.status(502).json({ error: "YouTube search is temporarily unavailable. Try again shortly." });
  }
});

server.listen(PORT, () => console.log(`SideBySide running on port ${PORT}`));
