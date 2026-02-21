# Talking App (Lightweight Voice Chat MVP)

A lightweight Discord-style voice room MVP:

- Enter `User ID` and `Room ID`
- Click `Connect`
- Talk with everyone in the room using WebRTC audio
- See participant mute status in real time

## Stack

- Frontend: React + Vite + DaisyUI
- Backend: Node + Express + Socket.IO (signaling only)
- Voice transport: WebRTC mesh (browser to browser)

## Setup

Install dependencies:

```bash
cd client && npm install
cd ../server && npm install
```

Copy server env:

```bash
cd server
copy .env.example .env
```

## Run

In one terminal:

```bash
cd server
npm run dev
```

In a second terminal:

```bash
cd client
npm run dev
```

Open two browser tabs at `http://localhost:5173`, join the same room, and test voice.

## Available Scripts

- Root: `npm run dev:server`, `npm run dev:client`, `npm run build`
- Server: `npm run dev`, `npm run build`, `npm start`
- Client: `npm run dev`, `npm run build`, `npm run preview`

## Future Roblox/Proximity Hooks

- `server/src/signaling.ts` includes `canTalk(userId, roomId)` for future game-gated voice checks.
- Participant types reserve fields for `robloxUserId`, `inGame`, and `position`.
- Proximity gain attenuation can be added client-side per remote stream in a later pass.
