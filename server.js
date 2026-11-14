const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const yts = require("yt-search");
const crypto = require("crypto");

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
    playing: false, position: 0, updatedAt: Date.now()
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
    playback: {
      playing: room.playing,
      position: room.position,
      updatedAt: room.updatedAt
    }
  };
}
function currentPosition(room) {
  if (!room.playing) return room.position;
  return room.position + Math.max(0, (Date.now() - room.updatedAt) / 1000);
}
function broadcastRoom(room) {
  io.to(room.code).emit("room:state", snapshot(room));
}
function setPlayback(room, { playing, position }) {
  const now = Date.now();
  const current = currentPosition(room);
  room.position = Number.isFinite(Number(position)) ? Math.max(0, Number(position)) : current;
  room.playing = Boolean(playing);
  room.updatedAt = now;
}
function nextVideo(room) {
  room.currentVideo = room.queue.shift() || null;
  room.position = 0;
  room.playing = Boolean(room.currentVideo);
  room.updatedAt = Date.now();
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

  socket.on("playback:control", ({ action, position } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || !room.currentVideo) return;
    const current = currentPosition(room);
    if (action === "play") setPlayback(room, { playing: true, position: Number.isFinite(Number(position)) ? Number(position) : current });
    else if (action === "pause") setPlayback(room, { playing: false, position: Number.isFinite(Number(position)) ? Number(position) : current });
    else if (action === "seek") setPlayback(room, { playing: room.playing, position });
    else return;
    io.to(room.code).emit("playback:sync", {
      playing: room.playing, position: room.position, updatedAt: room.updatedAt,
      by: socket.id, action
    });
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
    if (!room.currentVideo) {
      room.currentVideo = item;
      room.position = 0;
      room.playing = true;
      room.updatedAt = Date.now();
      io.to(room.code).emit("video:load", { video: item, autoplay: true });
    } else {
      room.queue.push(item);
    }
    broadcastRoom(room);
  });

  socket.on("queue:play", ({ index } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || !Number.isInteger(index) || index < 0 || index >= room.queue.length) return;
    const [selected] = room.queue.splice(index, 1);
    if (room.currentVideo) room.queue.unshift(room.currentVideo);
    room.currentVideo = selected;
    room.position = 0;
    room.playing = true;
    room.updatedAt = Date.now();
    io.to(room.code).emit("video:load", { video: selected, autoplay: true });
    broadcastRoom(room);
  });

  socket.on("queue:remove", ({ index } = {}) => {
    const room = getRoom(socket.data.roomCode);
    if (!room || !Number.isInteger(index) || index < 0 || index >= room.queue.length) return;
    room.queue.splice(index, 1);
    broadcastRoom(room);
  });

  socket.on("video:ended", () => {
    const room = getRoom(socket.data.roomCode);
    if (!room) return;
    nextVideo(room);
    io.to(room.code).emit("video:load", { video: room.currentVideo, autoplay: Boolean(room.currentVideo) });
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
  if (room.members.size === 0) rooms.delete(code);
  else broadcastRoom(room);
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
