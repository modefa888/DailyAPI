const Router = require("koa-router");
const crypto = require("crypto");
const apisRouter = new Router();
const { encryptUrl } = require("../../utils/urlCipher");

// 接口信息
const routerInfo = { name: "官方推荐API", title: "官方推荐", subtitle: "视频资源接口" };
const videoAccessPassword = process.env.VIDEO_ACCESS_PASSWORD || "123456";
const accessTokenTtlMs = Number(process.env.VIDEO_ACCESS_TOKEN_TTL_MS || 86400000);
const accessTokens = new Map();

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

// 官方推荐 API 列表
const officialApis = [
    {
        name: "奶香香资源",
        url: "https://naixxzy.com/api.php/provide/vod/",
        type: "vod",
    },
    {
        name: "麻豆资源",
        url: "https://91md.me/api.php/provide/vod/",
        type: "vod",
    },
    {
        name: "深林资源",
        url: "https://slapibf.com/api.php/provide/vod/",
        type: "vod",
    },
    {
        name: "155资源",
        url: "https://155api.com/api.php/provide/vod/",
        type: "vod",
    },
    {
        name: "奥斯卡资源",
        url: "https://aosikazy.com/api.php/provide/vod/",
        type: "vod",
    },
    {
        name: "老色逼资源",
        url: "https://apilsbzy1.com/api.php/provide/vod/",
        type: "vod",
    },
    {
        name: "百万资源",
        url: "https://api.bwzyz.com/api.php/provide/vod/at/json/",
        type: "vod",
    },
    {
        name: "杏吧资源",
        url: "https://json.xingba222.com/api.php/provide/vod/",
        type: "vod",
    },
    {
        name: "幸资资源",
        url: "https://xzybb2.com/api.php/provide/vod/",
        type: "vod",
    },
    {
        name: "黄色仓库",
        url: "https://hsckzy888.com/api.php/provide/vod/from/hsckm3u8/at/json/",
        type: "vod",
    },
    {
        name: "香蕉资源",
        url: "https://www.xiangjiaozyw.com/api.php/provide/vod/",
        type: "vod",
    },
    {
        name: "小鸡资源",
        url: "https://api.xjzyapi.xyz/provide/vod/",
        type: "vod",
    },
    {
        name: "乐播资源",
        url: "https://lbapi9.com/api.php/provide/vod/at/json/",
        type: "vod",
    },
    {
        name: "色猫资源",
        url: "https://caiji.semaozy.net/inc/apijson_vod.php",
        type: "vod",
    },
];


/* ================== apis ================== */

// 官方推荐 API
apisRouter.get("/apis/official", async (ctx) => {
    const token = getAccessTokenFromRequest(ctx);
    if (!isAccessTokenValid(token)) {
        ctx.status = 401;
        ctx.body = {
            code: 401,
            message: "未授权",
            ...routerInfo,
        };
        return;
    }
    const data = officialApis.map((api) => ({
        ...api,
        url: encryptUrl(api.url),
    }));
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
