import { useEffect, useMemo, useRef, useState } from "react";
import { VoiceClient } from "./lib/voiceClient";
import type { ConnectionStatus, Participant } from "./types/voice";

function App() {
  const [userId, setUserId] = useState(`web-${Math.random().toString(36).slice(2, 10)}`);
  const [roomId, setRoomId] = useState("global-room");
  const [status, setStatus] = useState<ConnectionStatus>("Disconnected");
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [masterVolume, setMasterVolume] = useState(100);
  const [micEnabled, setMicEnabled] = useState(true);
  const [lastError, setLastError] = useState<string>("");

  const audioEls = useRef<Map<string, HTMLAudioElement>>(new Map());
  const masterVolumeRef = useRef(masterVolume);

  const voiceClient = useMemo(
    () =>
      new VoiceClient({
        onStatus: setStatus,
        onParticipants: setParticipants,
        onRemoteStream: (socketId, stream) => {
          const existing = audioEls.current.get(socketId);
          if (existing) {
            existing.srcObject = stream;
            return;
          }
          const audioEl = document.createElement("audio");
          audioEl.autoplay = true;
          audioEl.volume = masterVolumeRef.current / 100;
          audioEl.srcObject = stream;
          audioEls.current.set(socketId, audioEl);
        },
        onPeerDisconnected: (socketId) => {
          const audioEl = audioEls.current.get(socketId);
          if (audioEl) {
            audioEl.srcObject = null;
            audioEls.current.delete(socketId);
          }
        },
        onError: (message) => setLastError(message),
      }),
    []
  );

  useEffect(() => {
    return () => {
      voiceClient.disconnect();
    };
  }, [voiceClient]);

  const handleConnect = async () => {
    setLastError("");
    await voiceClient.connect({ userId: userId.trim(), roomId: roomId.trim() });
  };

  const handleDisconnect = () => {
    voiceClient.disconnect();
    for (const [socketId, audio] of audioEls.current.entries()) {
      audio.srcObject = null;
      audioEls.current.delete(socketId);
    }
  };

  const handleMicToggle = (enabled: boolean) => {
    setMicEnabled(enabled);
    voiceClient.setMuted(!enabled);
  };

  const handleMasterVolume = (volume: number) => {
    setMasterVolume(volume);
    masterVolumeRef.current = volume;
    for (const audioEl of audioEls.current.values()) {
      audioEl.volume = volume / 100;
    }
  };

  return (
    <div data-theme="night" className="min-h-screen bg-base-300 p-6 text-base-content">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <section className="card bg-base-200 shadow-xl">
          <div className="card-body">
            <h1 className="card-title text-3xl">Proximity Voice</h1>
            <p className="text-sm opacity-80">Browser-hosted internet voice lobby.</p>

            <label className="form-control w-full">
              <span className="label-text mb-1">User ID</span>
              <input
                className="input input-bordered"
                value={userId}
                onChange={(event) => setUserId(event.target.value)}
                disabled={status !== "Disconnected"}
              />
            </label>

            <label className="form-control w-full">
              <span className="label-text mb-1">Room ID</span>
              <input
                className="input input-bordered"
                value={roomId}
                onChange={(event) => setRoomId(event.target.value)}
                disabled={status !== "Disconnected"}
              />
            </label>

            <div className="mt-2 flex gap-2">
              <button
                className="btn btn-primary"
                onClick={handleConnect}
                disabled={status !== "Disconnected" || !userId.trim() || !roomId.trim()}
              >
                Connect
              </button>
              <button
                className="btn btn-outline"
                onClick={handleDisconnect}
                disabled={status === "Disconnected"}
              >
                Disconnect
              </button>
            </div>

            <div className="mt-2">
              <span
                className={`badge ${
                  status === "Connected"
                    ? "badge-success"
                    : status === "Connecting"
                      ? "badge-warning"
                      : "badge-ghost"
                }`}
              >
                {status}
              </span>
            </div>
          </div>
        </section>

        <section className="card bg-base-200 shadow-xl">
          <div className="card-body">
            <h2 className="card-title">Voice Controls</h2>
            <p className="text-sm opacity-70">
              Connected users can talk globally without linking.
            </p>

            <label className="form-control w-full">
              <span className="label-text mb-1">Master Volume ({masterVolume}%)</span>
              <input
                className="range range-primary"
                type="range"
                min={0}
                max={100}
                value={masterVolume}
                onChange={(event) => handleMasterVolume(Number(event.target.value))}
              />
            </label>

            <label className="label cursor-pointer justify-start gap-2">
              <input
                type="checkbox"
                className="checkbox checkbox-primary"
                checked={micEnabled}
                onChange={(event) => handleMicToggle(event.target.checked)}
                disabled={status === "Disconnected"}
              />
              <span className="label-text">Microphone Enabled</span>
            </label>

            {lastError ? <p className="text-error text-sm">{lastError}</p> : null}
          </div>
        </section>

        <section className="card bg-base-200 shadow-xl">
          <div className="card-body">
            <h2 className="card-title">Participants</h2>
            <p className="text-sm opacity-70">Live connected users and output state.</p>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>User ID</th>
                    <th>Socket</th>
                    <th>Output</th>
                    <th>Muted</th>
                  </tr>
                </thead>
                <tbody>
                  {participants.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="opacity-60">
                        No active participants.
                      </td>
                    </tr>
                  ) : (
                    participants.map((participant) => (
                      <tr key={participant.socketId}>
                        <td>{participant.userId}</td>
                        <td className="font-mono text-xs">{participant.socketId}</td>
                        <td>{participant.userId === userId ? "local" : "remote"}</td>
                        <td>{participant.muted ? "Yes" : "No"}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export default App;
