
const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const JWT_SECRET = process.env.JWT_SECRET;

if (!DATABASE_URL || !JWT_SECRET) {
  console.error("DATABASE_URL veya JWT_SECRET eksik!");
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true"
    ? { rejectUnauthorized: false }
    : undefined
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: true, credentials: true }
});

app.use(express.json({ limit: "32kb" }));

// VERİTABANI
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      device_key VARCHAR(128) UNIQUE,
      phone_number VARCHAR(10) UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id BIGSERIAL PRIMARY KEY,
      owner_phone VARCHAR(10) NOT NULL,
      contact_phone VARCHAR(10) NOT NULL,
      display_name VARCHAR(40) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS call_history (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      other_number VARCHAR(10) NOT NULL,
      other_name VARCHAR(40),
      status VARCHAR(20) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS call_history_user_created_idx
    ON call_history(user_id, created_at DESC);
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS users_device_key_uidx
    ON users(device_key)
    WHERE device_key IS NOT NULL;
  `);
}

function makeNumber() {
  const prefix = Math.random() < 0.5 ? "990" : "680";
  return prefix + String(
    crypto.randomInt(0, 10000000)
  ).padStart(7, "0");
}

async function createUniqueNumber() {
  for (let i = 0; i < 30; i++) {
    const number = makeNumber();

    const result = await pool.query(
      "SELECT 1 FROM users WHERE phone_number=$1",
      [number]
    );

    if (!result.rowCount) return number;
  }

  throw new Error("Benzersiz numara üretilemedi.");
}

function publicUser(row) {
  return {
    id: row.id,
    number: row.phone_number
  };
}

function signToken(user) {
  return jwt.sign(
    { sub: String(user.id) },
    JWT_SECRET,
    { expiresIn: "365d" }
  );
}

// KİMLİK DOĞRULAMA
async function auth(req, res, next) {
  try {
    const value = req.headers.authorization || "";
    const token = value.startsWith("Bearer ")
      ? value.slice(7)
      : "";

    const decoded = jwt.verify(token, JWT_SECRET);

    const result = await pool.query(
      "SELECT id, phone_number FROM users WHERE id=$1",
      [decoded.sub]
    );

    if (!result.rowCount) {
      return res.status(401).json({
        error: "Oturum bulunamadı."
      });
    }

    req.user = result.rows[0];
    next();
  } catch (err) {
    res.status(401).json({
      error: "Oturum geçersiz. Sayfayı yenile."
    });
  }
}

// KAYIT
app.post("/api/register", async (req, res) => {
  try {
    const deviceKey = String(req.body.deviceKey || "");

    if (deviceKey.length < 32 || deviceKey.length > 128) {
      return res.status(400).json({
        error: "Cihaz anahtarı geçersiz."
      });
    }

    let result = await pool.query(
      "SELECT id, phone_number FROM users WHERE device_key=$1",
      [deviceKey]
    );

    if (!result.rowCount) {
      const number = await createUniqueNumber();

      try {
        result = await pool.query(
          `INSERT INTO users(device_key, phone_number)
           VALUES($1,$2)
           RETURNING id, phone_number`,
          [deviceKey, number]
        );
      } catch (err) {
        if (err.code !== "23505") throw err;

        result = await pool.query(
          "SELECT id, phone_number FROM users WHERE device_key=$1",
          [deviceKey]
        );

        if (!result.rowCount) throw err;
      }
    }

    const user = publicUser(result.rows[0]);

    res.json({
      user,
      token: signToken(user)
    });
  } catch (err) {
    console.error("register:", err);
    res.status(500).json({
      error: "Kayıt oluşturulamadı."
    });
  }
});

// NUMARA SORGULAMA
app.get("/api/lookup/:number", auth, async (req, res) => {
  try {
    const number = String(req.params.number).replace(/\D/g, "");

    if (!/^(990|680)\d{7}$/.test(number)) {
      return res.status(400).json({
        error: "Numara biçimi hatalı."
      });
    }

    const result = await pool.query(
      `SELECT display_name AS name
       FROM contacts
       WHERE owner_phone=$1 AND contact_phone=$2`,
      [req.user.phone_number, number]
    );

    res.json({
      name: result.rows[0]?.name || null
    });
  } catch (err) {
    console.error("lookup:", err);
    res.status(500).json({
      error: "Kişi aranamadı."
    });
  }
});

// KİŞİLERİ GETİR
app.get("/api/contacts", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT contact_phone AS number,
              display_name AS name
       FROM contacts
       WHERE owner_phone=$1
       ORDER BY display_name`,
      [req.user.phone_number]
    );

    res.json({
      contacts: result.rows
    });
  } catch (err) {
    console.error("contacts:", err);
    res.status(500).json({
      error: "Kişiler yüklenemedi."
    });
  }
});

