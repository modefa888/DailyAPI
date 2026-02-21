const Router = require("koa-router");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ObjectId } = require("mongodb");
const client = require("../../utils/mongo");
const { DEFAULT_OFFICIAL_APIS } = require("../../utils/officialApis");
const { DEFAULT_PARSE_APIS } = require("../../utils/parseApis");

const userRouter = new Router();

// 接口信息
const routerInfo = { name: "用户系统", title: "用户管理", subtitle: "注册/登录/管理" };
userRouter.info = routerInfo;

const TOKEN_TTL_MS = Number(process.env.USER_TOKEN_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const DB_NAME = process.env.MONGODB_DB || undefined;
const SESSION_TOUCH_INTERVAL_MS = Number(process.env.USER_SESSION_TOUCH_MS || 60 * 1000);

let indexesReady = false;
const ensureIndexes = async (db) => {
    if (indexesReady) return;
    await db.collection("users").createIndex({ username: 1 }, { unique: true });
    await db.collection("user_sessions").createIndex({ token: 1 }, { unique: true });
    await db.collection("user_sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection("user_sessions").createIndex({ lastSeenAt: -1 });
    await db.collection("official_apis").createIndex({ url: 1 }, { unique: true });
    await db.collection("official_apis").createIndex({ enabled: 1, sort: 1, updatedAt: -1 });
    await db.collection("parse_apis").createIndex({ url: 1 }, { unique: true });
    await db.collection("parse_apis").createIndex({ enabled: 1, sort: 1, updatedAt: -1 });
    await db.collection("route_access").createIndex({ method: 1, path: 1 }, { unique: true });
    await db.collection("route_access").createIndex({ enabled: 1, updatedAt: -1 });
    await db.collection("user_favorites").createIndex({ userId: 1, url: 1 }, { unique: true });
    await db.collection("user_shares").createIndex({ userId: 1, shareId: 1 }, { unique: true });
    await db.collection("user_shares").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection("user_feedback").createIndex({ createdAt: -1 });
    await db.collection("user_feedback").createIndex({ userId: 1, createdAt: -1 });
    indexesReady = true;
};

const getDb = async () => {
    await client.connect();
    const db = DB_NAME ? client.db(DB_NAME) : client.db();
    await ensureIndexes(db);
    return db;
};

const hashPassword = (password, salt = null) => {
    const realSalt = salt || crypto.randomBytes(16).toString("hex");
    const iterations = 120000;
    const keylen = 32;
    const digest = "sha256";
    const hash = crypto.pbkdf2Sync(password, realSalt, iterations, keylen, digest).toString("hex");
    return { salt: realSalt, iterations, keylen, digest, hash };
};

const verifyPassword = (password, user) => {
    const { salt, iterations, keylen, digest, hash } = user;
    const verifyHash = crypto.pbkdf2Sync(password, salt, iterations, keylen, digest).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(verifyHash, "hex"));
};

const sanitizeUser = (user) => {
    if (!user) return null;
        const { password, hash, salt, iterations, keylen, digest, ...rest } = user;
        return rest;
};

const issueToken = () => crypto.randomBytes(32).toString("hex");

const PUBLIC_DIR = path.join(__dirname, "../../public");
const listHtmlPages = () => {
    const results = [];
    const walk = (dir) => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        entries.forEach((entry) => {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
                return;
            }
            if (entry.isFile() && entry.name.endsWith(".html")) {
                const relPath = path.relative(PUBLIC_DIR, fullPath).replace(/\\/g, "/");
                const pagePath = "/" + relPath;
                if (pagePath === "/404.html" || pagePath === "/no-access.html") return;
                results.push(pagePath);
            }
        });
    };
    walk(PUBLIC_DIR);
    return results.sort();
};

const getTokenFromRequest = (ctx) => {
    const headerToken = String(ctx.get("x-user-token") || "").trim();
    if (headerToken) return headerToken;
    const authHeader = String(ctx.get("authorization") || "").trim();
    if (!authHeader) return "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : "";
};

const authMiddleware = async (ctx, next) => {
    const token = getTokenFromRequest(ctx);
    if (!token) {
        ctx.status = 401;
        ctx.body = { code: 401, message: "未登录" };
        return;
    }
    const db = await getDb();
    const session = await db.collection("user_sessions").findOne({ token });
    if (!session || session.expiresAt <= new Date()) {
        ctx.status = 401;
        ctx.body = { code: 401, message: "登录已过期" };
        return;
    }
    const user = await db.collection("users").findOne({ _id: session.userId });
    if (!user) {
        ctx.status = 401;
        ctx.body = { code: 401, message: "用户不存在" };
        return;
    }
    if (user.isDisabled) {
        const reason = user.disabledReason ? `：${user.disabledReason}` : "";
        ctx.status = 403;
        ctx.body = { code: 403, message: `账号已被禁用${reason}` };
        return;
    }
    ctx.state.user = user;
    ctx.state.session = session;
    const now = new Date();
    const lastSeenAt = session.lastSeenAt ? new Date(session.lastSeenAt) : null;
    if (!lastSeenAt || now - lastSeenAt > SESSION_TOUCH_INTERVAL_MS) {
        db.collection("user_sessions")
            .updateOne(
                { _id: session._id },
                {
                    $set: {
                        lastSeenAt: now,
                        lastPage: ctx.request.path || "",
                        ip: ctx.request.ip,
                        userAgent: ctx.headers["user-agent"] || "",
                    },
                },
            )
            .catch(() => {});
        db.collection("users")
            .updateOne({ _id: user._id }, { $set: { lastSeenAt: now } })
            .catch(() => {});
        session.lastSeenAt = now;
    }
    await next();
};

const requireAdmin = async (ctx, next) => {
    const user = ctx.state.user;
    if (!user || user.role !== "admin") {
        ctx.status = 403;
        ctx.body = { code: 403, message: "需要管理员权限" };
        return;
    }
    await next();
};

// 注册
userRouter.post("/user/register", async (ctx) => {
    const { username, password, nickname } = ctx.request.body || {};
    const safeUsername = String(username || "").trim();
    const safePassword = String(password || "").trim();
    if (!safeUsername || !safePassword) {
        ctx.body = { code: 400, message: "用户名或密码不能为空" };
        return;
    }

    const db = await getDb();
    const totalUsers = await db.collection("users").countDocuments();
    const { salt, iterations, keylen, digest, hash } = hashPassword(safePassword);
    const newUser = {
        username: safeUsername,
        nickname: String(nickname || "").trim() || safeUsername,
        role: totalUsers === 0 ? "admin" : "user",
        apiAccess: totalUsers === 0 ? "all" : "normal",
        isDisabled: false,
        disabledReason: "",
        salt,
        iterations,
        keylen,
        digest,
        hash,
        createdAt: new Date(),
        updatedAt: new Date(),
    };

    try {
        const result = await db.collection("users").insertOne(newUser);
        ctx.body = {
            code: 200,
            message: "注册成功",
            data: { id: result.insertedId, username: newUser.username, nickname: newUser.nickname, role: newUser.role },
        };
    } catch (err) {
        if (err && err.code === 11000) {
            ctx.body = { code: 409, message: "用户名已存在" };
            return;
        }
        ctx.body = { code: 500, message: "注册失败" };
    }
});

