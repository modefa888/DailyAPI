const Router = require("koa-router");
const XvideosHostRouter = new Router();
const axiosClient = require("../../utils/axiosClient");
const { get, set } = require("../../utils/cacheData");
const response = require('../../utils/response');
const cheerio = require('cheerio');

// 接口信息
const routerInfo = {
    name: "xvideos",
    title: "xvideos影视",
    subtitle: "每日榜",
    category: ""
};

// 缓存键名
const cacheKey = "xvideosData";

// 调用时间
let updateTime = new Date().toISOString();

// 目标站点（需代理）
const Host = "https://www.xvideos.com";

/**
 * 列表数据解析
 */
const getData = (html) => {
    if (!html) return null;

    try {
        const listData = [];
        const $ = cheerio.load(html);

        $('.frame-block').each((_, element) => {
            const title = $(element).find('.title').text().trim();
            const img = $(element).find('.thumb img').attr('data-src');
            const hrefPath = $(element).find('.thumb a').attr('href');
            const time = $(element).find('.duration').first().text().trim();

            if (!hrefPath) return;

            const href = Host + hrefPath;

            listData.push({
                aid: hrefPath.split('/')[1] + '@' + hrefPath.split('/')[2],
                title,
                img,
                href,
                time,
                video_url: null,
            });
        });

        return {
            count: $('.last-page').first().text() || listData.length,
            data: listData
        };
    } catch (err) {
        console.error('[xvideos] HTML 解析失败:', err.message);
        return null;
    }
};

/**
 * 播放地址
 */
XvideosHostRouter.get("/xvideos/:uid", async (ctx) => {
    const { uid } = ctx.params;
    const url = Host + `/${uid.replace('@', '/')}`;
    const key = `${cacheKey}_${uid}`;

    try {
        let data = await get(key);

        if (!data) {
            console.log('[xvideos] 播放页远程获取 =>', url);

            const res = await axiosClient({
                url,
                useProxy: true
            });
            const match = res.data.match(/contentUrl":\s*"(.+?)"/);
            if (!match) {
                response(ctx, 500, "", "页面结构已变更，未解析到播放地址");
                return;
            }

            // 2. 解析og:image:secure_url封面图
            const ogImgMatch = res.data.match(/<meta property="og:image" content="(.+?)"/);
            // 3. 解析<title>标签内容（去空格、去换行）
            const titleMatch = res.data.match(/<meta property="og:title" content="(.+?)"/);
            const img = ogImgMatch[1];
            // 标题去空行、去多余空格，保留有效内容
            const title = titleMatch[1].replace(/\s+/g, " ").trim();
            const m3u8 = match[1]
            
            data = { m3u8, img, title, url};
            await set(key, data);

            response(ctx, 200, data, "从远程获取成功");
        } else {
            response(ctx, 200, data, "从缓存获取成功");
        }

    } catch (err) {
        console.error('[xvideos] 播放地址获取失败:', err.message);

        response(
            ctx,
            606,
            "",
            "目标站点不可达或被拦截（代理 / 网络异常）"
        );
    }
});

/**
 * xvideos 搜索
 */
XvideosHostRouter.get("/xvideos/:wd/:page", async (ctx) => {
    const { wd, page } = ctx.params;
    const url = `${Host}/?k=${encodeURIComponent(wd)}&p=${page}`;
    const cacheKeyUrl = `${cacheKey}_${url}`;

    try {
        let data = await get(cacheKeyUrl);
        const from = data ? "cache" : "server";

        if (!data) {
            console.log('[xvideos] 搜索远程获取 =>', url);

            const res = await axiosClient({
                url,
                useProxy: true
            });

            data = getData(res.data);
            updateTime = new Date().toISOString();

            if (!data) {
                ctx.body = {
                    code: 500,
                    ...routerInfo,
                    message: "页面解析失败，可能站点结构已更新"
                };
                return;
            }

            await set(cacheKeyUrl, data);
        }

        ctx.body = {
            code: 200,
            message: "获取成功",
            ...routerInfo,
            from,
            total: data.data.length,
            updateTime,
            data
        };

    } catch (err) {
        console.error('[xvideos] 搜索失败:', err.message);

        ctx.body = {
            code: 500,
            message: "目标站点访问失败（代理异常或网络不可用）"
        };
    }
});

XvideosHostRouter.info = routerInfo;
module.exports = XvideosHostRouter;