// KİŞİ KAYDET
app.post("/api/contacts", auth, async (req, res) => {
  const client = await pool.connect();

  try {
    const number = String(req.body.number || "").replace(/\D/g, "");
    const name = String(req.body.name || "").trim();

    if (!/^(990|680)\d{7}$/.test(number)) {
      return res.status(400).json({
        error: "Geçerli WiFi-Phone numarası gir."
      });
    }

    if (!name || name.length > 40) {
      return res.status(400).json({
        error: "İsim 1-40 karakter olmalı."
      });
    }

    if (number === req.user.phone_number) {
      return res.status(400).json({
        error: "Kendini kişi olarak kaydedemezsin."
      });
    }

    await client.query("BEGIN");

    await client.query(
      `DELETE FROM contacts
       WHERE owner_phone=$1 AND contact_phone=$2`,
      [req.user.phone_number, number]
    );

    await client.query(
      `INSERT INTO contacts
       (owner_phone, contact_phone, display_name)
       VALUES($1,$2,$3)`,
      [req.user.phone_number, number, name]
    );

    await client.query("COMMIT");

    res.json({ ok: true });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("save contact:", err);

    res.status(500).json({
      error: "Kişi kaydedilemedi."
    });
  } finally {
    client.release();
  }
});

// ARAMA GEÇMİŞİ
app.get("/api/history", auth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT other_number AS number,
              other_name AS name,
              status,
              created_at AS "createdAt"
       FROM call_history
       WHERE user_id=$1
       ORDER BY created_at DESC
       LIMIT 100`,
      [req.user.id]
    );

    res.json({
      history: result.rows
    });
  } catch (err) {
    console.error("history:", err);
    res.status(500).json({
      error: "Arama geçmişi yüklenemedi."
    });
  }
});

// ARAMA SİSTEMİ
const onlineUsers = new Map();
const activeCalls = new Map();

function makeCallId() {
  return crypto.randomBytes(18).toString("hex");
}

async function saveHistory(userId, otherNumber, otherName, status) {
  await pool.query(
    `INSERT INTO call_history
     (user_id, other_number, other_name, status)
     VALUES($1,$2,$3,$4)`,
    [userId, otherNumber, otherName || null, status]
  );
}

function socketUser(socket) {
  return socket.user;
}

// SOCKET KİMLİK DOĞRULAMA
io.use(async (socket, next) => {
  try {
    const decoded = jwt.verify(
      socket.handshake.auth?.token || "",
      JWT_SECRET
    );

    const result = await pool.query(
      "SELECT id, phone_number FROM users WHERE id=$1",
      [decoded.sub]
    );

    if (!result.rowCount) {
      return next(new Error("Oturum geçersiz"));
    }

    socket.user = result.rows[0];
    next();
  } catch (err) {
    next(new Error("Kimlik doğrulanamadı"));
  }
});

// SOCKET BAĞLANTISI
io.on("connection", socket => {
  const user = socketUser(socket);

  onlineUsers.set(String(user.id), socket.id);

  // ARAMA BAŞLAT
  socket.on("call:invite", async (data, ack) => {
    try {
      const toNumber = String(data?.toNumber || "").replace(/\D/g, "");

      if (!/^(990|680)\d{7}$/.test(toNumber)) {
        return ack?.({
          ok: false,
          error: "Numara biçimi hatalı."
        });
      }

      if (toNumber === user.phone_number) {
        return ack?.({
          ok: false,
          error: "Kendini arayamazsın."
        });
      }

      const target = await pool.query(
        "SELECT id, phone_number FROM users WHERE phone_number=$1",
        [toNumber]
      );

      if (!target.rowCount) {
        return ack?.({
          ok: false,
          error: "Bu numara kayıtlı değil."
        });
      }

      const recipient = target.rows[0];
      const recipientSocket = onlineUsers.get(String(recipient.id));

      if (!recipientSocket) {
        return ack?.({
          ok: false,
          error: "Kullanıcı şu anda çevrimdışı."
        });
      }

      const callId = makeCallId();

      const callerContact = await pool.query(
        `SELECT display_name
         FROM contacts
         WHERE owner_phone=$1 AND contact_phone=$2`,
        [recipient.phone_number, user.phone_number]
      );

      const callerName =
        callerContact.rows[0]?.display_name || null;

      activeCalls.set(callId, {
        callerId: String(user.id),
        callerNumber: user.phone_number,
        calleeId: String(recipient.id),
        calleeNumber: recipient.phone_number,
        callerSocket: socket.id,
        calleeSocket: recipientSocket,
        status: "ringing"
      });

      socket.join("call:" + callId);

      io.to(recipientSocket).emit("incoming-call", {
        callId,
        fromNumber: user.phone_number,
        name: callerName
      });

      ack?.({
        ok: true,
        callId
      });
    } catch (err) {
      console.error("call invite:", err);

      ack?.({
        ok: false,
        error: "Arama başlatılamadı."
      });
    }
  });

  // ARAMAYI KABUL ET
  socket.on("call:accept", ({ callId } = {}) => {
    const call = activeCalls.get(callId);

    if (!call || String(user.id) !== call.calleeId) return;

    call.status = "active";
    socket.join("call:" + callId);

    io.to(call.callerSocket).emit("call:accepted", {
      callId
    });
  });

  // ARAMAYI REDDET
  socket.on("call:reject", async ({ callId } = {}) => {
    const call = activeCalls.get(callId);

    if (
      !call ||
      (String(user.id) !== call.calleeId &&
       String(user.id) !== call.callerId)
    ) return;

    io.to(call.callerSocket).emit("call:rejected", {
      callId
    });

    try {
      await saveHistory(
        call.callerId,
        call.calleeNumber,
        null,
        "rejected"
      );

      await saveHistory(
        call.calleeId,
        call.callerNumber,
        null,
        "rejected"
      );
    } catch (err) {
      console.error("history reject:", err);
    }

    activeCalls.delete(callId);
  });

  // WEBRTC SİNYALLEŞME
  for (const event of [
    "webrtc:offer",
    "webrtc:answer",
    "webrtc:ice"
  ]) {
    socket.on(event, payload => {
      const call = activeCalls.get(payload?.callId);

      if (
        !call ||
        (String(user.id) !== call.callerId &&
         String(user.id) !== call.calleeId)
      ) return;

      socket.to("call:" + payload.callId).emit(event, payload);
    });
  }

  // ARAMAYI BİTİR
  socket.on("call:end", async ({ callId } = {}) => {
    const call = activeCalls.get(callId);

    if (
      !call ||
      (String(user.id) !== call.callerId &&
       String(user.id) !== call.calleeId)
    ) return;

    io.to("call:" + callId).emit("call:ended", {
      callId
    });

    io.to(call.calleeSocket).emit("call:ended", {
      callId
    });

    try {
      const status =
        call.status === "active" ? "completed" : "missed";

      await saveHistory(
        call.callerId,
        call.calleeNumber,
        null,
        status
      );

      await saveHistory(
        call.calleeId,
        call.callerNumber,
        null,
        status
      );
    } catch (err) {
      console.error("history end:", err);
    }

    activeCalls.delete(callId);
  });

  // BAĞLANTI KESİLİRSE
  socket.on("disconnect", () => {
    if (onlineUsers.get(String(user.id)) === socket.id) {
      onlineUsers.delete(String(user.id));
    }

    for (const [callId, call] of activeCalls) {
      if (
        call.callerSocket === socket.id ||
        call.calleeSocket === socket.id
      ) {
        io.to("call:" + callId).emit("call:ended", {
          callId
        });

        activeCalls.delete(callId);
      }
    }
  });
});

// SAĞLIK KONTROLÜ
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "wifi-phone"
  });
});

// HTML
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// SUNUCUYU BAŞLAT
initDb()
  .then(() => {
    server.listen(PORT, () => {
      console.log(
        `WiFi-Phone sunucusu ${PORT} portunda çalışıyor.`
      );
    });
  })
  .catch(err => {
    console.error("Veritabanı başlatılamadı:", err);
    process.exit(1);
  });

process.on("SIGTERM", async () => {
  await pool.end();
  process.exit(0);
});
    
