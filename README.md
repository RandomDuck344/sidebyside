# SideBySide

A synchronized YouTube watch party. Anyone in a room can search for videos, add them to the queue, play, pause, seek, and skip. Playback changes are broadcast to everyone and periodically reconciled against the server's shared state.

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
- Anyone in the room can control playback. The most recent accepted action wins.
- YouTube may prevent some videos from being embedded. Those videos cannot play in the embedded player.
- This project synchronizes playback position and state; network latency and YouTube's own buffering can still cause small differences.
