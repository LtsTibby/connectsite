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

function toRoomHostId(roomId: string): string {
  const normalized = roomId
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]/g, "-")
    .slice(0, 36);
  return `room-${normalized || "global"}`;
}

export class VoiceClient {
  private readonly options: VoiceClientOptions;

  private peer: Peer | null = null;

  private localStream: MediaStream | null = null;

  private calls = new Map<string, MediaConnection>();

  private hostConnections = new Map<string, DataConnection>();

  private hostControlConnection: DataConnection | null = null;

  private participants = new Map<string, Participant>();

  private selfPeerId: string | null = null;

  private roomHostId: string | null = null;

  private isHost = false;

  private remoteStreams = new Map<string, MediaStream>();

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
    this.roomHostId = toRoomHostId(args.roomId);

    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (_error) {
      this.options.onError("Microphone permission was denied.");
      this.setStatus("Disconnected");
      return;
    }

    const becameHost = await this.tryBecomeHost(this.roomHostId, args.userId);
    if (becameHost) {
      this.setStatus("Connected");
      return;
    }

    await this.joinAsClient(args.userId);
    this.setStatus("Connected");
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

    this.hostConnections.clear();
    this.hostControlConnection?.close();
    this.hostControlConnection = null;
    this.peer?.destroy();
    this.peer = null;
    this.selfPeerId = null;
    this.roomHostId = null;
    this.isHost = false;
    this.participants.clear();
    this.cleanupLocalStream();
    this.cleanupCalls();
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
      const selfParticipant = this.participants.get(this.selfPeerId);
      if (selfParticipant) {
        selfParticipant.muted = muted;
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

  private async tryBecomeHost(hostPeerId: string, userId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const hostPeer = new Peer(hostPeerId, { debug: 0 });
      let settled = false;

      const finalize = (result: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        resolve(result);
      };

      hostPeer.on("open", (peerId) => {
        this.isHost = true;
        this.peer = hostPeer;
        this.selfPeerId = peerId;
        this.setupCommonPeerHandlers(hostPeer);
        this.setupHostHandlers(hostPeer);
        this.participants.set(peerId, { socketId: peerId, userId, muted: false });
        this.broadcastParticipantList();
        finalize(true);
      });

      hostPeer.on("error", (error: unknown) => {
        const message = String((error as { type?: string })?.type ?? "");
        if (message === "unavailable-id") {
          hostPeer.destroy();
          finalize(false);
          return;
        }
        this.options.onError("Failed connecting to voice network.");
        hostPeer.destroy();
        this.disconnect();
        finalize(false);
      });

      setTimeout(() => finalize(false), 3000);
    });
  }

  private async joinAsClient(userId: string): Promise<void> {
    this.peer = new Peer({ debug: 0 });
    const peer = this.peer;

    await new Promise<void>((resolve, reject) => {
      peer.on("open", (peerId) => {
        this.selfPeerId = peerId;
        this.setupCommonPeerHandlers(peer);
        resolve();
      });
      peer.on("error", () => reject(new Error("PEER_OPEN_FAILED")));
    });

    if (!this.roomHostId || !this.selfPeerId) {
      throw new Error("ROOM_OR_PEER_MISSING");
    }

    const control = peer.connect(this.roomHostId, { reliable: true });
    this.hostControlConnection = control;

    const selfPeerId = this.selfPeerId;
    await new Promise<void>((resolve, reject) => {
      control.on("open", () => {
        control.send({
          type: "join-request",
          peerId: selfPeerId,
          userId,
        } satisfies HostMessage);
        resolve();
      });
      control.on("error", () => reject(new Error("HOST_CONNECT_FAILED")));
      control.on("close", () => {
        this.options.onError("Room host disconnected.");
        this.disconnect();
      });
    });

    control.on("data", (raw) => {
      this.handleHostMessage(raw as HostMessage);
    });
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
        const data = raw as HostMessage;
        if (data.type === "join-request") {
          this.hostConnections.set(data.peerId, conn);
          this.participants.set(data.peerId, {
            socketId: data.peerId,
            userId: data.userId,
            muted: false,
          });
          this.broadcastParticipantList();
        } else if (data.type === "leave-request") {
          this.removeParticipant(data.peerId);
          this.broadcastParticipantList();
        } else if (data.type === "mute-update") {
          const participant = this.participants.get(data.peerId);
          if (participant) {
            participant.muted = data.muted;
            this.broadcastParticipantList();
          }
        }
      });

      conn.on("close", () => {
        const leavingPeerId = this.getPeerIdByConnection(conn);
        if (leavingPeerId) {
          this.removeParticipant(leavingPeerId);
          this.broadcastParticipantList();
        }
      });
    });

    peer.on("disconnected", () => {
      this.options.onError("Disconnected from voice network.");
      this.disconnect();
    });
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

    const incoming = message.participants;
    this.participants = new Map(incoming.map((participant) => [participant.socketId, participant]));
    this.options.onParticipants(incoming);
    this.reconcileCalls(incoming);
  }

  private reconcileCalls(participants: Participant[]): void {
    if (!this.peer || !this.localStream || !this.selfPeerId) {
      return;
    }

    const allPeerIds = new Set(participants.map((participant) => participant.socketId));
    for (const peerId of Array.from(this.calls.keys())) {
      if (!allPeerIds.has(peerId)) {
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
    const list = Array.from(this.participants.values());
    this.options.onParticipants(list);
    this.reconcileCalls(list);

    const payload: HostMessage = {
      type: "participant-list",
      participants: list,
    };

    for (const conn of this.hostConnections.values()) {
      if (conn.open) {
        conn.send(payload);
      }
    }
  }
}
