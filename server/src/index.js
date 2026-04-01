const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const mongoose = require("mongoose");
const crypto = require("crypto");
require("dotenv").config();
const Room = require("./models/Room");

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:5173",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || "";

const ROLE = {
  HOST: "host",
  MODERATOR: "moderator",
  PARTICIPANT: "participant",
};

const roomRuntime = new Map();

function generateRoomId() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function asParticipantList(room) {
  return Array.from(room.participants.values());
}

function isController(role) {
  return role === ROLE.HOST || role === ROLE.MODERATOR;
}

function isHost(role) {
  return role === ROLE.HOST;
}

function safeName(name, fallback) {
  return (name || "").trim() || fallback;
}

function getAdjustedTime(room) {
  if (room.playState !== "playing") return room.currentTime;
  return room.currentTime + (Date.now() - room.lastUpdateTs) / 1000;
}

async function persistRoom(roomId) {
  const room = roomRuntime.get(roomId);
  if (!room || !mongoose.connection?.readyState) return;

  const payload = {
    roomId: room.roomId,
    videoId: room.videoId,
    playState: room.playState,
    currentTime: room.currentTime,
    participants: asParticipantList(room),
  };

  await Room.findOneAndUpdate({ roomId }, payload, { upsert: true, new: true });
}

function reject(socket, message) {
  socket.emit("action_rejected", { message });
}

async function leaveRoom(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;

  const room = roomRuntime.get(roomId);
  socket.data.roomId = null;
  socket.leave(roomId);
  if (!room) return;

  const departing = room.participants.get(socket.id);
  room.participants.delete(socket.id);

  if (room.participants.size === 0) {
    roomRuntime.delete(roomId);
    await persistRoom(roomId);
    return;
  }

  if (departing?.role === ROLE.HOST) {
    const first = room.participants.values().next().value;
    first.role = ROLE.HOST;
    io.to(roomId).emit("role_assigned", {
      userId: first.userId,
      username: first.username,
      role: first.role,
      participants: asParticipantList(room),
    });
  }

  io.to(roomId).emit("user_left", {
    userId: socket.id,
    username: departing?.username || "Unknown",
    participants: asParticipantList(room),
  });
  await persistRoom(roomId);
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, message: "Server running" });
});