// 登录
userRouter.post("/user/login", async (ctx) => {
    const { username, password } = ctx.request.body || {};
    const safeUsername = String(username || "").trim();
    const safePassword = String(password || "").trim();
    if (!safeUsername || !safePassword) {
        ctx.body = { code: 400, message: "用户名或密码不能为空" };
        return;
    }
    const db = await getDb();
    const user = await db.collection("users").findOne({ username: safeUsername });
    if (!user || !verifyPassword(safePassword, user)) {
        ctx.body = { code: 401, message: "用户名或密码错误" };
        return;
    }
    if (user.isDisabled) {
        const reason = user.disabledReason ? `：${user.disabledReason}` : "";
        ctx.body = { code: 403, message: `账号已被禁用${reason}` };
        return;
    }
    const token = issueToken();
    const now = new Date();
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
    await db.collection("user_sessions").insertOne({
        userId: user._id,
        token,
        createdAt: now,
        expiresAt,
        lastSeenAt: now,
        lastPage: ctx.request.path || "",
        ip: ctx.request.ip,
        userAgent: ctx.headers["user-agent"] || "",
    });
    ctx.body = {
        code: 200,
        message: "登录成功",
        data: {
            token,
            expiresAt: expiresAt.getTime(),
            user: sanitizeUser(user),
        },
    };
});

// 退出登录
userRouter.post("/user/logout", authMiddleware, async (ctx) => {
    const db = await getDb();
    await db.collection("user_sessions").deleteOne({ _id: ctx.state.session._id });
    ctx.body = { code: 200, message: "已退出" };
});

// 心跳（登录用户）
userRouter.post("/user/heartbeat", authMiddleware, async (ctx) => {
    const db = await getDb();
    const page = String((ctx.request.body || {}).page || "").trim();
    const now = new Date();
    await db.collection("user_sessions").updateOne(
        { _id: ctx.state.session._id },
        {
            $set: {
                lastSeenAt: now,
                lastPage: page || ctx.request.path || "",
                ip: ctx.request.ip,
                userAgent: ctx.headers["user-agent"] || "",
            },
        },
    );
    await db.collection("users").updateOne({ _id: ctx.state.user._id }, { $set: { lastSeenAt: now } });
    ctx.body = { code: 200, message: "ok", data: { lastSeenAt: now.getTime() } };
});

// 验证当前用户密码
userRouter.post("/user/verify-password", authMiddleware, async (ctx) => {
    const { password } = ctx.request.body || {};
    const safePassword = String(password || "").trim();
    if (!safePassword) {
        ctx.body = { code: 400, message: "密码不能为空" };
        return;
    }
    const user = ctx.state.user;
    const ok = verifyPassword(safePassword, user);
    ctx.body = { code: 200, message: ok ? "验证成功" : "验证失败", data: ok };
});

// 当前用户信息
userRouter.get("/user/profile", authMiddleware, async (ctx) => {
    ctx.body = {
        code: 200,
        message: "获取成功",
        data: sanitizeUser(ctx.state.user),
    };
});

// 最近访问记录（登录用户）
userRouter.get("/user/visit-history", authMiddleware, async (ctx) => {
    const db = await getDb();
    const userId = ctx.state.user._id;
    const user = await db.collection("users").findOne({ _id: userId });
    const raw = Array.isArray(user?.visitHistory) ? user.visitHistory : [];
    const now = Date.now();
    const list = [now, ...raw]
        .map((v) => Number(v))
        .filter((v) => Number.isFinite(v))
        .filter((v, idx, arr) => arr.indexOf(v) === idx)
        .slice(0, 5);
    await db.collection("users").updateOne({ _id: userId }, { $set: { visitHistory: list, updatedAt: new Date() } });
    ctx.body = { code: 200, message: "获取成功", data: list };
});

// 更新头像（登录用户）
userRouter.post("/user/avatar", authMiddleware, async (ctx) => {
    const { avatar } = ctx.request.body || {};
    const safeAvatar = String(avatar || "").trim();
    const db = await getDb();
    await db.collection("users").updateOne(
        { _id: ctx.state.user._id },
        { $set: { avatar: safeAvatar, updatedAt: new Date() } }
    );
    const updated = await db.collection("users").findOne({ _id: ctx.state.user._id });
    ctx.body = { code: 200, message: "头像已更新", data: sanitizeUser(updated) };
});

// 用户列表（管理员）- 分页
userRouter.get("/user/list", authMiddleware, requireAdmin, async (ctx) => {
    const page = Math.max(1, Number(ctx.query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(ctx.query.pageSize || 20)));
    const skip = (page - 1) * pageSize;
    const sortKey = String(ctx.query.sortKey || "").trim();
    const sortDir = String(ctx.query.sortDir || "desc").toLowerCase() === "asc" ? 1 : -1;
    const allowedSortKeys = new Set(["favoriteCount", "historyCount", "searchCount", "watchSeconds", "shareCount"]);

    const db = await getDb();
    const total = await db.collection("users").countDocuments();
    let users = [];
    let statsMap = {};
    if (allowedSortKeys.has(sortKey)) {
        const pipeline = [
            {
                $lookup: {
                    from: "user_stats",
                    localField: "_id",
                    foreignField: "userId",
                    as: "stats",
                },
            },
            {
                $addFields: {
                    stats: { $ifNull: [{ $arrayElemAt: ["$stats", 0] }, {}] },
                },
            },
            {
                $addFields: {
                    favoriteCount: { $ifNull: ["$stats.favoriteCount", 0] },
                    historyCount: { $ifNull: ["$stats.historyCount", 0] },
                    searchCount: { $ifNull: ["$stats.searchCount", 0] },
                    watchSeconds: { $ifNull: ["$stats.watchSeconds", 0] },
                    shareCount: { $ifNull: ["$stats.shareCount", 0] },
                },
            },
            { $sort: { [sortKey]: sortDir, createdAt: -1 } },
            { $skip: skip },
            { $limit: pageSize },
        ];
        const result = await db.collection("users").aggregate(pipeline).toArray();
        users = result.map((u) => {
            const { stats, favoriteCount, historyCount, searchCount, watchSeconds, shareCount, ...rest } = u;
            statsMap[String(u._id)] = {
                favoriteCount: favoriteCount || 0,
                historyCount: historyCount || 0,
                searchCount: searchCount || 0,
                shareCount: shareCount || 0,
                watchSeconds: watchSeconds || 0,
                updatedAt: stats && stats.updatedAt ? stats.updatedAt.getTime() : null,
            };
            return rest;
        });
    } else {
        users = await db
            .collection("users")
            .find()
            .sort({ createdAt: -1 })
            .skip(skip)
            .limit(pageSize)
            .toArray();
    }

    ctx.body = {
        code: 200,
        message: "获取成功",
        data: users.map(sanitizeUser),
        statsMap,
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
    };
});

