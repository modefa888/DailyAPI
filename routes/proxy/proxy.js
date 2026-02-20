const Router = require("koa-router");
const proxyRouter = new Router();
const axios = require("axios");
const { get, set } = require("../../utils/cacheData");
const response = require('../../utils/response');
const { decryptUrl } = require("../../utils/urlCipher");
const client = require("../../utils/mongo");
const DB_NAME = process.env.MONGODB_DB || undefined;
const SESSION_TOUCH_INTERVAL_MS = Number(process.env.USER_SESSION_TOUCH_MS || 60 * 1000);

// 缓存键名
const cacheKey = "proxyData";

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
    return next();
};

/* ================== proxy ================== */

proxyRouter.get("/proxy", authMiddleware, async (ctx) => {
    const { url, wd, pg } = ctx.query;

    if (!url) {
        ctx.status = 400;
        ctx.body = {
            code: 400,
            message: "缺少 url 参数"
        };
        return;
    }

    let zUrl = url;

    try {
        zUrl = decryptUrl(url);
    } catch (err) {
        // not encrypted, use raw url
        zUrl = url;
    }

    if ((wd && wd !== '') || (pg && pg !== '')) {
        zUrl = `${zUrl}?ac=videolist&wd=${wd || ''}&pg=${pg || ''}`;
    }

    const key = `${cacheKey}_${zUrl}`;

    try {
        let data = await get(key);

        if (!data) {
            console.log(`[proxy] fetch => ${zUrl}`);

            const res = await axios.get(zUrl, {
                timeout: 15000,
                responseType: 'arraybuffer',
                headers: {
                    "User-Agent": "Mozilla/5.0"
                }
            });

            const contentType = res.headers['content-type'];

            // 图片：不缓存，直接透传
            if (contentType && contentType.startsWith('image/')) {
                ctx.status = res.status;
                ctx.type = contentType;
                ctx.body = res.data;
                return;
            }

            // 非图片：缓存并返回
            data = res.data;
            await set(key, data);

            ctx.status = 200;
            ctx.body = data;
        } else {
            ctx.status = 200;
            ctx.body = data;
        }
    } catch (err) {
        const isTimeout = err && (err.code === 'ECONNABORTED' || err.message?.includes('timeout'));
        const message = isTimeout ? '请求超时，请稍后重试' : '目标资源暂时无法访问';
        const code = isTimeout ? 504 : 606;
        // 精简错误日志
        console.warn(`[proxy][FETCH_FAIL] ${zUrl}${isTimeout ? ' (timeout)' : ''}`);

        response(ctx, code, "", message);
    }
});

module.exports = proxyRouter;
