import AgoraRTC, {
  type IAgoraRTCClient,
  type IAgoraRTCRemoteUser,
  type IMicrophoneAudioTrack,
  type UID,
} from "agora-rtc-sdk-ng";
import type { ConnectArgs, ConnectionStatus, Participant } from "../types/voice";

type VoiceClientOptions = {
  onStatus: (status: ConnectionStatus) => void;
  onParticipants: (participants: Participant[]) => void;
  onRemoteStream: (socketId: string, stream: MediaStream) => void;
  onPeerDisconnected: (socketId: string) => void;
  onError: (message: string) => void;
};

const AGORA_APP_ID =
  (import.meta.env.VITE_AGORA_APP_ID as string | undefined) ??
  "83eb72b1d99247479160b8b0bbba3218";
const CHANNEL_NAME = "global-room";

export class VoiceClient {
  private readonly options: VoiceClientOptions;

  private client: IAgoraRTCClient | null = null;

  private localTrack: IMicrophoneAudioTrack | null = null;

  private localUid: UID | null = null;

  private participants = new Map<string, Participant>();

  private status: ConnectionStatus = "Disconnected";

  constructor(options: VoiceClientOptions) {
    this.options = options;
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  getLocalStream(): MediaStream | null {
    return null;
  }

  async connect(args: ConnectArgs): Promise<void> {
    if (this.client || this.status !== "Disconnected") {
      return;
    }

    if (!AGORA_APP_ID) {
      this.options.onError("Missing VITE_AGORA_APP_ID. Add it in Vercel environment variables.");
      return;
    }

    this.setStatus("Connecting");

    const client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });
    this.client = client;

    client.on("user-published", async (user, mediaType) => {
      try {
        await client.subscribe(user, mediaType);
        if (mediaType === "audio" && user.audioTrack) {
          user.audioTrack.play();
        }
        this.addOrUpdateRemoteParticipant(user);
      } catch {
        this.options.onError("Failed subscribing to remote audio.");
      }
    });

    client.on("user-unpublished", (user, mediaType) => {
      if (mediaType === "audio") {
        this.removeRemoteParticipant(user);
      }
    });

    client.on("user-left", (user) => {
      this.removeRemoteParticipant(user);
    });

    try {
      const uid = args.userId.trim() || `web-${Math.random().toString(36).slice(2, 10)}`;
      const joinedUid = await client.join(AGORA_APP_ID, CHANNEL_NAME, null, uid);
      this.localUid = joinedUid;

      const micTrack = await AgoraRTC.createMicrophoneAudioTrack({
        encoderConfig: "music_standard",
        AEC: true,
        ANS: true,
      });
      this.localTrack = micTrack;

      await client.publish([micTrack]);

      this.participants.set(String(joinedUid), {
        socketId: String(joinedUid),
        userId: String(uid),
        muted: false,
      });
      this.emitParticipants();
      this.setStatus("Connected");
    } catch {
      this.options.onError("Could not connect to Agora voice service.");
      this.disconnect();
    }
  }

  disconnect(): void {
    void this.teardown();
  }

  private async teardown(): Promise<void> {
    try {
      if (this.localTrack) {
        this.localTrack.stop();
        this.localTrack.close();
      }
      this.localTrack = null;

      if (this.client) {
        await this.client.leave();
      }
    } catch {
      // ignore teardown errors
    } finally {
      this.client = null;
      this.localUid = null;
      this.participants.clear();
      this.options.onParticipants([]);
      this.setStatus("Disconnected");
    }
  }

  setMuted(muted: boolean): void {
    if (!this.localTrack) {
      return;
    }
    void this.localTrack.setEnabled(!muted);

    if (!this.localUid) {
      return;
    }
    const key = String(this.localUid);
    const selfParticipant = this.participants.get(key);
    if (selfParticipant) {
      selfParticipant.muted = muted;
      this.emitParticipants();
    }
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.options.onStatus(status);
  }

  private addOrUpdateRemoteParticipant(user: IAgoraRTCRemoteUser): void {
    const key = String(user.uid);
    if (!this.participants.has(key)) {
      this.participants.set(key, {
        socketId: key,
        userId: key,
        muted: false,
      });
      this.emitParticipants();
    }
  }

  private removeRemoteParticipant(user: IAgoraRTCRemoteUser): void {
    const key = String(user.uid);
    if (this.participants.delete(key)) {
      this.options.onPeerDisconnected(key);
      this.emitParticipants();
    }
  }

  private emitParticipants(): void {
    this.options.onParticipants(Array.from(this.participants.values()));
  }
}