// 页面列表（管理员）
userRouter.get("/user/pages", authMiddleware, requireAdmin, async (ctx) => {
    ctx.body = { code: 200, message: "获取成功", data: listHtmlPages() };
});

// 在线用户（管理员）
userRouter.get("/user/online", authMiddleware, requireAdmin, async (ctx) => {
    const rawWithin = Number(ctx.query.within || 300000);
    const withinMs = Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, rawWithin));
    const since = new Date(Date.now() - withinMs);
    const db = await getDb();
    const sessions = await db
        .collection("user_sessions")
        .aggregate([
            { $match: { lastSeenAt: { $gte: since } } },
            {
                $lookup: {
                    from: "users",
                    localField: "userId",
                    foreignField: "_id",
                    as: "user",
                },
            },
            { $unwind: "$user" },
            { $sort: { lastSeenAt: -1 } },
            { $limit: 500 },
        ])
        .toArray();
    ctx.body = {
        code: 200,
        message: "获取成功",
        withinMs,
        total: sessions.length,
        data: sessions.map((s) => ({
            sessionId: String(s._id),
            userId: String(s.userId),
            username: s.user ? s.user.username : "",
            nickname: s.user ? s.user.nickname : "",
            role: s.user ? s.user.role : "",
            isDisabled: !!(s.user && s.user.isDisabled),
            lastSeenAt: s.lastSeenAt ? s.lastSeenAt.getTime() : 0,
            lastPage: s.lastPage || "",
            ip: s.ip || "",
            userAgent: s.userAgent || "",
            createdAt: s.createdAt ? s.createdAt.getTime() : 0,
        })),
    };
});

// 官方推荐接口列表（管理员）
userRouter.get("/user/official-apis", authMiddleware, requireAdmin, async (ctx) => {
    const db = await getDb();
    let list = await db.collection("official_apis").find().sort({ sort: 1, createdAt: -1 }).toArray();
    if (!list || list.length === 0) {
        const now = new Date();
        const payload = DEFAULT_OFFICIAL_APIS.map((api, index) => ({
            name: api.name,
            url: api.url,
            type: api.type || "vod",
            category: api.category || "adult",
            enabled: true,
            sort: index + 1,
            createdAt: now,
            updatedAt: now,
        }));
        if (payload.length > 0) {
            await db.collection("official_apis").insertMany(payload, { ordered: false });
        }
        list = await db.collection("official_apis").find().sort({ sort: 1, createdAt: -1 }).toArray();
    } else {
        const existingUrls = new Set(list.map((api) => api && api.url).filter(Boolean));
        const now = new Date();
        const missing = DEFAULT_OFFICIAL_APIS.filter((api) => api && api.url && !existingUrls.has(api.url));
        if (missing.length > 0) {
            const baseSort = list.length;
            const payload = missing.map((api, index) => ({
                name: api.name,
                url: api.url,
                type: api.type || "vod",
                category: api.category || "adult",
                enabled: true,
                sort: baseSort + index + 1,
                createdAt: now,
                updatedAt: now,
            }));
            await db.collection("official_apis").insertMany(payload, { ordered: false });
            list = await db.collection("official_apis").find().sort({ sort: 1, createdAt: -1 }).toArray();
        }
    }
    ctx.body = {
        code: 200,
        message: "获取成功",
        data: list.map((item) => ({
            id: String(item._id),
            name: item.name,
            url: item.url,
            type: item.type || "vod",
            category: item.category || "adult",
            enabled: !!item.enabled,
            sort: Number(item.sort || 0),
            createdAt: item.createdAt ? item.createdAt.getTime() : 0,
            updatedAt: item.updatedAt ? item.updatedAt.getTime() : 0,
        })),
    };
});

// 新增官方推荐接口（管理员）
userRouter.post("/user/official-apis", authMiddleware, requireAdmin, async (ctx) => {
    const { name, url, type, category, enabled, sort } = ctx.request.body || {};
    const safeName = String(name || "").trim();
    const safeUrl = String(url || "").trim();
    if (!safeName || !safeUrl) {
        ctx.body = { code: 400, message: "名称或URL不能为空" };
        return;
    }
    const now = new Date();
    const db = await getDb();
    try {
        const result = await db.collection("official_apis").insertOne({
            name: safeName,
            url: safeUrl,
            type: String(type || "vod").trim() || "vod",
            category: String(category || "adult").trim() || "adult",
            enabled: enabled !== false,
            sort: Number(sort || 0),
            createdAt: now,
            updatedAt: now,
        });
        ctx.body = { code: 200, message: "新增成功", data: { id: String(result.insertedId) } };
    } catch (err) {
        if (err && err.code === 11000) {
            ctx.body = { code: 409, message: "URL已存在" };
            return;
        }
        ctx.body = { code: 500, message: "新增失败" };
    }
});

// 批量排序更新（管理员）
userRouter.put("/user/official-apis/sort", authMiddleware, requireAdmin, async (ctx) => {
    const items = Array.isArray(ctx.request.body?.items) ? ctx.request.body.items : [];
    const updates = items
        .map((item) => ({
            id: String(item.id || "").trim(),
            sort: Number(item.sort || 0),
        }))
        .filter((item) => ObjectId.isValid(item.id));
    if (updates.length === 0) {
        ctx.body = { code: 400, message: "无有效排序数据" };
        return;
    }
    const db = await getDb();
    const ops = updates.map((item) => ({
        updateOne: {
            filter: { _id: new ObjectId(item.id) },
            update: { $set: { sort: item.sort, updatedAt: new Date() } },
        },
    }));
    await db.collection("official_apis").bulkWrite(ops, { ordered: false });
    ctx.body = { code: 200, message: "排序已更新", total: updates.length };
});

// 批量启用/停用（管理员）
userRouter.put("/user/official-apis/batch", authMiddleware, requireAdmin, async (ctx) => {
    const ids = Array.isArray(ctx.request.body?.ids) ? ctx.request.body.ids : [];
    const enabled = ctx.request.body?.enabled;
    if (enabled === undefined) {
        ctx.body = { code: 400, message: "缺少 enabled 参数" };
        return;
    }
    const validIds = ids.filter((id) => ObjectId.isValid(String(id || "")));
    if (validIds.length === 0) {
        ctx.body = { code: 400, message: "无有效ID" };
        return;
    }
    const db = await getDb();
    const objectIds = validIds.map((id) => new ObjectId(id));
    const result = await db.collection("official_apis").updateMany(
        { _id: { $in: objectIds } },
        { $set: { enabled: !!enabled, updatedAt: new Date() } },
    );
    ctx.body = { code: 200, message: "更新成功", total: result.modifiedCount };
});

