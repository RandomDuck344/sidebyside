"use strict";
// Server-authoritative playback timeline for one room.
//
// The server owns the clock. A room's playback is described by:
//   position - seconds into the video at the moment `anchor`
//   anchor   - server time (ms) that `position` refers to. It may be in the
//              future, meaning "start/resume at that instant".
//   playing  - whether the timeline is advancing from `anchor`
//   loading  - a new video was chosen; waiting for every member's player to be
//              cued before starting everyone together at 0:00
//   loadId   - increments every time a video is loaded, so stale messages
//              (late "ended", double "skip") can be recognised and ignored.
// Clients never report their own play/pause/seek; they only follow this state.

const START_DELAY_MS = 800;   // lead time so every client can schedule the start
const RESUME_DELAY_MS = 400;  // same, for resuming after a pause
const READY_TIMEOUT_MS = 10000; // don't let one stuck player block the room forever

function newPlayback() {
  return { loadId: 0, loading: false, playing: false, position: 0, anchor: 0, ready: new Set() };
}

function positionAt(pb, now) {
  if (!pb.playing) return pb.position;
  return pb.position + Math.max(0, (now - pb.anchor) / 1000);
}

// Choose a new video (or none). Everyone restarts from 0:00 once all are ready.
function beginLoad(pb, hasVideo, now) {
  pb.loadId += 1;
  pb.ready = new Set();
  pb.position = 0;
  pb.anchor = now;
  pb.playing = false;
  pb.loading = Boolean(hasVideo);
  return pb.loadId;
}

function markReady(pb, memberId) {
  if (pb.loading) pb.ready.add(memberId);
}

function allReady(pb, memberIds) {
  return pb.loading && memberIds.length > 0 && memberIds.every((id) => pb.ready.has(id));
}

// Leave the loading phase and start everyone at 0:00 at a shared future instant.
function startPlayback(pb, now) {
  if (!pb.loading) return false;
  pb.loading = false;
  pb.playing = true;
  pb.position = 0;
  pb.anchor = now + START_DELAY_MS;
  return true;
}

// A user pressed Play or Pause. Returns true only if the state actually changed,
// so duplicate or racing requests are harmless.
function requestAction(pb, action, now) {
  if (pb.loading) return false;
  if (action === "pause" && pb.playing) {
    pb.position = positionAt(pb, now);
    pb.anchor = now;
    pb.playing = false;
    return true;
  }
  if (action === "play" && !pb.playing) {
    pb.anchor = now + RESUME_DELAY_MS;
    pb.playing = true;
    return true;
  }
  return false;
}

function toClient(pb) {
  return {
    loadId: pb.loadId,
    loading: pb.loading,
    playing: pb.playing,
    position: pb.position,
    anchor: pb.anchor
  };
}

module.exports = {
  START_DELAY_MS, RESUME_DELAY_MS, READY_TIMEOUT_MS,
  newPlayback, positionAt, beginLoad, markReady, allReady, startPlayback, requestAction, toClient
};