io.on("connection", (socket) => {
  socket.data.roomId = null;

  socket.on("create_room", async ({ username }) => {
    await leaveRoom(socket);
    const roomId = generateRoomId();
    const room = {
      roomId,
      videoId: "dQw4w9WgXcQ",
      playState: "paused",
      currentTime: 0,
      lastUpdateTs: Date.now(),
      participants: new Map([
        [
          socket.id,
          {
            userId: socket.id,
            username: safeName(username, "Host"),
            role: ROLE.HOST,
          },
        ],
      ]),
    };
    roomRuntime.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;
    await persistRoom(roomId);

    socket.emit("room_created", {
      roomId,
      userId: socket.id,
      role: ROLE.HOST,
      participants: asParticipantList(room),
      syncState: {
        videoId: room.videoId,
        playState: room.playState,
        currentTime: room.currentTime,
      },
    });
  });

  socket.on("join_room", async ({ roomId, username }) => {
    await leaveRoom(socket);
    const id = (roomId || "").trim().toUpperCase();
    const room = roomRuntime.get(id);
    if (!room) {
      reject(socket, "Room not found");
      return;
    }

    room.participants.set(socket.id, {
      userId: socket.id,
      username: safeName(username, "Guest"),
      role: ROLE.PARTICIPANT,
    });
    socket.join(id);
    socket.data.roomId = id;

    io.to(id).emit("user_joined", {
      userId: socket.id,
      participants: asParticipantList(room),
    });
    socket.emit("sync_state", {
      videoId: room.videoId,
      playState: room.playState,
      currentTime: getAdjustedTime(room),
    });
    await persistRoom(id);
  });

  socket.on("play", async () => {
    const room = roomRuntime.get(socket.data.roomId);
    if (!room) return;
    const role = room.participants.get(socket.id)?.role;
    if (!isController(role)) return reject(socket, "Permission denied");

    room.currentTime = getAdjustedTime(room);
    room.playState = "playing";
    room.lastUpdateTs = Date.now();
    io.to(room.roomId).emit("sync_state", {
      videoId: room.videoId,
      playState: room.playState,
      currentTime: room.currentTime,
    });
    await persistRoom(room.roomId);
  });

  socket.on("pause", async ({ time }) => {
    const room = roomRuntime.get(socket.data.roomId);
    if (!room) return;
    const role = room.participants.get(socket.id)?.role;
    if (!isController(role)) return reject(socket, "Permission denied");

    room.currentTime = typeof time === "number" ? time : getAdjustedTime(room);
    room.playState = "paused";
    room.lastUpdateTs = Date.now();
    io.to(room.roomId).emit("sync_state", {
      videoId: room.videoId,
      playState: room.playState,
      currentTime: room.currentTime,
    });
    await persistRoom(room.roomId);
  });

  socket.on("seek", async ({ time }) => {
    const room = roomRuntime.get(socket.data.roomId);
    if (!room) return;
    const role = room.participants.get(socket.id)?.role;
    if (!isController(role)) return reject(socket, "Permission denied");

    room.currentTime = Math.max(0, Number(time) || 0);
    room.lastUpdateTs = Date.now();
    io.to(room.roomId).emit("sync_state", {
      videoId: room.videoId,
      playState: room.playState,
      currentTime: room.currentTime,
    });
    await persistRoom(room.roomId);
  });

  socket.on("change_video", async ({ videoId }) => {
    const room = roomRuntime.get(socket.data.roomId);
    if (!room) return;
    const role = room.participants.get(socket.id)?.role;
    if (!isController(role)) return reject(socket, "Permission denied");

    const next = String(videoId || "").trim();
    if (!next) return reject(socket, "Video id required");
    room.videoId = next;
    room.currentTime = 0;
    room.playState = "paused";
    room.lastUpdateTs = Date.now();
    io.to(room.roomId).emit("sync_state", {
      videoId: room.videoId,
      playState: room.playState,
      currentTime: 0,
    });
    await persistRoom(room.roomId);
  });

  socket.on("assign_role", async ({ userId, role }) => {
    const room = roomRuntime.get(socket.data.roomId);
    if (!room) return;
    const requester = room.participants.get(socket.id);
    if (!requester || !isHost(requester.role)) return reject(socket, "Only host allowed");

    const target = room.participants.get(userId);
    if (!target) return reject(socket, "Participant not found");

    if (![ROLE.MODERATOR, ROLE.PARTICIPANT].includes(role)) {
      return reject(socket, "Invalid role");
    }
    target.role = role;
    io.to(room.roomId).emit("role_assigned", {
      userId: target.userId,
      username: target.username,
      role: target.role,
      participants: asParticipantList(room),
    });
    await persistRoom(room.roomId);
  });

  socket.on("remove_participant", async ({ userId }) => {
    const room = roomRuntime.get(socket.data.roomId);
    if (!room) return;
    const requester = room.participants.get(socket.id);
    if (!requester || !isHost(requester.role)) return reject(socket, "Only host allowed");
    if (userId === socket.id) return reject(socket, "Host cannot remove self");

    const target = room.participants.get(userId);
    const targetSocket = io.sockets.sockets.get(userId);
    if (!target || !targetSocket) return reject(socket, "Participant not found");

    room.participants.delete(userId);
    targetSocket.leave(room.roomId);
    targetSocket.data.roomId = null;
    targetSocket.emit("kicked", { message: "Removed by host" });
    io.to(room.roomId).emit("participant_removed", {
      userId,
      participants: asParticipantList(room),
    });
    await persistRoom(room.roomId);
  });

  socket.on("disconnect", async () => {
    await leaveRoom(socket);
  });
});

async function bootstrap() {
  if (MONGO_URI) {
    try {
      await mongoose.connect(MONGO_URI);
      console.log("MongoDB connected");
    } catch (error) {
      console.log("MongoDB not connected. Running in memory-only mode.");
    }
  } else {
    console.log("MONGO_URI missing. Running in memory-only mode.");
  }

  server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
  });
}

bootstrap();
