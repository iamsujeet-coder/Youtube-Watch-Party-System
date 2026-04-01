const mongoose = require("mongoose");

const participantSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true },
    username: { type: String, required: true },
    role: {
      type: String,
      enum: ["host", "moderator", "participant"],
      default: "participant",
    },
  },
  { _id: false }
);

const roomSchema = new mongoose.Schema(
  {
    roomId: { type: String, required: true, unique: true, index: true },
    videoId: { type: String, default: "dQw4w9WgXcQ" },
    playState: { type: String, enum: ["playing", "paused"], default: "paused" },
    currentTime: { type: Number, default: 0 },
    participants: { type: [participantSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Room", roomSchema);
