# SideBySide — YouTube Watch Together

A deployable, real-time YouTube watch-party web app built with Node.js, Express, and Socket.IO.

## Features

- Create rooms with short invite codes and shareable links
- Synchronized YouTube playback controlled by the room host
- Live room chat
- Shared video queue (guests can add; host can play queued videos)
- Participant list and automatic host handoff
- Responsive dark interface
- Render deployment configuration included

## Run locally

Requires Node.js 20 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000 in your browser. Open a second browser or an incognito window to test joining a room.

## Deploy to Render

1. Create a GitHub repository and upload the contents of this folder.
2. Sign in to Render and choose **New → Blueprint**.
3. Connect the repository. Render will detect `render.yaml`.
4. Deploy the `sidebyside-watch-party` web service.
5. Open the URL Render gives you and create a room.

No API key or database is required for this first version.

## Important notes

- This app embeds videos using the official YouTube IFrame Player API. It does not download, proxy, or rebroadcast video.
- Some YouTube videos disable embedding and will not play here.
- The initial version stores rooms in server memory. Restarting or redeploying the server clears rooms. For production with persistent rooms, multiple server instances, or high traffic, add Redis (Socket.IO adapter) and a persistent store.
- Playback is host-controlled. Guests can add videos to the queue, but only the host can change the current video or play queued items.
- The app is a starter implementation, not a hardened public service. Before a large public launch, add rate limiting, abuse reporting/moderation, stronger room lifecycle handling, and persistent infrastructure.
- YouTube's player controls and terms apply. Do not represent this app as affiliated with YouTube or Google.
