const WebSocket = require("ws");
const { ObjectId } = require("mongodb");
const client = require("./mongo");

const DB_NAME = process.env.MONGODB_DB || undefined;
const MAX_HISTORY = 200;
const MAX_MESSAGE_LENGTH = 500;
const CHAT_KEEP_DAYS = 30;
const SETTINGS_COLLECTION = "chat_settings";
const ANNOUNCE_KEY = "chat_announcement";
const RULES_KEY = "chat_rules";

const getDb = async () => {
  await client.connect();
  return DB_NAME ? client.db(DB_NAME) : client.db();
};

const getTokenFromQuery = (req) => {
  try {
    const url = new URL(req.url, "http://localhost");
    return String(url.searchParams.get("token") || "").trim();
  } catch (e) {
    return "";
  }
};

const getUserByToken = async (token) => {
  if (!token) return null;
  const db = await getDb();
  const session = await db.collection("user_sessions").findOne({ token });
  if (!session || session.expiresAt <= new Date()) return null;
  const user = await db.collection("users").findOne({ _id: session.userId });
  if (!user || user.isDisabled) return null;
  return { user, session };
};

const cleanupOldMessages = async () => {
  const db = await getDb();
  const cutoff = Date.now() - CHAT_KEEP_DAYS * 24 * 60 * 60 * 1000;
  await db.collection("chat_messages").deleteMany({ createdAt: { $lt: cutoff } });
};

const loadHistory = async () => {
  const db = await getDb();
  await cleanupOldMessages();
  const list = await db
    .collection("chat_messages")
    .find({})
    .sort({ createdAt: -1 })
    .limit(MAX_HISTORY)
    .toArray();
  return list.reverse();
};

const saveMessage = async (payload) => {
  const db = await getDb();
  await cleanupOldMessages();
  const result = await db.collection("chat_messages").insertOne(payload);
  return result.insertedId;
};

const getGlobalMuteState = async () => {
  const db = await getDb();
  const doc = await db.collection(SETTINGS_COLLECTION).findOne({ key: "global_mute" });
  const now = Date.now();
  const startAt = doc?.startAt ? new Date(doc.startAt).getTime() : null;
  const endAt = doc?.endAt ? new Date(doc.endAt).getTime() : null;
  const manualEnabled = !!doc?.enabled;
  const inRange = !!(startAt && endAt && now >= startAt && now <= endAt);
  return {
    enabled: manualEnabled || inRange,
    startAt,
    endAt,
    manualEnabled,
    inRange,
  };
};

const setGlobalMute = async (enabled) => {
  const db = await getDb();
  await db.collection(SETTINGS_COLLECTION).updateOne(
    { key: "global_mute" },
    { $set: { key: "global_mute", enabled: !!enabled, updatedAt: new Date() } },
    { upsert: true }
  );
};

const setGlobalMuteRange = async (startAt, endAt) => {
  const db = await getDb();
  await db.collection(SETTINGS_COLLECTION).updateOne(
    { key: "global_mute" },
    { $set: { key: "global_mute", startAt: startAt ? new Date(startAt) : null, endAt: endAt ? new Date(endAt) : null, updatedAt: new Date() } },
    { upsert: true }
  );
};

const getAnnouncement = async () => {
  const db = await getDb();
  const doc = await db.collection(SETTINGS_COLLECTION).findOne({ key: ANNOUNCE_KEY });
  if (!doc || !doc.text) return null;
  return {
    text: String(doc.text || "").trim(),
    updatedAt: doc.updatedAt ? new Date(doc.updatedAt).getTime() : null,
  };
};

const setAnnouncement = async (text) => {
  const db = await getDb();
  const clean = String(text || "").trim();
  if (!clean) {
    await db.collection(SETTINGS_COLLECTION).deleteOne({ key: ANNOUNCE_KEY });
    return null;
  }
  await db.collection(SETTINGS_COLLECTION).updateOne(
    { key: ANNOUNCE_KEY },
    { $set: { key: ANNOUNCE_KEY, text: clean, updatedAt: new Date() } },
    { upsert: true }
  );
  return { text: clean, updatedAt: Date.now() };
};

const getRules = async () => {
  const db = await getDb();
  const doc = await db.collection(SETTINGS_COLLECTION).findOne({ key: RULES_KEY });
  return {
    rateLimitSec: Number(doc?.rateLimitSec || 0),
    maxLength: Number(doc?.maxLength || 0),
    allowImage: doc?.allowImage !== false,
    allowLink: doc?.allowLink !== false,
    blocked: Array.isArray(doc?.blocked) ? doc.blocked : [],
    replace: Array.isArray(doc?.replace) ? doc.replace : [],
  };
};

