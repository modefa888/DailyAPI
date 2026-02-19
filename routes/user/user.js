const Router = require("koa-router");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ObjectId } = require("mongodb");
const client = require("../../utils/mongo");

const userRouter = new Router();

// 接口信息
const routerInfo = { name: "用户系统", title: "用户管理", subtitle: "注册/登录/管理" };
userRouter.info = routerInfo;

const TOKEN_TTL_MS = Number(process.env.USER_TOKEN_TTL_MS || 7 * 24 * 60 * 60 * 1000);
const DB_NAME = process.env.MONGODB_DB || undefined;

let indexesReady = false;
const ensureIndexes = async (db) => {
    if (indexesReady) return;
    await db.collection("users").createIndex({ username: 1 }, { unique: true });
    await db.collection("user_sessions").createIndex({ token: 1 }, { unique: true });
    await db.collection("user_sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    await db.collection("user_favorites").createIndex({ userId: 1, url: 1 }, { unique: true });
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

// 用户列表（管理员）- 分页
userRouter.get("/user/list", authMiddleware, requireAdmin, async (ctx) => {
    const page = Math.max(1, Number(ctx.query.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(ctx.query.pageSize || 20)));
    const skip = (page - 1) * pageSize;
    const sortKey = String(ctx.query.sortKey || "").trim();
    const sortDir = String(ctx.query.sortDir || "desc").toLowerCase() === "asc" ? 1 : -1;
    const allowedSortKeys = new Set(["favoriteCount", "historyCount", "searchCount", "watchSeconds"]);

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
                },
            },
            { $sort: { [sortKey]: sortDir, createdAt: -1 } },
            { $skip: skip },
            { $limit: pageSize },
        ];
        const result = await db.collection("users").aggregate(pipeline).toArray();
        users = result.map((u) => {
            const { stats, favoriteCount, historyCount, searchCount, watchSeconds, ...rest } = u;
            statsMap[String(u._id)] = {
                favoriteCount: favoriteCount || 0,
                historyCount: historyCount || 0,
                searchCount: searchCount || 0,
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

// 更新用户统计（登录用户）
userRouter.post("/user/stats", authMiddleware, async (ctx) => {
    const payload = ctx.request.body || {};
    const stats = {
        favoriteCount: Math.max(0, Number(payload.favoriteCount || 0)),
        historyCount: Math.max(0, Number(payload.historyCount || 0)),
        searchCount: Math.max(0, Number(payload.searchCount || 0)),
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
    const { nickname, password, role, profileNote } = ctx.request.body || {};
    const update = { updatedAt: new Date() };
    if (nickname !== undefined) update.nickname = String(nickname || "").trim();
    if (profileNote !== undefined) update.profileNote = String(profileNote || "").trim();
    if (password) {
        const hashed = hashPassword(String(password));
        Object.assign(update, hashed);
    }
    if (user.role === "admin" && role) update.role = String(role);

    const db = await getDb();
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
