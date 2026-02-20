const client = require("../utils/mongo");

const DB_NAME = process.env.MONGODB_DB || undefined;
const CACHE_TTL_MS = Number(process.env.ROUTE_ACCESS_CACHE_MS || 10000);
const SESSION_TOUCH_INTERVAL_MS = Number(process.env.USER_SESSION_TOUCH_MS || 60 * 1000);
const ALWAYS_OPEN_PATHS = new Set(["/user/login", "/user/register"]);

let cache = {
    at: 0,
    rules: [],
};

const getDb = async () => {
    await client.connect();
    return DB_NAME ? client.db(DB_NAME) : client.db();
};

const getTokenFromRequest = (ctx) => {
    const headerToken = String(ctx.get("x-user-token") || "").trim();
    if (headerToken) return headerToken;
    const authHeader = String(ctx.get("authorization") || "").trim();
    if (!authHeader) return "";
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    return match ? match[1].trim() : "";
};

const normalizeAccess = (value) => {
    const v = String(value || "").trim().toLowerCase();
    if (v === "admin") return "admin";
    if (v === "user") return "user";
    return "open";
};

const ruleRank = (rule) => {
    const path = rule.path || "";
    if (path === "*" || path === "/*") return 4;
    if (path.endsWith("*")) return 3;
    if (path.includes(":")) return 2;
    return 1;
};

const compileRule = (raw) => {
    const path = String(raw.path || "").trim() || "/";
    const method = String(raw.method || "*").trim().toUpperCase();
    const access = normalizeAccess(raw.access);
    const enabled = raw.enabled !== false;
    const rank = ruleRank({ path });
    let matcher = null;
    if (path === "*" || path === "/*") {
        matcher = () => true;
    } else if (path.endsWith("*")) {
        const prefix = path.slice(0, -1);
        matcher = (p) => p.startsWith(prefix);
    } else if (path.includes(":")) {
        const pattern = "^" + path.replace(/:[^/]+/g, "[^/]+") + "$";
        const regex = new RegExp(pattern);
        matcher = (p) => regex.test(p);
    } else {
        matcher = (p) => p === path;
    }
    return {
        id: raw._id,
        path,
        method,
        access,
        enabled,
        rank,
        length: path.length,
        matchPath: matcher,
    };
};

const loadRules = async () => {
    const now = Date.now();
    if (now - cache.at < CACHE_TTL_MS) return cache.rules;
    const db = await getDb();
    const list = await db.collection("route_access").find().toArray();
    const compiled = list
        .map(compileRule)
        .sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : b.length - a.length));
    cache = { at: now, rules: compiled };
    return compiled;
};

const matchRule = (rules, path, method) => {
    const upperMethod = String(method || "").toUpperCase();
    for (const rule of rules) {
        if (!rule.enabled) continue;
        if (rule.method !== "*" && rule.method !== "ALL" && rule.method !== upperMethod) continue;
        if (rule.matchPath(path)) return rule;
    }
    return null;
};

const touchSession = (db, session, user, ctx) => {
    const now = new Date();
    const lastSeenAt = session.lastSeenAt ? new Date(session.lastSeenAt) : null;
    if (lastSeenAt && now - lastSeenAt <= SESSION_TOUCH_INTERVAL_MS) return;
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
};

module.exports = async (ctx, next) => {
    if (ctx.method === "OPTIONS") {
        await next();
        return;
    }
    const path = ctx.request.path || "";
    if (/\/[^/]+\.[^/]+$/.test(path)) {
        await next();
        return;
    }
    if (ALWAYS_OPEN_PATHS.has(path)) {
        await next();
        return;
    }
    const rules = await loadRules();
    const rule = matchRule(rules, path, ctx.method);
    if (!rule || rule.access === "open") {
        await next();
        return;
    }
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
    if (rule.access === "admin" && user.role !== "admin") {
        ctx.status = 403;
        ctx.body = { code: 403, message: "需要管理员权限" };
        return;
    }
    ctx.state.user = user;
    ctx.state.session = session;
    touchSession(db, session, user, ctx);
    await next();
};
