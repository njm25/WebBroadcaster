# WebBroadcaster

A browser-based, multi-device live production studio. The **studio dashboard** runs in desktop Chrome; phones, tablets and other computers on the same network open a page and become **sources**: cameras, microphones and screens. All video and audio stay on your local network.

It runs in one of two ways:

| | **GitHub Pages (hosted)** | **Local server** |
|---|---|---|
| Page served from | `https://<you>.github.io/<repo>/` | your PC (`npm run dev`) |
| HTTPS | real certificate, nothing to install | private CA, installed once per device |
| How devices find each other | encrypted handshake via public MQTT relays | WebSocket hub on your PC |
| Video, audio, controls | direct device-to-device on your LAN | direct device-to-device on your LAN |

```
 iPhone / Android / laptop  ══ WebRTC: media + control channel, LAN only ══▶  Studio (desktop Chrome)
            │                                                                   │
            └── connection setup only: encrypted relay (Pages) or /ws (local) ──┘
```

## GitHub Pages (hosted)

1. Push this repo to GitHub. Under **Settings → Pages**, set **Source: GitHub Actions**. The included workflow (`.github/workflows/deploy-pages.yml`) builds and deploys on every push to `main`.
2. Open `https://<you>.github.io/<repo>/` in desktop Chrome.
3. Click **Connect a device** and scan the QR code with a phone that's on the **same Wi-Fi**.

**Privacy model:**
- **The join link carries the room.** It has a random room id and a 256-bit key after the `#`. Browsers never send that part of a URL to any server, including GitHub.
- **Relays only see scrambled data.** The connection setup (WebRTC offer/answer and local addresses) and small presence heartbeats are encrypted with AES-GCM using that key, then passed through public MQTT brokers (EMQX, HiveMQ, Mosquitto) on a topic name derived from a hash of the room.
- **Media stays on your network.** Video, audio and remote controls never touch the relays. WebRTC runs with no STUN/TURN servers, and both sides drop any connection path that isn't a private-LAN, link-local or mDNS address. Devices on different networks simply can't connect.
- **New room code** (in the Connect dialog) rotates the key and invalidates old links.

Add `?signal=relay` to a local URL to force relay mode, or `?signal=local` to force the local server.

## Local server

Use this if you'd rather not depend on public relays at all.

```bash
npm install
npm run dev          # HTTPS dev server on :4321 (signaling included)
```

The terminal prints the URLs:

- **Studio:** `https://localhost:4321/` on this computer.
- **Phones:** `https://<your-LAN-IP>:4321/source`. In the studio, click **Connect a device** to get a QR code.

### HTTPS and the local certificate authority

HTTPS is required because iOS only allows camera and microphone access on secure pages. On first run the server creates a private **local certificate authority** (`.certs/ca.pem`) and uses it to sign a certificate covering `localhost` and every LAN IP. The server certificate is re-issued automatically when your network changes. Install the CA once per device to get a normal padlock with no "Not secure" warning:

- **This computer:** `npm run trust`. Windows asks you to confirm, then restart the browser. `npm run untrust` removes it.
- **iPhone / iPad:** open `https://<studio-ip>:4321/webbroadcaster-ca.crt` in Safari. The Connect dialog has a QR code for it. Tap *Allow*, then go to Settings → *Profile Downloaded* → Install. Finally, go to Settings → General → About → *Certificate Trust Settings* and enable "WebBroadcaster Local CA".
- **Android:** download the same file, then go to Settings → Security → Encryption & credentials → *Install a certificate → CA certificate*.

Until a device trusts the CA, it shows a one-time warning you can click through.