const setRules = async (rules) => {
  const db = await getDb();
  const payload = {
    key: RULES_KEY,
    rateLimitSec: Math.max(0, Number(rules.rateLimitSec || 0)),
    maxLength: Math.max(0, Number(rules.maxLength || 0)),
    allowImage: rules.allowImage !== false,
    allowLink: rules.allowLink !== false,
    blocked: Array.isArray(rules.blocked) ? rules.blocked : [],
    replace: Array.isArray(rules.replace) ? rules.replace : [],
    updatedAt: new Date(),
  };
  await db.collection(SETTINGS_COLLECTION).updateOne(
    { key: RULES_KEY },
    { $set: payload },
    { upsert: true }
  );
  return payload;
};

const getMuteInfo = async (userId) => {
  const db = await getDb();
  const now = new Date();
  const record = await db.collection("chat_mutes").findOne({
    userId,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
  });
  if (!record) return null;
  return {
    userId: String(record.userId || ""),
    expiresAt: record.expiresAt ? record.expiresAt.getTime() : null,
  };
};

const listMutes = async () => {
  const db = await getDb();
  const now = new Date();
  const list = await db
    .collection("chat_mutes")
    .find({ $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] })
    .sort({ expiresAt: 1 })
    .toArray();
  return list.map((item) => ({
    _id: String(item._id),
    userId: String(item.userId || ""),
    nickname: String(item.nickname || ""),
    username: String(item.username || ""),
    expiresAt: item.expiresAt ? item.expiresAt.getTime() : null,
  }));
};

const getUserById = async (id) => {
  if (!id) return null;
  const db = await getDb();
  try {
    return await db.collection("users").findOne({ _id: new ObjectId(id) });
  } catch (e) {
    return null;
  }
};

const safeText = (value) => {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > MAX_MESSAGE_LENGTH ? text.slice(0, MAX_MESSAGE_LENGTH) : text;
};

