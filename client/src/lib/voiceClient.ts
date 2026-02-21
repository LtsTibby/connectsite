import { io, type Socket } from "socket.io-client";
import type { ConnectArgs, ConnectionStatus, Participant } from "../types/voice";

type VoiceClientOptions = {
  signalingUrl: string;
  onStatus: (status: ConnectionStatus) => void;
  onParticipants: (participants: Participant[]) => void;
  onRemoteStream: (socketId: string, stream: MediaStream) => void;
  onPeerDisconnected: (socketId: string) => void;
  onError: (message: string) => void;
};

const rtcConfig: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
};

export class VoiceClient {
  private readonly options: VoiceClientOptions;

  private socket: Socket | null = null;

  private localStream: MediaStream | null = null;

  private peers = new Map<string, RTCPeerConnection>();

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
    if (this.socket || this.status !== "Disconnected") {
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
    } catch (_error) {
      this.options.onError("Microphone permission was denied.");
      this.setStatus("Disconnected");
      return;
    }

    const socket = io(this.options.signalingUrl, {
      transports: ["websocket"],
      autoConnect: true,
    });

    this.socket = socket;

    socket.on("connect", () => {
      socket.emit("join-room", args);
    });

    socket.on(
      "joined-room",
      async (payload: { participants: Array<{ socketId: string }> }) => {
        this.setStatus("Connected");
        for (const participant of payload.participants) {
          await this.createOfferForPeer(participant.socketId);
        }
      }
    );

    socket.on("participant-joined", (_payload: { socketId: string }) => {
      this.setStatus("Connected");
    });

    socket.on(
      "participant-update",
      (payload: { participants: Participant[]; roomId: string }) => {
        this.options.onParticipants(payload.participants);
      }
    );

    socket.on(
      "offer",
      async (payload: { from: string; sdp: RTCSessionDescriptionInit }) => {
        try {
          const peer = this.getOrCreatePeer(payload.from);
          await peer.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          socket.emit("answer", { to: payload.from, sdp: answer });
          this.setStatus("Connected");
        } catch (_error) {
          this.options.onError("Failed to answer a peer connection.");
        }
      }
    );

    socket.on(
      "answer",
      async (payload: { from: string; sdp: RTCSessionDescriptionInit }) => {
        try {
          const peer = this.peers.get(payload.from);
          if (!peer) {
            return;
          }
          await peer.setRemoteDescription(new RTCSessionDescription(payload.sdp));
          this.setStatus("Connected");
        } catch (_error) {
          this.options.onError("Failed to finalize a peer connection.");
        }
      }
    );

    socket.on(
      "ice-candidate",
      async (payload: { from: string; candidate: RTCIceCandidateInit }) => {
        const peer = this.peers.get(payload.from);
        if (!peer) {
          return;
        }
        try {
          await peer.addIceCandidate(new RTCIceCandidate(payload.candidate));
        } catch (_error) {
          this.options.onError("Failed to add ICE candidate.");
        }
      }
    );

    socket.on("peer-left", (payload: { socketId: string }) => {
      this.removePeer(payload.socketId);
    });

    socket.on("voice-error", (payload: { message: string }) => {
      this.options.onError(payload?.message ?? "Unknown voice server error.");
    });

    socket.on("disconnect", () => {
      this.cleanupLocalStream();
      this.cleanupPeers();
      this.options.onParticipants([]);
      this.setStatus("Disconnected");
    });

    socket.on("connect_error", () => {
      this.options.onError("Could not connect to signaling server.");
      this.disconnect();
    });
  }

  disconnect(): void {
    this.socket?.emit("leave-room");
    this.socket?.disconnect();
    this.socket = null;
    this.cleanupLocalStream();
    this.cleanupPeers();
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
    this.socket?.emit("set-muted", { muted });
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.options.onStatus(status);
  }

  private async createOfferForPeer(socketId: string): Promise<void> {
    if (!this.socket) {
      return;
    }
    try {
      const peer = this.getOrCreatePeer(socketId);
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      this.socket.emit("offer", { to: socketId, sdp: offer });
    } catch (_error) {
      this.options.onError("Failed to create offer for remote peer.");
    }
  }

  private getOrCreatePeer(socketId: string): RTCPeerConnection {
    const existing = this.peers.get(socketId);
    if (existing) {
      return existing;
    }

    const peer = new RTCPeerConnection(rtcConfig);

    this.localStream?.getTracks().forEach((track) => {
      peer.addTrack(track, this.localStream as MediaStream);
    });

    peer.onicecandidate = (event) => {
      if (event.candidate && this.socket) {
        this.socket.emit("ice-candidate", {
          to: socketId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    peer.ontrack = (event) => {
      const [stream] = event.streams;
      if (!stream) {
        return;
      }
      this.remoteStreams.set(socketId, stream);
      this.options.onRemoteStream(socketId, stream);
    };

    peer.onconnectionstatechange = () => {
      if (
        peer.connectionState === "failed" ||
        peer.connectionState === "closed" ||
        peer.connectionState === "disconnected"
      ) {
        this.removePeer(socketId);
      }
    };

    this.peers.set(socketId, peer);
    return peer;
  }

  private removePeer(socketId: string): void {
    const peer = this.peers.get(socketId);
    if (peer) {
      peer.close();
      this.peers.delete(socketId);
    }

    const stream = this.remoteStreams.get(socketId);
    if (stream) {
      stream.getTracks().forEach((track) => track.stop());
      this.remoteStreams.delete(socketId);
    }

    this.options.onPeerDisconnected(socketId);
  }

  private cleanupPeers(): void {
    for (const socketId of Array.from(this.peers.keys())) {
      this.removePeer(socketId);
    }
  }

  private cleanupLocalStream(): void {
    if (!this.localStream) {
      return;
    }
    this.localStream.getTracks().forEach((track) => track.stop());
    this.localStream = null;
  }
}
