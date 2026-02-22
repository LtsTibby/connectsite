import type { Server, Socket } from "socket.io";
import type { JoinRoomPayload, Participant, SessionData } from "./types.js";

type RoomMap = Map<string, Map<string, Participant>>;
type SessionDescriptionPayload = Record<string, unknown>;
type IceCandidatePayload = Record<string, unknown>;

const rooms: RoomMap = new Map();
const sessions: Map<string, SessionData> = new Map();
const GLOBAL_ROOM_ID = "global-room";

function getRoomParticipants(roomId: string): Participant[] {
  const room = rooms.get(roomId);
  if (!room) {
    return [];
  }
  return Array.from(room.values());
}

function canTalk(_userId: string, _roomId: string): boolean {
  return true;
}

function broadcastParticipantUpdate(io: Server, roomId: string): void {
  io.to(roomId).emit("participant-update", {
    roomId,
    participants: getRoomParticipants(roomId),
  });
}

function removeSocketFromRoom(io: Server, socket: Socket): void {
  const session = sessions.get(socket.id);
  if (!session) {
    return;
  }

  const room = rooms.get(session.roomId);
  if (room) {
    room.delete(socket.id);
    if (room.size === 0) {
      rooms.delete(session.roomId);
    }
  }

  io.to(session.roomId).emit("peer-left", { socketId: socket.id });
  socket.leave(session.roomId);
  sessions.delete(socket.id);
  broadcastParticipantUpdate(io, session.roomId);
}

export function registerSignalingHandlers(io: Server): void {
  io.on("connection", (socket) => {
    socket.on("join-room", (payload: JoinRoomPayload) => {
      const roomId = GLOBAL_ROOM_ID;
      const userId = payload.userId?.trim();

      if (!userId) {
        socket.emit("voice-error", {
          code: "INVALID_JOIN",
          message: "userId is required.",
        });
        return;
      }

      if (!canTalk(userId, roomId)) {
        socket.emit("voice-error", {
          code: "FORBIDDEN",
          message: "You are not allowed to talk in this room.",
        });
        return;
      }

      removeSocketFromRoom(io, socket);

      const room = rooms.get(roomId) ?? new Map<string, Participant>();
      rooms.set(roomId, room);

      room.set(socket.id, {
        socketId: socket.id,
        userId,
        muted: false,
      });

      sessions.set(socket.id, { roomId, userId, muted: false });
      socket.join(roomId);

      const existingParticipants = getRoomParticipants(roomId).filter(
        (participant) => participant.socketId !== socket.id
      );

      socket.emit("joined-room", {
        roomId,
        selfSocketId: socket.id,
        participants: existingParticipants,
      });

      socket.to(roomId).emit("participant-joined", {
        socketId: socket.id,
        userId,
      });

      broadcastParticipantUpdate(io, roomId);
    });

    socket.on("leave-room", () => {
      removeSocketFromRoom(io, socket);
    });

    socket.on("set-muted", (payload: { muted: boolean }) => {
      const session = sessions.get(socket.id);
      if (!session) {
        return;
      }

      const room = rooms.get(session.roomId);
      if (!room) {
        return;
      }

      const participant = room.get(socket.id);
      if (!participant) {
        return;
      }

      participant.muted = Boolean(payload?.muted);
      session.muted = participant.muted;
      broadcastParticipantUpdate(io, session.roomId);
    });

    socket.on(
      "offer",
      (payload: { to: string; sdp: SessionDescriptionPayload }) => {
        const session = sessions.get(socket.id);
        if (!session) {
          return;
        }

        io.to(payload.to).emit("offer", {
          from: socket.id,
          userId: session.userId,
          sdp: payload.sdp,
        });
      }
    );

    socket.on(
      "answer",
      (payload: { to: string; sdp: SessionDescriptionPayload }) => {
        const session = sessions.get(socket.id);
        if (!session) {
          return;
        }

        io.to(payload.to).emit("answer", {
          from: socket.id,
          userId: session.userId,
          sdp: payload.sdp,
        });
      }
    );

    socket.on(
      "ice-candidate",
      (payload: { to: string; candidate: IceCandidatePayload }) => {
        const session = sessions.get(socket.id);
        if (!session) {
          return;
        }

        io.to(payload.to).emit("ice-candidate", {
          from: socket.id,
          userId: session.userId,
          candidate: payload.candidate,
        });
      }
    );

    socket.on("disconnect", () => {
      removeSocketFromRoom(io, socket);
    });
  });
}
