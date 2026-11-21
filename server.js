
const express = require("express");
const http = require("http");
const crypto = require("crypto");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is missing.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost")
    ? false
    : { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.static("public"));

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      phone_number VARCHAR(9) UNIQUE NOT NULL,
      token VARCHAR(64) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

function makePhoneNumber() {
  return String(200000000 + crypto.randomInt(0, 800000000));
}

async function createUser() {
  for (let i = 0; i < 30; i++) {
    const phone = makePhoneNumber();
    const token = crypto.randomBytes(32).toString("hex");

    try {
      const result = await pool.query(
        "INSERT INTO users (phone_number, token) VALUES ($1, $2) RETURNING phone_number, token",
        [phone, token]
      );
      return result.rows[0];
    } catch (err) {
      if (err.code !== "23505") throw err;
    }
  }

  throw new Error("Could not allocate unique number.");
}

app.post("/api/register", async (req, res) => {
  try {
    const suppliedToken = String(req.body?.token || "");

    if (/^[a-f0-9]{64}$/.test(suppliedToken)) {
      const existing = await pool.query(
        "SELECT phone_number, token FROM users WHERE token = $1",
        [suppliedToken]
      );

      if (existing.rowCount) {
        return res.json(existing.rows[0]);
      }
    }

    const user = await createUser();
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Could not create your number."
    });
  }
});

const onlineUsers = new Map();
const activeCalls = new Map();

io.use(async (socket, next) => {
  try {
    const token = String(socket.handshake.auth?.token || "");

    if (!/^[a-f0-9]{64}$/.test(token)) {
      return next(new Error("Invalid login token"));
    }

    const result = await pool.query(
      "SELECT phone_number FROM users WHERE token = $1",
      [token]
    );

    if (!result.rowCount) {
      return next(new Error("User not found"));
    }

    socket.user = {
      phoneNumber: result.rows[0].phone_number
    };

    next();
  } catch (err) {
    next(new Error("Authentication failed"));
  }
});

io.on("connection", socket => {
  const phone = socket.user.phoneNumber;

  onlineUsers.set(phone, socket.id);

  socket.emit("registered", {
    phoneNumber: phone
  });

  socket.on("call-user", ({ to, offer } = {}) => {
    const target = String(to || "").replace(/\D/g, "");

    if (!/^\d{9}$/.test(target)) {
      socket.emit("call-error", "9 haneli numara gir.");
      return;
    }

    if (target === phone) {
      socket.emit("call-error", "Kendini arayamazsın.");
      return;
    }

    const targetSocket = onlineUsers.get(target);

    if (!targetSocket) {
      socket.emit("call-error", "Bu numara çevrimdışı.");
      return;
    }

    if ([...activeCalls.values()].some(
      c => c.from === targetSocket || c.to === targetSocket
    )) {
      socket.emit("call-error", "Kişi başka görüşmede.");
      return;
    }

    const callId = crypto.randomUUID();

    activeCalls.set(callId, {
      from: socket.id,
      to: targetSocket
    });

    io.to(targetSocket).emit("incoming-call", {
      callId,
      fromNumber: phone,
      offer
    });

    socket.emit("calling", {
      callId,
      to: target
    });
  });

  socket.on("answer-call", ({ callId, answer } = {}) => {
    const call = activeCalls.get(String(callId));

    if (!call || call.to !== socket.id) return;

    io.to(call.from).emit("call-answered", {
      callId,
      answer
    });
  });

  socket.on("reject-call", ({ callId } = {}) => {
    const call = activeCalls.get(String(callId));

    if (!call || call.to !== socket.id) return;

    io.to(call.from).emit("call-rejected", { callId });
    activeCalls.delete(String(callId));
  });

  socket.on("end-call", ({ callId } = {}) => {
    const call = activeCalls.get(String(callId));

    if (!call ||
      (call.from !== socket.id && call.to !== socket.id)) return;

    const other = call.from === socket.id
      ? call.to
      : call.from;

    io.to(other).emit("call-ended", { callId });
    activeCalls.delete(String(callId));
  });

  socket.on("disconnect", () => {
    if (onlineUsers.get(phone) === socket.id) {
      onlineUsers.delete(phone);
    }

    for (const [callId, call] of activeCalls.entries()) {
      if (call.from === socket.id || call.to === socket.id) {
        const other = call.from === socket.id
          ? call.to
          : call.from;

        io.to(other).emit("call-ended", { callId });
        activeCalls.delete(callId);
      }
    }
  });
});

initDb().then(() => {
  server.listen(PORT, () => {
    console.log("WiFi Phone server running on " + PORT);
  });
}).catch(err => {
  console.error("Database error:", err);
  process.exit(1);
});
  
