const Router = require("koa-router");
const proxyRouter = new Router();
const axios = require("axios");
const { get, set } = require("../../utils/cacheData");
const response = require('../../utils/response');

// 缓存键名
const cacheKey = "proxyData";

/* ================== proxy ================== */

proxyRouter.get("/proxy", async (ctx) => {
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

    if ((wd && wd !== '') || (pg && pg !== '')) {
        zUrl = `${url}?ac=videolist&wd=${wd || ''}&pg=${pg || ''}`;
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
        // 精简错误日志
        console.warn(`[proxy][FETCH_FAIL] ${zUrl}`);

        response(ctx, 606, "", "目标资源暂时无法访问");
    }
});

module.exports = proxyRouter;
