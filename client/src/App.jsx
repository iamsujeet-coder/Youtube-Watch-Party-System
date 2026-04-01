import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";

const SERVER_URL = import.meta.env.VITE_SERVER_URL || "http://localhost:5000";

const ROLE = {
  HOST: "host",
  MODERATOR: "moderator",
  PARTICIPANT: "participant",
};

const socket = io(SERVER_URL, { autoConnect: true });

function parseVideoId(value) {
  const input = (value || "").trim();
  if (!input) return "";
  if (!input.includes("http")) return input;

  try {
    const url = new URL(input);
    if (url.hostname.includes("youtu.be")) return url.pathname.replace("/", "");
    return url.searchParams.get("v") || "";
  } catch {
    return "";
  }
}

export default function App() {
  const playerRef = useRef(null);
  const suppressRef = useRef(false);
  const [playerReady, setPlayerReady] = useState(false);
  const [username, setUsername] = useState("");
  const [roomInput, setRoomInput] = useState("");
  const [videoInput, setVideoInput] = useState("");
  const [roomId, setRoomId] = useState("");
  const [myRole, setMyRole] = useState("");
  const [myUserId, setMyUserId] = useState("");
  const [participants, setParticipants] = useState([]);
  const [message, setMessage] = useState("");
  const [backendReady, setBackendReady] = useState(false);

  const canControl = useMemo(
    () => myRole === ROLE.HOST || myRole === ROLE.MODERATOR,
    [myRole]
  );

  useEffect(() => {
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.async = true;
    document.body.appendChild(script);

    window.onYouTubeIframeAPIReady = () => {
      playerRef.current = new window.YT.Player("player", {
        height: "420",
        width: "100%",
        videoId: "dQw4w9WgXcQ",
        playerVars: { controls: 1, autoplay: 0 },
      });
      setPlayerReady(true);
    };

    return () => {
      if (playerRef.current?.destroy) playerRef.current.destroy();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const warmupBackend = async () => {
      try {
        const response = await fetch(`${SERVER_URL}/api/health`, {
          method: "GET",
          cache: "no-store",
        });
        if (!cancelled && response.ok) {
          setBackendReady(true);
          if (!message) {
            setMessage("Server connected. You can create or join a room.");
          }
        }
      } catch {
        if (!cancelled) {
          setMessage("Waking server... first request on free hosting may take some time.");
        }
      }
    };

    warmupBackend();
    const interval = setInterval(warmupBackend, 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    const updateParticipants = (list) => {
      setParticipants(list || []);
      const me = (list || []).find((p) => p.userId === socket.id);
      if (me) {
        setMyRole(me.role);
        setMyUserId(me.userId);
      }
    };

    socket.on("room_created", ({ roomId: id, userId, role, participants: list, syncState }) => {
      setRoomId(id);
      setRoomInput(id);
      setMyRole(role);
      setMyUserId(userId);
      setParticipants(list || []);
      applySync(syncState);
      setMessage("Room created.");
    });

    socket.on("user_joined", ({ participants: list }) => updateParticipants(list));
    socket.on("user_left", ({ participants: list }) => updateParticipants(list));
    socket.on("role_assigned", ({ participants: list }) => updateParticipants(list));
    socket.on("participant_removed", ({ participants: list }) => updateParticipants(list));
    socket.on("sync_state", (state) => applySync(state));
    socket.on("kicked", ({ message: msg }) => {
      setRoomId("");
      setParticipants([]);
      setMyRole("");
      setMessage(msg || "Removed by host");
    });
    socket.on("action_rejected", ({ message: msg }) => setMessage(msg || "Action rejected"));
    socket.on("connect", () => setBackendReady(true));
    socket.on("disconnect", () => setBackendReady(false));

    return () => {
      socket.off("room_created");
      socket.off("user_joined");
      socket.off("user_left");
      socket.off("role_assigned");
      socket.off("participant_removed");
      socket.off("sync_state");
      socket.off("kicked");
      socket.off("action_rejected");
      socket.off("connect");
      socket.off("disconnect");
    };
  }, [playerReady]);

  const applySync = (state) => {
    if (!playerRef.current || !state) return;
    suppressRef.current = true;
    const player = playerRef.current;

    const currentVideoId = player?.getVideoData?.().video_id;
    if (state.videoId && currentVideoId !== state.videoId) {
      player.loadVideoById(state.videoId, state.currentTime || 0);
    } else if (typeof state.currentTime === "number") {
      player.seekTo(state.currentTime, true);
    }
    if (state.playState === "playing") player.playVideo();
    else player.pauseVideo();

    setTimeout(() => {
      suppressRef.current = false;
    }, 250);
  };

  const emitCreate = () => socket.emit("create_room", { username: username || "Host" });

  const emitJoin = () => {
    socket.emit("join_room", { roomId: roomInput, username: username || "Guest" });
    setRoomId(roomInput.trim().toUpperCase());
  };

  const changeVideo = () => {
    const videoId = parseVideoId(videoInput);
    if (!videoId) return setMessage("Valid video URL/ID required");
    socket.emit("change_video", { videoId });
  };

  const emitPlay = () => socket.emit("play");
  const emitPause = () => {
    const t = playerRef.current?.getCurrentTime?.() || 0;
    socket.emit("pause", { time: t });
  };
  const emitSeek = () => {
    const t = (playerRef.current?.getCurrentTime?.() || 0) + 30;
    socket.emit("seek", { time: t });
  };

  const assignRole = (userId, role) => socket.emit("assign_role", { userId, role });
  const removeParticipant = (userId) => socket.emit("remove_participant", { userId });

  return (
    <div className="min-h-screen w-full bg-slate-950 px-4 py-6">
      <div className="mx-auto max-w-7xl space-y-4">
        <h1 className="text-2xl font-bold md:text-3xl">MERN YouTube Watch Party</h1>

        <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
          <div className="flex flex-col gap-3 md:flex-row">
            <input
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
              placeholder="Your name"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <button className="rounded-lg bg-blue-600 px-4 py-2 font-medium" onClick={emitCreate}>
              Create Room
            </button>
            <input
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
              placeholder="Room code"
              value={roomInput}
              onChange={(e) => setRoomInput(e.target.value)}
            />
            <button className="rounded-lg bg-emerald-600 px-4 py-2 font-medium" onClick={emitJoin}>
              Join Room
            </button>
          </div>
          <div className="mt-3 text-sm text-slate-300">
            <p>Room: {roomId || "Not joined"}</p>
            <p>Role: {myRole || "None"}</p>
            <p>Backend: {backendReady ? "Connected" : "Warming up..."}</p>
            <p>{message}</p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="space-y-4 lg:col-span-2">
            <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
              <div className="flex flex-col gap-3 md:flex-row">
                <input
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2"
                  placeholder="YouTube URL or ID"
                  value={videoInput}
                  onChange={(e) => setVideoInput(e.target.value)}
                  disabled={!canControl}
                />
                <button
                  className="rounded-lg bg-violet-600 px-4 py-2 font-medium disabled:opacity-40"
                  disabled={!canControl}
                  onClick={changeVideo}
                >
                  Change Video
                </button>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className="rounded-lg bg-blue-600 px-3 py-2 disabled:opacity-40"
                  disabled={!canControl}
                  onClick={emitPlay}
                >
                  Play
                </button>
                <button
                  className="rounded-lg bg-rose-600 px-3 py-2 disabled:opacity-40"
                  disabled={!canControl}
                  onClick={emitPause}
                >
                  Pause
                </button>
                <button
                  className="rounded-lg bg-amber-600 px-3 py-2 disabled:opacity-40"
                  disabled={!canControl}
                  onClick={emitSeek}
                >
                  Seek +30s
                </button>
              </div>
            </div>

            <div className="overflow-hidden rounded-xl border border-slate-800 bg-black p-2">
              <div id="player" className="aspect-video w-full" />
            </div>
          </div>

          <div className="rounded-xl border border-slate-800 bg-slate-900 p-4">
            <h2 className="mb-3 text-lg font-semibold">Participants</h2>
            <div className="space-y-2">
              {participants.map((p) => (
                <div
                  key={p.userId}
                  className="rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm"
                >
                  <p className="font-medium">
                    {p.username} {p.userId === myUserId ? "(You)" : ""}
                  </p>
                  <p className="text-slate-400">{p.role}</p>
                  {myRole === ROLE.HOST && p.userId !== myUserId && (
                    <div className="mt-2 flex gap-2">
                      <button
                        className="rounded bg-indigo-600 px-2 py-1"
                        onClick={() => assignRole(p.userId, ROLE.MODERATOR)}
                      >
                        Make Mod
                      </button>
                      <button
                        className="rounded bg-slate-600 px-2 py-1"
                        onClick={() => assignRole(p.userId, ROLE.PARTICIPANT)}
                      >
                        Make Participant
                      </button>
                      <button
                        className="rounded bg-red-700 px-2 py-1"
                        onClick={() => removeParticipant(p.userId)}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
