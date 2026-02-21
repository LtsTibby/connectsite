import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import http from "http";
import { Server } from "socket.io";
import { registerSignalingHandlers } from "./signaling.js";

dotenv.config();

const app = express();
const server = http.createServer(app);

const port = Number(process.env.PORT ?? 4000);
const clientOrigin = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";

app.use(cors({ origin: clientOrigin }));
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const io = new Server(server, {
  cors: {
    origin: clientOrigin,
    methods: ["GET", "POST"],
  },
});

registerSignalingHandlers(io);

server.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Signaling server listening on http://localhost:${port}`);
});
