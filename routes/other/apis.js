const Router = require("koa-router");
const crypto = require("crypto");
const apisRouter = new Router();
const client = require("../../utils/mongo");
const { encryptUrl } = require("../../utils/urlCipher");
const { DEFAULT_OFFICIAL_APIS } = require("../../utils/officialApis");

// 接口信息
const routerInfo = { name: "官方推荐API", title: "官方推荐", subtitle: "视频资源接口" };
const videoAccessPassword = process.env.VIDEO_ACCESS_PASSWORD || "123456";
const accessTokenTtlMs = Number(process.env.VIDEO_ACCESS_TOKEN_TTL_MS || 86400000);
const accessTokens = new Map();
const DB_NAME = process.env.MONGODB_DB || undefined;
let officialIndexesReady = false;

const getDb = async () => {
    await client.connect();
    return DB_NAME ? client.db(DB_NAME) : client.db();
};

const ensureOfficialIndexes = async (db) => {
    if (officialIndexesReady) return;
    await db.collection("official_apis").createIndex({ url: 1 }, { unique: true });
    await db.collection("official_apis").createIndex({ enabled: 1, sort: 1, updatedAt: -1 });
    officialIndexesReady = true;
};

function issueAccessToken() {
    const token = crypto.randomBytes(24).toString("hex");
    accessTokens.set(token, Date.now() + accessTokenTtlMs);
    return token;
}

function isAccessTokenValid(token) {
    if (!token) return false;
    const expiresAt = accessTokens.get(token);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
        accessTokens.delete(token);
        return false;
    }
    return true;
}

function getAccessTokenFromRequest(ctx) {
    const queryToken = String(ctx.query.token || "").trim();
    if (queryToken) return queryToken;
    const headerToken = String(ctx.get("x-video-token") || "").trim();
    if (headerToken) return headerToken;
    const authHeader = String(ctx.get("authorization") || "").trim();
    if (!authHeader) return "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : "";
}

async function getUserByToken(token) {
    if (!token) return null;
    try {
        await client.connect();
        const db = DB_NAME ? client.db(DB_NAME) : client.db();
        const session = await db.collection("user_sessions").findOne({ token });
        if (!session || session.expiresAt <= new Date()) return null;
        const user = await db.collection("users").findOne({ _id: session.userId });
        if (!user || user.isDisabled) return null;
        return user;
    } catch (err) {
        return null;
    }
}



/* ================== apis ================== */

// 官方推荐 API
apisRouter.get("/apis/official", async (ctx) => {
    const token = getAccessTokenFromRequest(ctx);
    const user = isAccessTokenValid(token) ? null : await getUserByToken(token);
    const hasAccess = isAccessTokenValid(token) || !!user;
    if (!hasAccess) {
        ctx.status = 401;
        ctx.body = {
            code: 401,
            message: "未授权",
            ...routerInfo,
        };
        return;
    }
    const db = await getDb();
    await ensureOfficialIndexes(db);
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
    let data = list
        .filter((api) => api && api.enabled)
        .map((api) => ({
            name: api.name,
            url: encryptUrl(api.url),
            type: api.type || "vod",
            category: api.category || "adult",
        }));
    if (!isAccessTokenValid(token) && user) {
        const access =
            user.role === "admin"
                ? "all"
                : String(user.apiAccess || "normal").toLowerCase();
        if (access !== "all") {
            data = data.filter((api) =>
                access === "adult" ? api.category === "adult" : api.category === "normal"
            );
        }
    }
    ctx.body = {
        code: 200,
        message: "获取成功",
        ...routerInfo,
        total: data.length,
        data,
    };
});

// 校验访问密码
apisRouter.get("/apis/video/pass", async (ctx) => {
    const password = String(ctx.query.password || "");
    const ok = password === videoAccessPassword;
    ctx.body = {
        code: 200,
        message: "获取成功",
        data: ok,
        token: ok ? issueAccessToken() : "",
    };
});


apisRouter.info = routerInfo;
module.exports = apisRouter;
