export type Participant = {
  socketId: string;
  userId: string;
  muted: boolean;
  robloxUserId?: number;
  inGame?: boolean;
  position?: { x: number; y: number; z: number };
};

export type JoinRoomPayload = {
  roomId: string;
  userId: string;
};

export type SessionData = {
  roomId: string;
  userId: string;
  muted: boolean;
};