const initChatWSS = (server) => {
  const wss = new WebSocket.Server({ server, path: "/ws/chat" });
  const clients = new Set();
  const onlineUsers = new Map();
  const lastMessageAt = new Map();
  let lastGlobalSnapshot = "";

  const broadcast = (data) => {
    const text = JSON.stringify(data);
    clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(text);
      }
    });
  };

  const sendToUser = (userId, data) => {
    const targetId = String(userId || "");
    if (!targetId) return;
    const text = JSON.stringify(data);
    onlineUsers.forEach((info, client) => {
      if (String(info.userId) === targetId && client.readyState === WebSocket.OPEN) {
        client.send(text);
      }
    });
  };

  const getOnlineList = () => {
    const list = [];
    onlineUsers.forEach((info) => list.push(info));
    return list;
  };

  const broadcastOnline = () => {
    broadcast({ type: "online_users", data: getOnlineList() });
  };

  const broadcastGlobalMute = async () => {
    let state = await getGlobalMuteState();
    const now = Date.now();
    if (state.endAt && now > state.endAt) {
      await setGlobalMuteRange(null, null);
      state = await getGlobalMuteState();
    }
    const snapshot = JSON.stringify({ enabled: state.enabled, startAt: state.startAt, endAt: state.endAt });
    if (snapshot !== lastGlobalSnapshot) {
      lastGlobalSnapshot = snapshot;
      broadcast({ type: "global_mute", enabled: state.enabled, startAt: state.startAt, endAt: state.endAt });
    }
    return state;
  };

  setInterval(() => {
    broadcastGlobalMute().catch(() => {});
  }, 30000);

  wss.on("connection", async (ws, req) => {
    ws.isAuthed = false;
    ws.user = null;
    clients.add(ws);

    const token = getTokenFromQuery(req);
    if (token) {
      const result = await getUserByToken(token);
      if (result) {
        ws.isAuthed = true;
        ws.user = result.user;
        onlineUsers.set(ws, {
          userId: String(ws.user._id),
          nickname: ws.user.nickname || "",
          username: ws.user.username || "",
        });
        const history = await loadHistory();
        const globalMute = await getGlobalMuteState();
        const muteInfo = await getMuteInfo(ws.user._id);
        const announce = await getAnnouncement();
        const rules = await getRules();
        ws.send(JSON.stringify({ type: "profile", data: { role: ws.user.role || "user", userId: String(ws.user._id), nickname: ws.user.nickname || ws.user.username || "" } }));
        ws.send(JSON.stringify({ type: "global_mute", enabled: globalMute.enabled, startAt: globalMute.startAt, endAt: globalMute.endAt }));
        ws.send(JSON.stringify({ type: "user_mute", data: muteInfo, muted: !!muteInfo }));
        ws.send(JSON.stringify({ type: "announcement", data: announce }));
        ws.send(JSON.stringify({ type: "rules", data: rules }));
        ws.send(JSON.stringify({
          type: "history",
          data: history.map((item) => ({
            ...item,
            _id: String(item._id),
            userId: String(item.userId || ""),
          })),
        }));
        broadcastOnline();
      } else {
        ws.send(JSON.stringify({ type: "error", message: "未登录或登录已过期" }));
        ws.close();
      }
    }

    ws.on("message", async (raw) => {
      let data = null;
      try {
        data = JSON.parse(String(raw || ""));
      } catch (e) {
        return;
      }
      if (!data || typeof data !== "object") return;

      if (data.type === "auth") {
        if (ws.isAuthed) return;
        const result = await getUserByToken(String(data.token || ""));
        if (!result) {
          ws.send(JSON.stringify({ type: "error", message: "未登录或登录已过期" }));
          ws.close();
          return;
        }
        ws.isAuthed = true;
        ws.user = result.user;
        onlineUsers.set(ws, {
          userId: String(ws.user._id),
          nickname: ws.user.nickname || "",
          username: ws.user.username || "",
        });
        const history = await loadHistory();
        const globalMute = await getGlobalMuteState();
        const muteInfo = await getMuteInfo(ws.user._id);
        const announce = await getAnnouncement();
        const rules = await getRules();
        ws.send(JSON.stringify({ type: "profile", data: { role: ws.user.role || "user", userId: String(ws.user._id), nickname: ws.user.nickname || ws.user.username || "" } }));
        ws.send(JSON.stringify({ type: "global_mute", enabled: globalMute.enabled, startAt: globalMute.startAt, endAt: globalMute.endAt }));
        ws.send(JSON.stringify({ type: "user_mute", data: muteInfo, muted: !!muteInfo }));
        ws.send(JSON.stringify({ type: "announcement", data: announce }));
        ws.send(JSON.stringify({ type: "rules", data: rules }));
        ws.send(JSON.stringify({
          type: "history",
          data: history.map((item) => ({
            ...item,
            _id: String(item._id),
            userId: String(item.userId || ""),
          })),
        }));
        broadcastOnline();
        return;
      }

      if (data.type === "message") {
        if (!ws.isAuthed || !ws.user) {
          ws.send(JSON.stringify({ type: "error", message: "未登录或登录已过期" }));
          return;
        }
        const rules = await getRules();
        if (ws.user.role !== "admin" && rules.rateLimitSec > 0) {
          const lastAt = lastMessageAt.get(String(ws.user._id)) || 0;
          if (Date.now() - lastAt < rules.rateLimitSec * 1000) {
            ws.send(JSON.stringify({ type: "error", message: `发送过于频繁，请${rules.rateLimitSec}秒后再试` }));
            return;
          }
        }
        const globalMute = await getGlobalMuteState();
        if (globalMute.enabled && ws.user.role !== "admin") {
          ws.send(JSON.stringify({ type: "error", message: "全局禁言中" }));
          return;
        }
        const muteInfo = await getMuteInfo(ws.user._id);
        if (muteInfo) {
          ws.send(JSON.stringify({ type: "error", message: "你已被禁言" }));
          ws.send(JSON.stringify({ type: "user_mute", data: muteInfo, muted: true }));
          return;
        }
        const message = safeText(data.message);
        if (!message) return;
        let finalMessage = message;
        if (ws.user.role !== "admin") {
          if (rules.maxLength > 0 && message.length > rules.maxLength) {
            ws.send(JSON.stringify({ type: "error", message: `消息长度超限，最多${rules.maxLength}字` }));
            return;
          }
          if (Array.isArray(rules.blocked)) {
            const hit = rules.blocked.find((word) => word && message.includes(word));
            if (hit) {
              ws.send(JSON.stringify({ type: "error", message: "消息包含敏感词" }));
              return;
            }
          }
          const urlRegex = /(https?:\/\/[^\s]+)/ig;
          const imageRegex = /\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$/i;
          const urls = message.match(urlRegex) || [];
          if (urls.length > 0 && rules.allowLink === false) {
            ws.send(JSON.stringify({ type: "error", message: "当前禁止发送链接" }));
            return;
          }
          if (rules.allowImage === false) {
            const hasImage = urls.some((u) => imageRegex.test(u));
            if (hasImage) {
              ws.send(JSON.stringify({ type: "error", message: "当前禁止发送图片链接" }));
              return;
            }
          }
          if (Array.isArray(rules.replace)) {
            rules.replace.forEach((pair) => {
              if (pair && pair.from) {
                finalMessage = finalMessage.split(pair.from).join(String(pair.to || ""));
              }
            });
          }
        }
        const nickname = String(data.nickname || ws.user.nickname || ws.user.username || "").trim();
        const payload = {
          message: finalMessage,
          nickname: nickname || "匿名",
          userId: ws.user._id,
          username: ws.user.username || "",
          avatar: ws.user.avatar || "",
          createdAt: Date.now(),
          deleted: false,
        };
        const insertedId = await saveMessage(payload);
        lastMessageAt.set(String(ws.user._id), Date.now());
        broadcast({
          type: "message",
          data: { ...payload, _id: String(insertedId), userId: String(payload.userId) },
        });
      }

      if (data.type === "delete" || data.type === "soft_delete") {
        if (!ws.isAuthed || !ws.user || ws.user.role !== "admin") return;
        const id = String(data.id || "").trim();
        if (!id) return;
        const db = await getDb();
        try {
          await db.collection("chat_messages").updateOne(
            { _id: new ObjectId(id) },
            { $set: { deleted: true, deletedAt: Date.now(), deletedBy: ws.user._id } },
          );
          broadcast({ type: "update", data: { _id: id, deleted: true } });
        } catch (e) {
          ws.send(JSON.stringify({ type: "error", message: "删除失败" }));
        }
      }

      if (data.type === "mute") {
        if (!ws.isAuthed || !ws.user || ws.user.role !== "admin") return;
        const targetId = String(data.userId || "").trim();
        const minutes = Number(data.minutes || 0);
        if (!targetId) return;
        const db = await getDb();
        if (minutes <= 0) {
          await db.collection("chat_mutes").deleteOne({ userId: new ObjectId(targetId) });
          broadcast({ type: "mute", data: { userId: targetId, minutes: 0, expiresAt: null } });
          sendToUser(targetId, { type: "user_mute", data: { userId: targetId, expiresAt: null }, muted: false });
          return;
        }
        const expiresAt = new Date(Date.now() + minutes * 60 * 1000);
        const targetUser = await getUserById(targetId);
        await db.collection("chat_mutes").updateOne(
          { userId: new ObjectId(targetId) },
          {
            $set: {
              userId: new ObjectId(targetId),
              expiresAt,
              nickname: targetUser?.nickname || "",
              username: targetUser?.username || "",
            },
          },
          { upsert: true }
        );
        broadcast({ type: "mute", data: { userId: targetId, minutes, expiresAt: expiresAt.getTime() } });
        sendToUser(targetId, { type: "user_mute", data: { userId: targetId, expiresAt: expiresAt.getTime() }, muted: true });
      }

      if (data.type === "unmute") {
        if (!ws.isAuthed || !ws.user || ws.user.role !== "admin") return;
        const targetId = String(data.userId || "").trim();
        if (!targetId) return;
        const db = await getDb();
        await db.collection("chat_mutes").deleteOne({ userId: new ObjectId(targetId) });
        broadcast({ type: "mute", data: { userId: targetId, minutes: 0, expiresAt: null } });
        sendToUser(targetId, { type: "user_mute", data: { userId: targetId, expiresAt: null }, muted: false });
      }

      if (data.type === "list_mutes") {
        if (!ws.isAuthed || !ws.user || ws.user.role !== "admin") return;
        const list = await listMutes();
        ws.send(JSON.stringify({ type: "mutes", data: list }));
      }

      if (data.type === "list_online") {
        if (!ws.isAuthed || !ws.user) return;
        ws.send(JSON.stringify({ type: "online_users", data: getOnlineList() }));
      }

      if (data.type === "set_global_mute") {
        if (!ws.isAuthed || !ws.user || ws.user.role !== "admin") return;
        const enabled = !!data.enabled;
        await setGlobalMute(enabled);
        await broadcastGlobalMute();
      }

      if (data.type === "set_global_mute_range") {
        if (!ws.isAuthed || !ws.user || ws.user.role !== "admin") return;
        const startAt = data.startAt ? Number(data.startAt) : null;
        const endAt = data.endAt ? Number(data.endAt) : null;
        await setGlobalMuteRange(startAt, endAt);
        await broadcastGlobalMute();
      }

      if (data.type === "set_announcement") {
        if (!ws.isAuthed || !ws.user || ws.user.role !== "admin") return;
        const text = String(data.text || "");
        const result = await setAnnouncement(text);
        broadcast({ type: "announcement", data: result });
      }

      if (data.type === "set_rules") {
        if (!ws.isAuthed || !ws.user || ws.user.role !== "admin") return;
        const result = await setRules(data.rules || {});
        broadcast({ type: "rules", data: result });
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      onlineUsers.delete(ws);
      broadcastOnline();
    });
  });

  return wss;
};

module.exports = { initChatWSS };