// 更新官方推荐接口（管理员）
userRouter.put("/user/official-apis/:id", authMiddleware, requireAdmin, async (ctx) => {
    const id = String(ctx.params.id || "").trim();
    if (!ObjectId.isValid(id)) {
        ctx.body = { code: 400, message: "ID不合法" };
        return;
    }
    const { name, url, type, category, enabled, sort } = ctx.request.body || {};
    const update = { updatedAt: new Date() };
    if (name !== undefined) update.name = String(name || "").trim();
    if (url !== undefined) update.url = String(url || "").trim();
    if (type !== undefined) update.type = String(type || "vod").trim() || "vod";
    if (category !== undefined) update.category = String(category || "adult").trim() || "adult";
    if (enabled !== undefined) update.enabled = !!enabled;
    if (sort !== undefined) update.sort = Number(sort || 0);
    const db = await getDb();
    try {
        await db.collection("official_apis").updateOne({ _id: new ObjectId(id) }, { $set: update });
        ctx.body = { code: 200, message: "更新成功" };
    } catch (err) {
        if (err && err.code === 11000) {
            ctx.body = { code: 409, message: "URL已存在" };
            return;
        }
        ctx.body = { code: 500, message: "更新失败" };
    }
});

// 删除官方推荐接口（管理员）
userRouter.delete("/user/official-apis/:id", authMiddleware, requireAdmin, async (ctx) => {
    const id = String(ctx.params.id || "").trim();
    if (!ObjectId.isValid(id)) {
        ctx.body = { code: 400, message: "ID不合法" };
        return;
    }
    const db = await getDb();
    await db.collection("official_apis").deleteOne({ _id: new ObjectId(id) });
    ctx.body = { code: 200, message: "已删除" };
});

// 解析接口列表（管理员）
userRouter.get("/user/parse-apis", authMiddleware, requireAdmin, async (ctx) => {
    const db = await getDb();
    let list = await db.collection("parse_apis").find().sort({ sort: 1, createdAt: -1 }).toArray();
    if (!list || list.length === 0) {
        const now = new Date();
        const payload = DEFAULT_PARSE_APIS.map((api, index) => ({
            name: api.name,
            url: api.url,
            enabled: true,
            sort: index + 1,
            createdAt: now,
            updatedAt: now,
        }));
        if (payload.length > 0) {
            await db.collection("parse_apis").insertMany(payload, { ordered: false });
        }
        list = await db.collection("parse_apis").find().sort({ sort: 1, createdAt: -1 }).toArray();
    }
    ctx.body = {
        code: 200,
        message: "获取成功",
        data: list.map((item) => ({
            id: String(item._id),
            name: item.name,
            url: item.url,
            enabled: !!item.enabled,
            sort: Number(item.sort || 0),
            createdAt: item.createdAt ? item.createdAt.getTime() : 0,
            updatedAt: item.updatedAt ? item.updatedAt.getTime() : 0,
        })),
    };
});

// 新增解析接口（管理员）
userRouter.post("/user/parse-apis", authMiddleware, requireAdmin, async (ctx) => {
    const { name, url, enabled, sort } = ctx.request.body || {};
    const safeName = String(name || "").trim();
    const safeUrl = String(url || "").trim();
    if (!safeName || !safeUrl) {
        ctx.body = { code: 400, message: "名称或URL不能为空" };
        return;
    }
    const now = new Date();
    const db = await getDb();
    try {
        const result = await db.collection("parse_apis").insertOne({
            name: safeName,
            url: safeUrl,
            enabled: enabled !== false,
            sort: Number(sort || 0),
            createdAt: now,
            updatedAt: now,
        });
        ctx.body = { code: 200, message: "新增成功", data: { id: String(result.insertedId) } };
    } catch (err) {
        if (err && err.code === 11000) {
            ctx.body = { code: 409, message: "URL已存在" };
            return;
        }
        ctx.body = { code: 500, message: "新增失败" };
    }
});

// 批量排序更新（管理员）
userRouter.put("/user/parse-apis/sort", authMiddleware, requireAdmin, async (ctx) => {
    const items = Array.isArray(ctx.request.body?.items) ? ctx.request.body.items : [];
    const updates = items
        .map((item) => ({
            id: String(item.id || "").trim(),
            sort: Number(item.sort || 0),
        }))
        .filter((item) => ObjectId.isValid(item.id));
    if (updates.length === 0) {
        ctx.body = { code: 400, message: "无有效排序数据" };
        return;
    }
    const db = await getDb();
    const ops = updates.map((item) => ({
        updateOne: {
            filter: { _id: new ObjectId(item.id) },
            update: { $set: { sort: item.sort, updatedAt: new Date() } },
        },
    }));
    await db.collection("parse_apis").bulkWrite(ops, { ordered: false });
    ctx.body = { code: 200, message: "排序已更新", total: updates.length };
});

// 批量启用/停用（管理员）
userRouter.put("/user/parse-apis/batch", authMiddleware, requireAdmin, async (ctx) => {
    const ids = Array.isArray(ctx.request.body?.ids) ? ctx.request.body.ids : [];
    const enabled = ctx.request.body?.enabled;
    if (enabled === undefined) {
        ctx.body = { code: 400, message: "缺少 enabled 参数" };
        return;
    }
    const validIds = ids.filter((id) => ObjectId.isValid(String(id || "")));
    if (validIds.length === 0) {
        ctx.body = { code: 400, message: "无有效ID" };
        return;
    }
    const db = await getDb();
    const objectIds = validIds.map((id) => new ObjectId(id));
    const result = await db.collection("parse_apis").updateMany(
        { _id: { $in: objectIds } },
        { $set: { enabled: !!enabled, updatedAt: new Date() } },
    );
    ctx.body = { code: 200, message: "更新成功", total: result.modifiedCount };
});

// 更新解析接口（管理员）
userRouter.put("/user/parse-apis/:id", authMiddleware, requireAdmin, async (ctx) => {
    const id = String(ctx.params.id || "").trim();
    if (!ObjectId.isValid(id)) {
        ctx.body = { code: 400, message: "ID不合法" };
        return;
    }
    const { name, url, enabled, sort } = ctx.request.body || {};
    const update = { updatedAt: new Date() };
    if (name !== undefined) update.name = String(name || "").trim();
    if (url !== undefined) update.url = String(url || "").trim();
    if (enabled !== undefined) update.enabled = !!enabled;
    if (sort !== undefined) update.sort = Number(sort || 0);
    const db = await getDb();
    try {
        await db.collection("parse_apis").updateOne({ _id: new ObjectId(id) }, { $set: update });
        ctx.body = { code: 200, message: "更新成功" };
    } catch (err) {
        if (err && err.code === 11000) {
            ctx.body = { code: 409, message: "URL已存在" };
            return;
        }
        ctx.body = { code: 500, message: "更新失败" };
    }
});

// 删除解析接口（管理员）
userRouter.delete("/user/parse-apis/:id", authMiddleware, requireAdmin, async (ctx) => {
    const id = String(ctx.params.id || "").trim();
    if (!ObjectId.isValid(id)) {
        ctx.body = { code: 400, message: "ID不合法" };
        return;
    }
    const db = await getDb();
    await db.collection("parse_apis").deleteOne({ _id: new ObjectId(id) });
    ctx.body = { code: 200, message: "已删除" };
});

