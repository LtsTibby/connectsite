# Talking App (Lightweight Voice Chat MVP)

A lightweight Discord-style voice room MVP:

- Enter `User ID`
- Click `Connect`
- Talk with everyone in the room using WebRTC audio
- See participant mute status in real time

## Stack

- Frontend: React + Vite + DaisyUI
- Signaling: Node + Socket.IO server
- Voice transport: WebRTC mesh (browser to browser)

## Setup

Install dependencies:

```bash
cd client && npm install
cd ../server && npm install
```

## Run

In one terminal (server):

```bash
cd server
npm run dev
```

In a second terminal (client):

```bash
cd client
npm run dev
```

Open two browser tabs at `http://localhost:5173`, click connect in both, and test voice.

## Required Environment Variable (Frontend)

Set this in Vercel (or in `client/.env`):

```bash
VITE_SIGNALING_URL=https://your-voice-server-url
```

The app uses one global room (`global-room`) for everyone.

## Available Scripts

- Root: `npm run dev:client`, `npm run dev:server`, `npm run build`
- Server: `npm run dev`, `npm run build`, `npm start`
- Client: `npm run dev`, `npm run build`, `npm run preview`

## Future Roblox/Proximity Hooks

- Participant types reserve fields for `robloxUserId`, `inGame`, and `position`.
- Proximity gain attenuation can be added client-side per remote stream in a later pass.