> Keep `.certs/ca-key.pem` private (it's git-ignored). Anyone holding it could issue certificates that your trusting devices accept. To revoke trust, run `npm run untrust` and remove the profile on your phones. Deleting `.certs/` creates a fresh CA, which then needs reinstalling.

To use a different certificate, set `HTTPS_KEY`/`HTTPS_CERT` to PEM files.

**Access is limited to the local network.** The server drops any connection that doesn't come from this computer or a private LAN address (`192.168.x.x`, `10.x.x.x`, `172.16–31.x.x`). Internet and VPN addresses are refused. Tailscale (`100.64.0.0/10`) is refused too; set `WB_ALLOW_VPN=1` to allow it. Anyone on the *same* network can still open the pages.

Production build: `npm run serve` builds, then runs `server/server.mjs` on `PORT` (default 4321). Pages and the `wss://` signaling socket are served over HTTPS only.

## Features

| Area | What's there |
|---|---|
| Devices | Live roster over WebSocket; per-device WebRTC link state, resolution / fps / bitrate stats, live thumbnails; remote control (camera on/off, flip front/back, mic mute, quality 720p/1080p/4K, disconnect). Devices keep a persistent id, so scenes reconnect automatically. |
| Phone source page | Front/back camera, camera/mic device pickers, quality, voice-processing toggle, mic meter, wake lock, **tally light** (red = on program, green = on preview, REC badge), auto-recovers the camera after backgrounding. Desktop browsers can also share their screen. |
| Desktop sources | Webcams, microphones, entire screen / window / browser tab (with tab audio) via `getUserMedia` / `getDisplayMedia`. Restored on reload when permission is already granted. |
| Scenes | Multiple scenes; items for device video, images, text, color blocks. Move, resize (corners keep aspect; Shift = free), **Alt+drag = crop**, snapping (Ctrl to disable), z-order, visibility, lock, opacity, rounded corners, mirror, fit/fill/stretch, numeric transform & crop. |
| Switching | Hotkeys 1–9; transitions: cut / fade / slide / dip-to-black with duration. **Studio mode**: preview + program side by side, Transition button (or Enter). |
| Audio mixer | Every audio input gets a strip: fader (−∞…+12 dB, double-click = 0 dB), mute, monitor-to-speakers, peak meter with hold, per-channel **sync offset** (delay) for lining up audio with video. Master strip. |
| Recording | Canvas + mixed audio → MediaRecorder. MP4 (H.264/AAC) when supported, WebM fallback. Resolution 720p–4K, 24–60 fps, bitrate presets, pause/resume, optional **write straight to disk** (File System Access API) for long sessions. |

## Architecture

```
server/                (local-server mode only)
  certs.mjs          local CA + server cert generation, network address ranking
  access.mjs         drops connections not from the local network
  signaling.mjs      WebSocket hub: roster, state broadcast, message relay
  integration.mjs    Astro integration: attaches signaling to the dev server
  server.mjs         production HTTPS static server + signaling
src/lib/
  signaling.ts       SignalingLike interface, local WebSocket client, factory
  relay-signaling.ts encrypted signaling over public MQTT brokers (hosted mode)
  mqtt.ts            minimal MQTT 3.1.1-over-WebSocket client
  room.ts            room id/key, join links, local-vs-relay mode selection
  netfilter.ts       local-address checks; strips non-LAN ICE candidates
  peer.ts            PeerLink: perfect-negotiation WebRTC + direct control channel
  protocol.ts, emitter.ts, util.ts, icons.ts
src/source/        phone/source app
src/studio/
  inputs.ts        InputRegistry: every media track (remote or local) with a stable id
  remote.ts        RemoteManager: WebRTC per device → inputs, controls, tally, stats
  local.ts         LocalSources: webcams, mics, screen capture
  scenes.ts        SceneStore: scenes/items model (1920×1080 scene space), persistence
  compositor.ts    canvas renderer + transitions (worker-timed, keeps running in background tabs)
  editor.ts        interactive overlay: select / move / resize / crop
  mixer.ts         Web Audio mixer
  recorder.ts      MediaRecorder wrapper
  docking.ts       Visual Studio-style docking (dockview): drag/tab/float/pop-out panels, saved layout
  ui/              panels (scenes, sources, properties, mixer, devices, controls), menu bar, menus
src/styles/vendor/dockview.css  dockview stylesheet (MIT), vendored: dockview-core ships without it
```

Some design choices:

- Each published track gets its **own MediaStream** on the device, so the studio maps tracks to inputs by `stream.id`. Switching camera or mic uses `RTCRtpSender.replaceTrack`, with no renegotiation and no glitch.
- Input ids are `deviceId:key` (for example `d8f3…:camera`). Scenes reference inputs, not connections, so a phone that drops and rejoins appears in its scenes again by itself.
- Scene coordinates are fixed at 1920×1080. The output resolution is independent of them.
- Signaling (local hub or relays) only carries connection setup; it never touches media. Once a device is connected, controls and tally use a WebRTC data channel, and a live direct connection stays up even if signaling briefly drops.
- LAN-only media is enforced in `src/lib/peer.ts` and `netfilter.ts` (no ICE servers plus candidate filtering). Loosening that would allow connections beyond the LAN, so don't do it casually.

## Roadmap ideas

Streaming output (WHIP/RTMP via a relay), multiview grid, per-source filters (chroma key, color correction via WebGL), audio filters (gate, compressor), stinger transitions, scene collections import/export, remote camera zoom/torch/exposure via `applyConstraints`, multiple studio operators with shared state.