// 解析接口列表（普通用户可用）
userRouter.get("/parse-apis", async (ctx) => {
    const db = await getDb();
    let list = await db.collection("parse_apis").find().sort({ sort: 1, createdAt: -1 }).toArray();
    if (!list || list.length === 0) {
        const now = new Date();
        const payload = DEFAULT_PARSE_APIS.map((api, index) => ({
            name: api.name,
            url: api.url,
            enabled: true,
            sort: index + 1,
            createdAt: now,
            updatedAt: now,
        }));
        if (payload.length > 0) {
            await db.collection("parse_apis").insertMany(payload, { ordered: false });
        }
        list = await db.collection("parse_apis").find().sort({ sort: 1, createdAt: -1 }).toArray();
    }
    const data = list
        .filter((item) => item && item.enabled)
        .map((item) => ({
            name: item.name,
            url: item.url,
        }));
    ctx.body = { code: 200, message: "获取成功", data };
});

// 路由访问控制列表（管理员）
userRouter.get("/user/route-access", authMiddleware, requireAdmin, async (ctx) => {
    const db = await getDb();
    const list = await db.collection("route_access").find().sort({ updatedAt: -1 }).toArray();
    ctx.body = {
        code: 200,
        message: "获取成功",
        data: list.map((item) => ({
            id: String(item._id),
            method: String(item.method || "*").toUpperCase(),
            path: String(item.path || "").trim() || "/",
            access: String(item.access || "open"),
            note: String(item.note || ""),
            enabled: item.enabled !== false,
            createdAt: item.createdAt ? item.createdAt.getTime() : 0,
            updatedAt: item.updatedAt ? item.updatedAt.getTime() : 0,
        })),
    };
});

// 批量更新路由访问控制（管理员）
userRouter.put("/user/route-access/batch", authMiddleware, requireAdmin, async (ctx) => {
    const items = Array.isArray(ctx.request.body?.items) ? ctx.request.body.items : [];
    const normalized = items
        .map((item) => ({
            method: String(item.method || "*").trim().toUpperCase() || "*",
            path: String(item.path || "").trim() || "/",
            access: item.access !== undefined ? String(item.access || "open").trim().toLowerCase() : undefined,
            enabled: item.enabled !== undefined ? !!item.enabled : undefined,
            note: item.note !== undefined ? String(item.note || "").trim() : undefined,
        }))
        .filter((item) => !!item.path);
    if (normalized.length === 0) {
        ctx.body = { code: 400, message: "无有效配置" };
        return;
    }
    const now = new Date();
    const db = await getDb();
    const ops = normalized.map((item) => {
        const update = { updatedAt: now };
        if (item.access !== undefined) update.access = item.access;
        if (item.enabled !== undefined) update.enabled = item.enabled;
        if (item.note !== undefined) update.note = item.note;
        const onInsert = { createdAt: now };
        if (item.access === undefined) onInsert.access = "open";
        if (item.enabled === undefined) onInsert.enabled = false;
        return {
            updateOne: {
                filter: { method: item.method, path: item.path },
                update: {
                    $set: update,
                    $setOnInsert: onInsert,
                },
                upsert: true,
            },
        };
    });
    await db.collection("route_access").bulkWrite(ops, { ordered: false });
    ctx.body = { code: 200, message: "更新成功", total: normalized.length };
});

// 获取喜欢列表（登录用户）
userRouter.get("/user/favorites", authMiddleware, async (ctx) => {
    const db = await getDb();
    const favorites = await db
        .collection("user_favorites")
        .find({ userId: ctx.state.user._id })
        .sort({ createdAt: -1 })
        .toArray();
    ctx.body = {
        code: 200,
        message: "获取成功",
        data: favorites.map((item) => ({
            title: item.title,
            url: item.url,
            pic: item.pic,
            source: item.source,
            timestamp: item.createdAt ? item.createdAt.getTime() : Date.now(),
        })),
    };
});

// 获取喜欢列表（管理员指定用户）
userRouter.get("/user/:id/favorites", authMiddleware, requireAdmin, async (ctx) => {
    const { id } = ctx.params;
    if (!ObjectId.isValid(id)) {
        ctx.body = { code: 400, message: "用户ID不合法" };
        return;
    }
    const db = await getDb();
    const favorites = await db
        .collection("user_favorites")
        .find({ userId: new ObjectId(id) })
        .sort({ createdAt: -1 })
        .toArray();
    ctx.body = {
        code: 200,
        message: "获取成功",
        data: favorites.map((item) => ({
            title: item.title,
            url: item.url,
            pic: item.pic,
            source: item.source,
            timestamp: item.createdAt ? item.createdAt.getTime() : Date.now(),
        })),
    };
});

// 删除喜欢（管理员指定用户）
userRouter.delete("/user/:id/favorites", authMiddleware, requireAdmin, async (ctx) => {
    const { id } = ctx.params;
    if (!ObjectId.isValid(id)) {
        ctx.body = { code: 400, message: "用户ID不合法" };
        return;
    }
    const url = String(ctx.request.body?.url || "").trim();
    if (!url) {
        ctx.body = { code: 400, message: "缺少 url 参数" };
        return;
    }
    const db = await getDb();
    await db.collection("user_favorites").deleteOne({ userId: new ObjectId(id), url });
    ctx.body = { code: 200, message: "已删除" };
});

// 添加喜欢（登录用户）
userRouter.post("/user/favorites", authMiddleware, async (ctx) => {
    const { title, url, pic, source } = ctx.request.body || {};
    const safeUrl = String(url || "").trim();
    if (!safeUrl) {
        ctx.body = { code: 400, message: "视频地址不能为空" };
        return;
    }
    const db = await getDb();
    const now = new Date();
    await db.collection("user_favorites").updateOne(
        { userId: ctx.state.user._id, url: safeUrl },
        {
            $set: {
                title: String(title || "").trim(),
                pic: String(pic || "").trim(),
                source: String(source || "").trim(),
                updatedAt: now,
            },
            $setOnInsert: {
                createdAt: now,
            },
        },
        { upsert: true }
    );
    ctx.body = { code: 200, message: "已加入喜欢" };
});

// 取消喜欢（登录用户）
userRouter.delete("/user/favorites", authMiddleware, async (ctx) => {
    const { url } = ctx.request.body || {};
    const safeUrl = String(url || "").trim();
    if (!safeUrl) {
        ctx.body = { code: 400, message: "视频地址不能为空" };
        return;
    }
    const db = await getDb();
    await db.collection("user_favorites").deleteOne({ userId: ctx.state.user._id, url: safeUrl });
    ctx.body = { code: 200, message: "已取消喜欢" };
});

// 清空喜欢（登录用户）
userRouter.delete("/user/favorites/all", authMiddleware, async (ctx) => {
    const db = await getDb();
    await db.collection("user_favorites").deleteMany({ userId: ctx.state.user._id });
    ctx.body = { code: 200, message: "喜欢已清空" };
});

