# SideBySide

A synchronized YouTube watch party. Anyone in a room can search for videos, add them to the queue, play, pause, seek, and skip. The server owns the playback timeline; every browser follows it.

## Deploy on Render

1. Upload the contents of this project to the **root** of your GitHub repository. The `public` folder must sit beside `server.js`.
2. In Render, create or update a Blueprint using the repository's `render.yaml`.
3. Wait for the service to become Live, then open its `onrender.com` URL.

## Local run

Requires Node.js 18 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000.

## Search

The server uses the `yt-search` package to search YouTube without requiring a YouTube Data API key. YouTube can change its search pages or rate-limit requests, so search availability depends on YouTube.

## Notes

- Room state is held in memory. Restarting/redeploying the server clears rooms and queues.
- **Server-authoritative sync.** Browsers never report their own play/pause/position. Each new video is cued at 0:00 on every device; once all devices are ready (or after 10s), the server starts everyone together at a scheduled server time. Clients estimate their clock offset to the server, so the start is aligned even if device clocks differ, and they re-seek if they drift more than ~0.7s.
- Anyone in the room can press Play, Pause or Skip; the server applies the request and tells everyone. Duplicate or racing requests are ignored. The embedded YouTube controls are disabled so a local click can't desync a user. Volume is local.
- If a browser blocks scripted playback, a "Click to join playback" button appears over the video.
- Seeking within a video is not available (it was the main source of desync).
- YouTube may prevent some videos from being embedded. Those videos cannot play in the embedded player.
- This project synchronizes playback position and state; network latency and YouTube's own buffering can still cause small differences.
