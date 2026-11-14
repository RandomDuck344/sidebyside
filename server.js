const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: true } });

const PORT = process.env.PORT || 3000;
const rooms = new Map();

app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true }));
app.get("*", (_req, res) => res.sendFile(require("path").join(__dirname, "public", "index.html")));

function makeCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}
function cleanName(value) {
  return String(value || "Guest").trim().replace(/[<>]/g, "").slice(0, 24) || "Guest";
}
function validVideoId(value) {
  return /^[a-zA-Z0-9_-]{11}$/.test(String(value || ""));
}
function getRoom(code) {
  return rooms.get(String(code || "").toUpperCase());
}
function publicState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    videoId: room.videoId,
    playing: room.playing,
    position: room.position,
    updatedAt: room.updatedAt,
    queue: room.queue,
    users: [...room.users.values()].map(u => ({ id: u.id, name: u.name }))
  };
}
function touch(room) {
  room.updatedAt = Date.now();
}
function emitState(room) {
  io.to(room.code).emit("room:state", publicState(room));
}
function createRoom(socket, name) {
  let code;
  do { code = makeCode(); } while (rooms.has(code));
  const room = {
    code, hostId: socket.id, videoId: null, playing: false, position: 0,
    updatedAt: Date.now(), queue: [], users: new Map()
  };
  rooms.set(code, room);
  joinRoom(socket, room, name);
  return code;
}
function joinRoom(socket, room, name) {
  for (const oldCode of socket.data.roomsJoined || []) {
    const oldRoom = getRoom(oldCode);
    if (oldRoom) {
      oldRoom.users.delete(socket.id);
      if (oldRoom.hostId === socket.id) oldRoom.hostId = oldRoom.users.keys().next().value || null;
      emitState(oldRoom);
      if (oldRoom.users.size === 0) rooms.delete(oldCode);
    }
    socket.leave(oldCode);
  }
  socket.data.roomsJoined = [room.code];
  socket.join(room.code);
  room.users.set(socket.id, { id: socket.id, name: cleanName(name) });
  if (!room.hostId) room.hostId = socket.id;
  touch(room);
  emitState(room);
  socket.emit("room:joined", publicState(room));
}
function isHost(socket, room) {
  return room && room.hostId === socket.id;
}
function syncFromClient(room, data) {
  room.position = Math.max(0, Number(data.position) || 0);
  room.playing = Boolean(data.playing);
  touch(room);
}

io.on("connection", socket => {
  socket.data.roomsJoined = [];

  socket.on("room:create", ({ name } = {}, ack = () => {}) => {
    const code = createRoom(socket, name);
    ack({ ok: true, code });
  });

  socket.on("room:join", ({ code, name } = {}, ack = () => {}) => {
    const room = getRoom(code);
    if (!room) return ack({ ok: false, error: "That room doesn't exist. Check the invite link." });
    joinRoom(socket, room, name);
    ack({ ok: true, code: room.code });
  });

  socket.on("video:set", ({ videoId } = {}, ack = () => {}) => {
    const room = getRoom(socket.data.roomsJoined[0]);
    if (!room) return ack?.({ ok: false, error: "Join a room first." });
    if (!validVideoId(videoId)) return ack?.({ ok: false, error: "Please enter a valid YouTube video URL or ID." });
    if (!isHost(socket, room)) return ack?.({ ok: false, error: "Only the room host can change the current video." });
    room.videoId = videoId;
    room.position = 0;
    room.playing = false;
    touch(room);
    emitState(room);
    ack?.({ ok: true });
  });

  socket.on("playback:update", ({ position, playing } = {}) => {
    const room = getRoom(socket.data.roomsJoined[0]);
    if (!room || !isHost(socket, room)) return;
    syncFromClient(room, { position, playing });
    socket.to(room.code).emit("playback:sync", {
      position: room.position, playing: room.playing, updatedAt: room.updatedAt
    });
  });

  socket.on("queue:add", ({ videoId, title } = {}, ack = () => {}) => {
    const room = getRoom(socket.data.roomsJoined[0]);
    if (!room) return ack({ ok: false, error: "Join a room first." });
    if (!validVideoId(videoId)) return ack({ ok: false, error: "Invalid YouTube video." });
    if (room.queue.length >= 50) return ack({ ok: false, error: "The queue is full (50 videos)." });
    room.queue.push({ id: crypto.randomUUID(), videoId, title: String(title || "YouTube video").slice(0, 100), addedBy: room.users.get(socket.id)?.name || "Guest" });
    touch(room);
    emitState(room);
    ack({ ok: true });
  });

  socket.on("queue:play", ({ itemId } = {}, ack = () => {}) => {
    const room = getRoom(socket.data.roomsJoined[0]);
    if (!room) return ack({ ok: false, error: "Join a room first." });
    if (!isHost(socket, room)) return ack({ ok: false, error: "Only the host can play queued videos." });
    const index = room.queue.findIndex(item => item.id === itemId);
    if (index < 0) return ack({ ok: false, error: "That queue item is gone." });
    const [item] = room.queue.splice(index, 1);
    room.videoId = item.videoId;
    room.position = 0;
    room.playing = false;
    touch(room);
    emitState(room);
    ack({ ok: true });
  });

  socket.on("queue:remove", ({ itemId } = {}) => {
    const room = getRoom(socket.data.roomsJoined[0]);
    if (!room || !isHost(socket, room)) return;
    room.queue = room.queue.filter(item => item.id !== itemId);
    emitState(room);
  });

  socket.on("chat:send", ({ message } = {}, ack = () => {}) => {
    const room = getRoom(socket.data.roomsJoined[0]);
    if (!room) return ack({ ok: false, error: "Join a room first." });
    const text = String(message || "").trim().slice(0, 500);
    if (!text) return ack({ ok: false, error: "Message can't be empty." });
    const user = room.users.get(socket.id);
    io.to(room.code).emit("chat:message", {
      id: crypto.randomUUID(), name: user?.name || "Guest", message: text, at: Date.now()
    });
    ack({ ok: true });
  });

  socket.on("disconnect", () => {
    for (const code of socket.data.roomsJoined || []) {
      const room = getRoom(code);
      if (!room) continue;
      room.users.delete(socket.id);
      if (room.hostId === socket.id) room.hostId = room.users.keys().next().value || null;
      emitState(room);
      if (room.users.size === 0) rooms.delete(code);
    }
  });
});

server.listen(PORT, () => console.log(`Watch Together running on port ${PORT}`));