const escapeRegex = (value) => String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// 提交用户反馈（登录用户）
userRouter.post("/user/feedback", authMiddleware, async (ctx) => {
    const { type, message, nickname, page } = ctx.request.body || {};
    const safeMessage = String(message || "").trim();
    if (!safeMessage) {
        ctx.body = { code: 400, message: "内容不能为空" };
        return;
    }
    const safeType = String(type || "反馈").trim() || "反馈";
    const safeNickname = String(nickname || "").trim();
    const safePage = String(page || "").trim();
    const now = new Date();
    const user = ctx.state.user || {};
    const payload = {
        userId: user._id,
        username: String(user.username || "").trim(),
        userNickname: String(user.nickname || "").trim(),
        nickname: safeNickname,
        type: safeType,
        message: safeMessage,
        page: safePage,
        userAgent: ctx.headers["user-agent"] || "",
        replies: [],
        createdAt: now,
        updatedAt: now,
    };
    const db = await getDb();
    const result = await db.collection("user_feedback").insertOne(payload);
    ctx.body = { code: 200, message: "提交成功", data: { id: result.insertedId } };
});

// 用户反馈列表（管理员）
userRouter.get("/user/feedback", authMiddleware, requireAdmin, async (ctx) => {
    const page = Math.max(1, Number(ctx.query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(ctx.query.pageSize || 20)));
    const skip = (page - 1) * pageSize;
    const keyword = String(ctx.query.keyword || "").trim();
    const filter = {};
    if (keyword) {
        const reg = new RegExp(escapeRegex(keyword), "i");
        filter.$or = [
            { message: reg },
            { username: reg },
            { nickname: reg },
            { userNickname: reg },
            { type: reg },
        ];
    }
    const db = await getDb();
    const total = await db.collection("user_feedback").countDocuments(filter);
    const list = await db
        .collection("user_feedback")
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .toArray();
    ctx.body = {
        code: 200,
        message: "获取成功",
        data: list.map((item) => ({
            id: item._id,
            userId: item.userId ? String(item.userId) : "",
            username: item.username || "",
            userNickname: item.userNickname || "",
            nickname: item.nickname || "",
            type: item.type || "",
            message: item.message || "",
            page: item.page || "",
            userAgent: item.userAgent || "",
            replies: Array.isArray(item.replies)
                ? item.replies.map((reply) => ({
                    id: reply.id || "",
                    role: reply.role || "",
                    userId: reply.userId ? String(reply.userId) : "",
                    nickname: reply.nickname || "",
                    message: reply.message || "",
                    createdAt: reply.createdAt ? reply.createdAt.getTime() : 0,
                }))
                : [],
            createdAt: item.createdAt ? item.createdAt.getTime() : 0,
            updatedAt: item.updatedAt ? item.updatedAt.getTime() : 0,
        })),
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
    };
});

// 删除用户反馈（管理员）
userRouter.delete("/user/feedback/:id", authMiddleware, requireAdmin, async (ctx) => {
    const { id } = ctx.params;
    if (!ObjectId.isValid(id)) {
        ctx.body = { code: 400, message: "反馈ID不合法" };
        return;
    }
    const db = await getDb();
    await db.collection("user_feedback").deleteOne({ _id: new ObjectId(id) });
    ctx.body = { code: 200, message: "已删除" };
});

// 获取自己的反馈（登录用户）
userRouter.get("/user/feedback/self", authMiddleware, async (ctx) => {
    const page = Math.max(1, Number(ctx.query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(ctx.query.pageSize || 20)));
    const skip = (page - 1) * pageSize;
    const db = await getDb();
    const filter = { userId: ctx.state.user._id };
    const total = await db.collection("user_feedback").countDocuments(filter);
    const list = await db
        .collection("user_feedback")
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(pageSize)
        .toArray();
    ctx.body = {
        code: 200,
        message: "获取成功",
        data: list.map((item) => ({
            id: item._id,
            type: item.type || "",
            message: item.message || "",
            page: item.page || "",
            replies: Array.isArray(item.replies)
                ? item.replies.map((reply) => ({
                    id: reply.id || "",
                    role: reply.role || "",
                    userId: reply.userId ? String(reply.userId) : "",
                    nickname: reply.nickname || "",
                    message: reply.message || "",
                    createdAt: reply.createdAt ? reply.createdAt.getTime() : 0,
                }))
                : [],
            createdAt: item.createdAt ? item.createdAt.getTime() : 0,
            updatedAt: item.updatedAt ? item.updatedAt.getTime() : 0,
        })),
        page,
        pageSize,
        total,
        totalPages: Math.ceil(total / pageSize),
    };
});

// 回复反馈（登录用户/管理员）
userRouter.post("/user/feedback/:id/reply", authMiddleware, async (ctx) => {
    const { id } = ctx.params;
    if (!ObjectId.isValid(id)) {
        ctx.body = { code: 400, message: "反馈ID不合法" };
        return;
    }
    const { message } = ctx.request.body || {};
    const safeMessage = String(message || "").trim();
    if (!safeMessage) {
        ctx.body = { code: 400, message: "回复内容不能为空" };
        return;
    }
    const db = await getDb();
    const feedback = await db.collection("user_feedback").findOne({ _id: new ObjectId(id) });
    if (!feedback) {
        ctx.body = { code: 404, message: "反馈不存在" };
        return;
    }
    const user = ctx.state.user || {};
    const isAdmin = user.role === "admin";
    if (!isAdmin && String(feedback.userId) !== String(user._id)) {
        ctx.body = { code: 403, message: "无权限回复" };
        return;
    }
    if (!isAdmin && String(feedback.userId) === String(user._id)) {
        const replies = Array.isArray(feedback.replies) ? feedback.replies : [];
        const hasAdminReply = replies.some((reply) => reply && reply.role === "admin");
        if (!hasAdminReply) {
            ctx.body = { code: 403, message: "不能回复自己的消息" };
            return;
        }
    }
    const now = new Date();
    const reply = {
        id: crypto.randomBytes(8).toString("hex"),
        role: isAdmin ? "admin" : "user",
        userId: user._id,
        nickname: String(user.nickname || user.username || "").trim(),
        message: safeMessage,
        createdAt: now,
    };
    await db.collection("user_feedback").updateOne(
        { _id: feedback._id },
        {
            $push: { replies: reply },
            $set: { updatedAt: now },
        }
    );
    ctx.body = { code: 200, message: "回复成功" };
});

const parseExpireSeconds = (value) => {
    const seconds = Number(value || 0);
    if (!Number.isFinite(seconds) || seconds < 0) return 0;
    return Math.floor(seconds);
};

const toBase64Url = (buf) =>
    buf
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");

const generateShareId = async (db, attempts = 6) => {
    for (let i = 0; i < attempts; i += 1) {
        const candidate = `s_${toBase64Url(crypto.randomBytes(6))}`;
        const exists = await db.collection("user_shares").findOne({ shareId: candidate });
        if (!exists) return candidate;
    }
    return `s_${toBase64Url(crypto.randomBytes(9))}`;
};

const buildExpiresAt = (seconds, fallbackMs) => {
    const safeSeconds = parseExpireSeconds(seconds);
    if (safeSeconds > 0) {
        return new Date(Date.now() + safeSeconds * 1000);
    }
    const fallback = Number(fallbackMs || 0);
    if (Number.isFinite(fallback) && fallback > 0) {
        return new Date(fallback);
    }
    return null;
};

