# Talking App (Lightweight Voice Chat MVP)

A lightweight Discord-style voice room MVP:

- Enter `User ID` and `Room ID`
- Click `Connect`
- Talk with everyone in the room using WebRTC audio
- See participant mute status in real time

## Stack

- Frontend: React + Vite + DaisyUI
- Voice framework: Agora Web SDK (managed signaling/media)

## Setup

Install dependencies:

```bash
cd client && npm install
```

## Run

In one terminal:

```bash
cd client
npm run dev
```

Open two browser tabs at `http://localhost:5173`, join the same room, and test voice.

## Required Environment Variable

Set this in Vercel (and optionally in `client/.env` for local dev):

```bash
VITE_AGORA_APP_ID=your_agora_app_id
```

The app uses one global room (`global-room`) for everyone.

## Available Scripts

- Root: `npm run dev:client`, `npm run build`
- Client: `npm run dev`, `npm run build`, `npm run preview`

## Future Roblox/Proximity Hooks

- Participant types reserve fields for `robloxUserId`, `inGame`, and `position`.
- Proximity gain attenuation can be added client-side per remote stream in a later pass.
