# Talking App (Lightweight Voice Chat MVP)

A lightweight Discord-style voice room MVP:

- Enter `User ID`
- Click `Connect`
- Talk with everyone in the room using WebRTC audio
- See participant mute status in real time

## Stack

- Frontend: React + Vite + DaisyUI
- Voice framework: PeerJS public signaling + WebRTC mesh

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

Open two browser tabs at `http://localhost:5173`, click connect in both, and test voice.

The app uses one global room (`global-room`) for everyone.

## Available Scripts

- Root: `npm run dev:client`, `npm run build`
- Client: `npm run dev`, `npm run build`, `npm run preview`

## Future Roblox/Proximity Hooks

- Participant types reserve fields for `robloxUserId`, `inGame`, and `position`.
- Proximity gain attenuation can be added client-side per remote stream in a later pass.
