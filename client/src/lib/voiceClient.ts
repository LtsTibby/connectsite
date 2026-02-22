import Peer, { type DataConnection, type MediaConnection } from "peerjs";
import type { ConnectArgs, ConnectionStatus, Participant } from "../types/voice";

type VoiceClientOptions = {
  onStatus: (status: ConnectionStatus) => void;
  onParticipants: (participants: Participant[]) => void;
  onRemoteStream: (socketId: string, stream: MediaStream) => void;
  onPeerDisconnected: (socketId: string) => void;
  onError: (message: string) => void;
};

type HostMessage =
  | { type: "join-request"; peerId: string; userId: string }
  | { type: "leave-request"; peerId: string }
  | { type: "mute-update"; peerId: string; muted: boolean }
  | { type: "participant-list"; participants: Participant[] }
  | { type: "host-closing" };

const ROOM_ID = "global-room";

function toHostPeerId(): string {
  return `room-${ROOM_ID}`;
}

export class VoiceClient {
  private readonly options: VoiceClientOptions;

  private peer: Peer | null = null;

  private localStream: MediaStream | null = null;

  private calls = new Map<string, MediaConnection>();

  private hostConnections = new Map<string, DataConnection>();

  private hostControlConnection: DataConnection | null = null;

  private selfPeerId: string | null = null;

  private isHost = false;

  private remoteStreams = new Map<string, MediaStream>();

  private participants = new Map<string, Participant>();

  private status: ConnectionStatus = "Disconnected";

