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
      phone_number VARCHAR(10) UNIQUE NOT NULL,
      token VARCHAR(64) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Eski 9 haneli numaraları koruyarak başına 5 ekle.
  await pool.query(`ALTER TABLE users ALTER COLUMN phone_number TYPE VARCHAR(10)`);
  await pool.query(`
    UPDATE users
    SET phone_number = '5' || phone_number
    WHERE LENGTH(phone_number) = 9
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id BIGSERIAL PRIMARY KEY,
      owner_phone VARCHAR(10) NOT NULL REFERENCES users(phone_number) ON UPDATE CASCADE ON DELETE CASCADE,
      contact_phone VARCHAR(10) NOT NULL,
      display_name VARCHAR(60),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(owner_phone, contact_phone)
    )
  `);
}

function makePhoneNumber() {
  return "5" + String(crypto.randomInt(0, 1000000000)).padStart(9, "0");
}

async function createUser() {
  for (let i = 0; i < 50; i++) {
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
      if (existing.rowCount) return res.json(existing.rows[0]);
    }
    res.json(await createUser());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Numara oluşturulamadı." });
  }
});

async function authenticatedUser(req, res, next) {
  try {
    const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!/^[a-f0-9]{64}$/.test(token)) return res.status(401).json({ error: "Oturum bulunamadı." });
    const result = await pool.query("SELECT phone_number FROM users WHERE token = $1", [token]);
    if (!result.rowCount) return res.status(401).json({ error: "Geçersiz oturum." });
    req.userPhone = result.rows[0].phone_number;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Veritabanı hatası." });
  }
}

app.get("/api/contacts", authenticatedUser, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT contact_phone, display_name
       FROM contacts WHERE owner_phone = $1
       ORDER BY COALESCE(display_name, contact_phone), contact_phone`,
      [req.userPhone]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Kişiler yüklenemedi." });
  }
});

app.put("/api/contacts/:phone", authenticatedUser, async (req, res) => {
  try {
    const phone = String(req.params.phone || "").replace(/\D/g, "");
    const name = String(req.body?.name || "").trim().slice(0, 60);
    if (!/^5\d{9}$/.test(phone)) return res.status(400).json({ error: "Numara geçersiz." });
    if (phone === req.userPhone) return res.status(400).json({ error: "Kendi numaranı kaydedemezsin." });

    await pool.query(
      `INSERT INTO contacts(owner_phone, contact_phone, display_name)
       VALUES($1, $2, $3)
       ON CONFLICT(owner_phone, contact_phone)
       DO UPDATE SET display_name = EXCLUDED.display_name`,
      [req.userPhone, phone, name || null]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Kişi kaydedilemedi." });
  }
});

const onlineUsers = new Map();
const activeCalls = new Map();

async function saveCallContacts(call) {
  if (!call?.answered) return;
  const fromPhone = call.fromPhone;
  const toPhone = call.toPhone;
  try {
    await pool.query(
      `INSERT INTO contacts(owner_phone, contact_phone)
       VALUES ($1, $2), ($2, $1)
       ON CONFLICT(owner_phone, contact_phone) DO NOTHING`,
      [fromPhone, toPhone]
    );
    const fromSocket = onlineUsers.get(fromPhone);
    const toSocket = onlineUsers.get(toPhone);
    if (fromSocket) io.to(fromSocket).emit("contacts-updated");
    if (toSocket) io.to(toSocket).emit("contacts-updated");
  } catch (err) {
    console.error("Contact save error:", err);
  }
}

io.use(async (socket, next) => {
  try {
    const token = String(socket.handshake.auth?.token || "");
    if (!/^[a-f0-9]{64}$/.test(token)) return next(new Error("Invalid login token"));
    const result = await pool.query("SELECT phone_number FROM users WHERE token = $1", [token]);
    if (!result.rowCount) return next(new Error("User not found"));
    socket.user = { phoneNumber: result.rows[0].phone_number };
    next();
  } catch {
    next(new Error("Authentication failed"));
  }
});

io.on("connection", socket => {
  const phone = socket.user.phoneNumber;
  onlineUsers.set(phone, socket.id);
  socket.emit("registered", { phoneNumber: phone });

  socket.on("call-user", ({ to, offer } = {}) => {
    const target = String(to || "").replace(/\D/g, "");
    if (!/^5\d{9}$/.test(target)) return socket.emit("call-error", "10 haneli numara gir.");
    if (target === phone) return socket.emit("call-error", "Kendini arayamazsın.");

    const targetSocket = onlineUsers.get(target);
    if (!targetSocket) return socket.emit("call-error", "Bu numara çevrimdışı.");

    if ([...activeCalls.values()].some(c => c.from === targetSocket || c.to === targetSocket || c.from === socket.id || c.to === socket.id)) {
      return socket.emit("call-error", "Taraflardan biri başka görüşmede.");
    }

    const callId = crypto.randomUUID();
    activeCalls.set(callId, {
      from: socket.id, to: targetSocket,
      fromPhone: phone, toPhone: target,
      answered: false
    });

    io.to(targetSocket).emit("incoming-call", { callId, fromNumber: phone, offer });
    socket.emit("calling", { callId, to: target });
  });

  socket.on("answer-call", ({ callId, answer } = {}) => {
    const call = activeCalls.get(String(callId));
    if (!call || call.to !== socket.id) return;
    call.answered = true;
    io.to(call.from).emit("call-answered", { callId, answer });
  });

  socket.on("reject-call", ({ callId } = {}) => {
    const key = String(callId);
    const call = activeCalls.get(key);
    if (!call || call.to !== socket.id) return;
    io.to(call.from).emit("call-rejected", { callId });
    activeCalls.delete(key);
  });

  socket.on("end-call", async ({ callId } = {}) => {
    const key = String(callId);
    const call = activeCalls.get(key);
    if (!call || (call.from !== socket.id && call.to !== socket.id)) return;
    const other = call.from === socket.id ? call.to : call.from;
    io.to(other).emit("call-ended", { callId });
    activeCalls.delete(key);
    await saveCallContacts(call);
  });

  socket.on("disconnect", async () => {
    if (onlineUsers.get(phone) === socket.id) onlineUsers.delete(phone);
    for (const [callId, call] of activeCalls.entries()) {
      if (call.from === socket.id || call.to === socket.id) {
        const other = call.from === socket.id ? call.to : call.from;
        io.to(other).emit("call-ended", { callId });
        activeCalls.delete(callId);
        await saveCallContacts(call);
      }
    }
  });
});

initDb().then(() => {
  server.listen(PORT, () => console.log("WiFi Phone server running on " + PORT));
}).catch(err => {
  console.error("Database error:", err);
  process.exit(1);
});
                                 
