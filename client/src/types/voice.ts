export type ConnectionStatus = "Disconnected" | "Connecting" | "Connected";

export type Participant = {
  socketId: string;
  userId: string;
  muted: boolean;
  robloxUserId?: number;
  inGame?: boolean;
  position?: { x: number; y: number; z: number };
};

export type ConnectArgs = {
  userId: string;
};