// 获取分享列表（登录用户）
userRouter.get("/user/shares", authMiddleware, async (ctx) => {
    const db = await getDb();
    const shares = await db
        .collection("user_shares")
        .find({ userId: ctx.state.user._id })
        .sort({ createdAt: -1 })
        .toArray();
    ctx.body = {
        code: 200,
        message: "获取成功",
        data: shares.map((item) => ({
            shareId: item.shareId,
            url: item.url,
            title: item.title,
            pic: item.pic,
            source: item.source,
            viewCount: Number(item.viewCount || 0),
            lastViewAt: item.lastViewAt ? item.lastViewAt.getTime() : null,
            expireSeconds: item.expireSeconds || 0,
            expiresAt: item.expiresAt ? item.expiresAt.getTime() : 0,
            createdAt: item.createdAt ? item.createdAt.getTime() : Date.now(),
            updatedAt: item.updatedAt ? item.updatedAt.getTime() : null,
        })),
    };
});

// 获取分享列表（管理员指定用户）
userRouter.get("/user/:id/shares", authMiddleware, requireAdmin, async (ctx) => {
    const { id } = ctx.params;
    if (!ObjectId.isValid(id)) {
        ctx.body = { code: 400, message: "用户ID不合法" };
        return;
    }
    const db = await getDb();
    const shares = await db
        .collection("user_shares")
        .find({ userId: new ObjectId(id) })
        .sort({ createdAt: -1 })
        .toArray();
    ctx.body = {
        code: 200,
        message: "获取成功",
        data: shares.map((item) => ({
            shareId: item.shareId,
            url: item.url,
            title: item.title,
            pic: item.pic,
            source: item.source,
            viewCount: Number(item.viewCount || 0),
            lastViewAt: item.lastViewAt ? item.lastViewAt.getTime() : null,
            expireSeconds: item.expireSeconds || 0,
            expiresAt: item.expiresAt ? item.expiresAt.getTime() : 0,
            createdAt: item.createdAt ? item.createdAt.getTime() : Date.now(),
            updatedAt: item.updatedAt ? item.updatedAt.getTime() : null,
        })),
    };
});

// 删除分享（管理员指定用户）
userRouter.delete("/user/:id/shares", authMiddleware, requireAdmin, async (ctx) => {
    const { id } = ctx.params;
    if (!ObjectId.isValid(id)) {
        ctx.body = { code: 400, message: "用户ID不合法" };
        return;
    }
    const shareId = String(ctx.request.body?.shareId || "").trim();
    if (!shareId) {
        ctx.body = { code: 400, message: "缺少 shareId 参数" };
        return;
    }
    const db = await getDb();
    await db.collection("user_shares").deleteOne({ userId: new ObjectId(id), shareId });
    ctx.body = { code: 200, message: "已删除" };
});

// 保存分享（登录用户）
userRouter.post("/user/shares", authMiddleware, async (ctx) => {
    const { shareId, url, title, pic, source, expireSeconds, expiresAt } = ctx.request.body || {};
    let safeShareId = String(shareId || "").trim();
    const safeUrl = String(url || "").trim();
    if (!safeUrl) {
        ctx.body = { code: 400, message: "视频地址不能为空" };
        return;
    }
    const db = await getDb();
    if (!safeShareId) {
        safeShareId = await generateShareId(db);
    }
    const now = new Date();
    const seconds = parseExpireSeconds(expireSeconds);
    const expiry = buildExpiresAt(seconds, expiresAt);
    await db.collection("user_shares").updateOne(
        { userId: ctx.state.user._id, shareId: safeShareId },
        {
            $set: {
                url: safeUrl,
                title: String(title || "").trim(),
                pic: String(pic || "").trim(),
                source: String(source || "").trim(),
                expireSeconds: seconds,
                expiresAt: expiry,
                updatedAt: now,
            },
            $setOnInsert: {
                createdAt: now,
                viewCount: 0,
                lastViewAt: null,
            },
        },
        { upsert: true }
    );
    ctx.body = { code: 200, message: "分享已保存", data: { shareId: safeShareId } };
});

// 更新分享有效期（登录用户）
userRouter.put("/user/shares/:shareId", authMiddleware, async (ctx) => {
    const { shareId } = ctx.params;
    const safeShareId = String(shareId || "").trim();
    if (!safeShareId) {
        ctx.body = { code: 400, message: "分享ID不能为空" };
        return;
    }
    const { expireSeconds, expiresAt } = ctx.request.body || {};
    const seconds = parseExpireSeconds(expireSeconds);
    const expiry = buildExpiresAt(seconds, expiresAt);
    const db = await getDb();
    await db.collection("user_shares").updateOne(
        { userId: ctx.state.user._id, shareId: safeShareId },
        {
            $set: {
                expireSeconds: seconds,
                expiresAt: expiry,
                updatedAt: new Date(),
            },
        }
    );
    ctx.body = { code: 200, message: "分享有效期已更新" };
});

// 取消分享（登录用户）
userRouter.delete("/user/shares/:shareId", authMiddleware, async (ctx) => {
    const { shareId } = ctx.params;
    const safeShareId = String(shareId || "").trim();
    if (!safeShareId) {
        ctx.body = { code: 400, message: "分享ID不能为空" };
        return;
    }
    const db = await getDb();
    await db.collection("user_shares").deleteOne({ userId: ctx.state.user._id, shareId: safeShareId });
    ctx.body = { code: 200, message: "分享已取消" };
});

// 更新用户统计（登录用户）
userRouter.post("/user/stats", authMiddleware, async (ctx) => {
    const payload = ctx.request.body || {};
    const stats = {
        favoriteCount: Math.max(0, Number(payload.favoriteCount || 0)),
        historyCount: Math.max(0, Number(payload.historyCount || 0)),
        searchCount: Math.max(0, Number(payload.searchCount || 0)),
        shareCount: Math.max(0, Number(payload.shareCount || 0)),
        watchSeconds: Math.max(0, Number(payload.watchSeconds || 0)),
    };
    const db = await getDb();
    await db.collection("user_stats").updateOne(
        { userId: ctx.state.user._id },
        {
            $set: {
                ...stats,
                updatedAt: new Date(),
            },
            $setOnInsert: {
                userId: ctx.state.user._id,
                createdAt: new Date(),
            },
        },
        { upsert: true }
    );
    ctx.body = { code: 200, message: "已更新", data: stats };
});

// 获取用户统计（登录用户）
userRouter.get("/user/stats", authMiddleware, async (ctx) => {
    const db = await getDb();
    const stats = await db.collection("user_stats").findOne({ userId: ctx.state.user._id });
    ctx.body = {
        code: 200,
        message: "获取成功",
        data: {
            favoriteCount: Math.max(0, Number(stats?.favoriteCount || 0)),
            historyCount: Math.max(0, Number(stats?.historyCount || 0)),
            searchCount: Math.max(0, Number(stats?.searchCount || 0)),
            shareCount: Math.max(0, Number(stats?.shareCount || 0)),
            watchSeconds: Math.max(0, Number(stats?.watchSeconds || 0)),
            updatedAt: stats?.updatedAt ? stats.updatedAt.getTime() : 0,
        },
    };
});