  constructor(options: VoiceClientOptions) {
    this.options = options;
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  async connect(args: ConnectArgs): Promise<void> {
    if (this.peer || this.status !== "Disconnected") {
      return;
    }
    this.setStatus("Connecting");

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch {
      this.options.onError("Microphone permission was denied.");
      this.setStatus("Disconnected");
      return;
    }

    let becameHost = await this.tryBecomeHost(args.userId.trim());
    if (!becameHost) {
      const joined = await this.joinAsClient(args.userId.trim());
      if (!joined) {
        // Retry host claim once in case first election raced.
        becameHost = await this.tryBecomeHost(args.userId.trim());
      }
    }

    if (becameHost || this.hostControlConnection) {
      this.setStatus("Connected");
      return;
    }

    this.options.onError("Could not connect to voice network.");
    this.disconnect();
  }

  disconnect(): void {
    if (!this.isHost && this.hostControlConnection?.open && this.selfPeerId) {
      this.hostControlConnection.send({
        type: "leave-request",
        peerId: this.selfPeerId,
      } satisfies HostMessage);
    }

    if (this.isHost) {
      for (const conn of this.hostConnections.values()) {
        if (conn.open) {
          conn.send({ type: "host-closing" } satisfies HostMessage);
        }
        conn.close();
      }
    }

    this.hostControlConnection?.close();
    this.hostControlConnection = null;
    this.hostConnections.clear();
    this.peer?.destroy();
    this.peer = null;
    this.selfPeerId = null;
    this.isHost = false;
    this.cleanupCalls();
    this.cleanupLocalStream();
    this.participants.clear();
    this.options.onParticipants([]);
    this.setStatus("Disconnected");
  }

  setMuted(muted: boolean): void {
    if (!this.localStream) {
      return;
    }
    for (const track of this.localStream.getAudioTracks()) {
      track.enabled = !muted;
    }
    if (!this.selfPeerId) {
      return;
    }

    if (this.isHost) {
      const self = this.participants.get(this.selfPeerId);
      if (self) {
        self.muted = muted;
        this.broadcastParticipantList();
      }
      return;
    }

    if (this.hostControlConnection?.open) {
      this.hostControlConnection.send({
        type: "mute-update",
        peerId: this.selfPeerId,
        muted,
      } satisfies HostMessage);
    }
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.options.onStatus(status);
  }

  private async tryBecomeHost(userId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const hostPeer = new Peer(toHostPeerId(), { debug: 0 });
      let settled = false;

      const finish = (ok: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(ok);
      };

      hostPeer.on("open", (peerId) => {
        this.peer = hostPeer;
        this.selfPeerId = peerId;
        this.isHost = true;
        this.setupCommonPeerHandlers(hostPeer);
        this.setupHostHandlers(hostPeer);
        this.participants.set(peerId, { socketId: peerId, userId, muted: false });
        this.broadcastParticipantList();
        finish(true);
      });

      hostPeer.on("error", (error: unknown) => {
        const message = String((error as { type?: string; message?: string })?.type ?? "");
        const fallback = String((error as { message?: string })?.message ?? "");
        if (message.includes("unavailable-id") || fallback.includes("unavailable-id")) {
          hostPeer.destroy();
          finish(false);
          return;
        }
        hostPeer.destroy();
        finish(false);
      });

      setTimeout(() => {
        hostPeer.destroy();
        finish(false);
      }, 3000);
    });
  }

  private async joinAsClient(userId: string): Promise<boolean> {
    this.peer = new Peer({ debug: 0 });
    const peer = this.peer;

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("PEER_OPEN_TIMEOUT")), 5000);
        peer.on("open", (peerId) => {
          clearTimeout(timeout);
          this.selfPeerId = peerId;
          this.setupCommonPeerHandlers(peer);
          resolve();
        });
        peer.on("error", () => {
          clearTimeout(timeout);
          reject(new Error("PEER_OPEN_FAILED"));
        });
      });
    } catch {
      peer.destroy();
      this.peer = null;
      return false;
    }

    if (!this.selfPeerId) {
      peer.destroy();
      this.peer = null;
      return false;
    }

    const control = peer.connect(toHostPeerId(), { reliable: true });
    this.hostControlConnection = control;
    const selfPeerId = this.selfPeerId;

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("HOST_CONNECT_TIMEOUT")), 5000);
        control.on("open", () => {
          clearTimeout(timeout);
          control.send({
            type: "join-request",
            peerId: selfPeerId,
            userId,
          } satisfies HostMessage);
          resolve();
        });
        control.on("error", () => {
          clearTimeout(timeout);
          reject(new Error("HOST_CONNECT_FAILED"));
        });
      });
    } catch {
      control.close();
      peer.destroy();
      this.hostControlConnection = null;
      this.peer = null;
      this.selfPeerId = null;
      return false;
    }

    control.on("close", () => {
      this.options.onError("Room host disconnected.");
      this.disconnect();
    });
    control.on("data", (raw) => this.handleHostMessage(raw as HostMessage));
    return true;
  }

  private setupCommonPeerHandlers(peer: Peer): void {
    peer.on("call", (call) => {
      if (!this.localStream) {
        call.close();
        return;
      }
      call.answer(this.localStream);
      this.attachCall(call);
    });
    peer.on("error", () => {
      this.options.onError("Voice network error occurred.");
    });
  }

  private setupHostHandlers(peer: Peer): void {
    peer.on("connection", (conn) => {
      conn.on("data", (raw) => {
        const msg = raw as HostMessage;
        if (msg.type === "join-request") {
          this.hostConnections.set(msg.peerId, conn);
          this.participants.set(msg.peerId, {
            socketId: msg.peerId,
            userId: msg.userId,
            muted: false,
          });
          this.broadcastParticipantList();
        } else if (msg.type === "leave-request") {
          this.removeParticipant(msg.peerId);
          this.broadcastParticipantList();
        } else if (msg.type === "mute-update") {
          const participant = this.participants.get(msg.peerId);
          if (participant) {
            participant.muted = msg.muted;
            this.broadcastParticipantList();
          }
        }
      });

      conn.on("close", () => {
        const peerId = this.getPeerIdByConnection(conn);
        if (peerId) {
          this.removeParticipant(peerId);
          this.broadcastParticipantList();
        }
      });
    });

    peer.on("disconnected", () => this.disconnect());
  }

  private handleHostMessage(message: HostMessage): void {
    if (message.type === "host-closing") {
      this.options.onError("Room host disconnected.");
      this.disconnect();
      return;
    }
    if (message.type !== "participant-list") {
      return;
    }

    this.participants = new Map(
      message.participants.map((participant) => [participant.socketId, participant])
    );
    this.options.onParticipants(message.participants);
    this.reconcileCalls(message.participants);
  }

  private reconcileCalls(participants: Participant[]): void {
    if (!this.peer || !this.localStream || !this.selfPeerId) {
      return;
    }

    const present = new Set(participants.map((participant) => participant.socketId));
    for (const peerId of Array.from(this.calls.keys())) {
      if (!present.has(peerId)) {
        this.removeCall(peerId);
      }
    }

    for (const participant of participants) {
      if (participant.socketId === this.selfPeerId) {
        continue;
      }
      if (this.calls.has(participant.socketId)) {
        continue;
      }
      if (this.selfPeerId.localeCompare(participant.socketId) <= 0) {
        continue;
      }
      const call = this.peer.call(participant.socketId, this.localStream);
      if (call) {
        this.attachCall(call);
      }
    }
  }

  private attachCall(call: MediaConnection): void {
    const peerId = call.peer;
    this.calls.set(peerId, call);

    call.on("stream", (stream) => {
      this.remoteStreams.set(peerId, stream);
      this.options.onRemoteStream(peerId, stream);
    });

    const clear = () => this.removeCall(peerId);
    call.on("close", clear);
    call.on("error", clear);
  }

  private removeCall(peerId: string): void {
    const call = this.calls.get(peerId);
    if (call) {
      call.close();
      this.calls.delete(peerId);
    }

    const stream = this.remoteStreams.get(peerId);
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      this.remoteStreams.delete(peerId);
    }

    this.options.onPeerDisconnected(peerId);
  }

  private cleanupCalls(): void {
    for (const peerId of Array.from(this.calls.keys())) {
      this.removeCall(peerId);
    }
  }

  private cleanupLocalStream(): void {
    if (!this.localStream) {
      return;
    }
    this.localStream.getTracks().forEach((track) => track.stop());
    this.localStream = null;
  }

  private removeParticipant(peerId: string): void {
    this.participants.delete(peerId);
    this.hostConnections.delete(peerId);
    this.removeCall(peerId);
  }

  private getPeerIdByConnection(connection: DataConnection): string | null {
    for (const [peerId, conn] of this.hostConnections.entries()) {
      if (conn === connection) {
        return peerId;
      }
    }
    return null;
  }

  private broadcastParticipantList(): void {
    const participants = Array.from(this.participants.values());
    this.options.onParticipants(participants);
    this.reconcileCalls(participants);

    const payload: HostMessage = { type: "participant-list", participants };
    for (const conn of this.hostConnections.values()) {
      if (conn.open) {
        conn.send(payload);
      }
    }
  }

}