// 获取用户统计（管理员批量）
userRouter.post("/user/stats/batch", authMiddleware, requireAdmin, async (ctx) => {
    const ids = Array.isArray(ctx.request.body?.ids) ? ctx.request.body.ids : [];
    const objectIds = ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
    if (objectIds.length === 0) {
        ctx.body = { code: 200, message: "获取成功", data: {} };
        return;
    }
    const db = await getDb();
    const stats = await db
        .collection("user_stats")
        .find({ userId: { $in: objectIds } })
        .toArray();
    const map = {};
    stats.forEach((item) => {
        map[String(item.userId)] = {
            favoriteCount: item.favoriteCount || 0,
            shareCount: item.shareCount || 0,
            historyCount: item.historyCount || 0,
            searchCount: item.searchCount || 0,
            watchSeconds: item.watchSeconds || 0,
            updatedAt: item.updatedAt ? item.updatedAt.getTime() : null,
        };
    });
    ctx.body = { code: 200, message: "获取成功", data: map };
});

// 禁用/启用用户（管理员）
userRouter.post("/user/:id/disable", authMiddleware, requireAdmin, async (ctx) => {
    const { id } = ctx.params;
    if (!ObjectId.isValid(id)) {
        ctx.body = { code: 400, message: "无效的用户ID" };
        return;
    }
    const disabled = Boolean(ctx.request.body?.disabled);
    const reason = String(ctx.request.body?.reason || "").trim();
    const db = await getDb();
    const targetUser = await db.collection("users").findOne({ _id: new ObjectId(id) });
    if (!targetUser) {
        ctx.body = { code: 404, message: "用户不存在" };
        return;
    }
    if (targetUser.role === "admin" && disabled) {
        ctx.body = { code: 400, message: "不能禁用管理员" };
        return;
    }
    if (String(ctx.state.user._id) === String(id) && disabled) {
        ctx.body = { code: 400, message: "不能禁用自己" };
        return;
    }
    await db.collection("users").updateOne(
        { _id: new ObjectId(id) },
        { $set: { isDisabled: disabled, disabledReason: disabled ? reason : "", updatedAt: new Date() } }
    );
    if (disabled) {
        await db.collection("user_sessions").deleteMany({ userId: new ObjectId(id) });
    }
    const updated = await db.collection("users").findOne({ _id: new ObjectId(id) });
    ctx.body = { code: 200, message: disabled ? "已禁用" : "已启用", data: sanitizeUser(updated) };
});

// 更新备注（管理员）
userRouter.post("/user/:id/note", authMiddleware, requireAdmin, async (ctx) => {
    const { id } = ctx.params;
    if (!ObjectId.isValid(id)) {
        ctx.body = { code: 400, message: "无效的用户ID" };
        return;
    }
    const note = String(ctx.request.body?.note || "").trim();
    const db = await getDb();
    await db.collection("users").updateOne(
        { _id: new ObjectId(id) },
        { $set: { note, updatedAt: new Date() } }
    );
    const updated = await db.collection("users").findOne({ _id: new ObjectId(id) });
    ctx.body = { code: 200, message: "备注已更新", data: sanitizeUser(updated) };
});

// 更新页面权限（管理员）
userRouter.post("/user/:id/pages", authMiddleware, requireAdmin, async (ctx) => {
    const { id } = ctx.params;
    if (!ObjectId.isValid(id)) {
        ctx.body = { code: 400, message: "无效的用户ID" };
        return;
    }
    const pages = Array.isArray(ctx.request.body?.pages) ? ctx.request.body.pages : [];
    const safePages = pages
        .map((p) => String(p || "").trim())
        .filter(Boolean);
    const db = await getDb();
    await db.collection("users").updateOne(
        { _id: new ObjectId(id) },
        { $set: { blockedPages: safePages, pagesLimited: true, updatedAt: new Date() }, $unset: { allowedPages: "" } }
    );
    const updated = await db.collection("users").findOne({ _id: new ObjectId(id) });
    ctx.body = { code: 200, message: "权限已更新", data: sanitizeUser(updated) };
});

// 更新用户（自己或管理员）
userRouter.put("/user/:id", authMiddleware, async (ctx) => {
    const { id } = ctx.params;
    const user = ctx.state.user;
    if (!ObjectId.isValid(id)) {
        ctx.body = { code: 400, message: "无效的用户ID" };
        return;
    }
    if (user.role !== "admin" && String(user._id) !== String(id)) {
        ctx.status = 403;
        ctx.body = { code: 403, message: "无权限" };
        return;
    }
    const { nickname, password, role, profileNote, avatar, adminNote, visitHistory, apiAccess } = ctx.request.body || {};
    const update = { updatedAt: new Date() };
    if (nickname !== undefined) update.nickname = String(nickname || "").trim();
    if (profileNote !== undefined) update.profileNote = String(profileNote || "").trim();
    if (avatar !== undefined) update.avatar = String(avatar || "").trim();
    if (password) {
        const hashed = hashPassword(String(password));
        Object.assign(update, hashed);
    }
    if (adminNote !== undefined) {
        if (user.role !== "admin") {
            ctx.status = 403;
            ctx.body = { code: 403, message: "需要管理员权限" };
            return;
        }
        update.note = String(adminNote || "").trim();
    }
    if (visitHistory !== undefined) {
        const raw = Array.isArray(visitHistory) ? visitHistory : [];
        const sanitized = raw
            .map((v) => Number(v))
            .filter((v) => Number.isFinite(v))
            .slice(0, 5);
        update.visitHistory = sanitized;
    }
    if (user.role === "admin" && role) update.role = String(role);

    const db = await getDb();
    const targetUser = await db.collection("users").findOne({ _id: new ObjectId(id) });
    if (apiAccess !== undefined) {
        if (user.role !== "admin") {
            ctx.status = 403;
            ctx.body = { code: 403, message: "需要管理员权限" };
            return;
        }
        const allowed = new Set(["adult", "normal", "all"]);
        const safeAccess = allowed.has(String(apiAccess)) ? String(apiAccess) : "normal";
        update.apiAccess = safeAccess;
    }
    if (targetUser && targetUser.role === "admin") {
        update.apiAccess = "all";
    }
    await db.collection("users").updateOne({ _id: new ObjectId(id) }, { $set: update });
    const updated = await db.collection("users").findOne({ _id: new ObjectId(id) });
    ctx.body = { code: 200, message: "更新成功", data: sanitizeUser(updated) };
});

// 删除用户（管理员）
userRouter.delete("/user/:id", authMiddleware, requireAdmin, async (ctx) => {
    const { id } = ctx.params;
    if (!ObjectId.isValid(id)) {
        ctx.body = { code: 400, message: "无效的用户ID" };
        return;
    }
    const db = await getDb();
    await db.collection("user_sessions").deleteMany({ userId: new ObjectId(id) });
    await db.collection("users").deleteOne({ _id: new ObjectId(id) });
    ctx.body = { code: 200, message: "删除成功" };
});

module.exports = userRouter;
