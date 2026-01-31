const Router = require("koa-router");
const SpankHBangRouter = new Router();
const axiosClient = require("../../utils/axiosClient");
const { get, set } = require("../../utils/cacheData");
const response = require('../../utils/response');
const cheerio = require('cheerio');

// 接口信息
const routerInfo = {
    name: "spankbang",
    title: "spankbang影视",
    subtitle: "每日榜",
    category: ""
};

// 缓存键名
const cacheKey = "spankbangData";

// 调用时间
let updateTime = new Date().toISOString();

// 目标站点（需代理）
const Host = "https://spankbang.com";

/**
 * 列表数据解析
 */
const getData = (html) => {
    if (!html) return null;

    try {
        const listData = [];
        const $ = cheerio.load(html);

        $('.js-video-item').each((_, element) => {
            const title = $(element).find('.text-secondary').text().trim();
            const img = $(element).find('picture img').attr('src');
            const hrefPath = $(element).find('a').attr('href');
            const time = $(element).find('.video-item-length').text().trim();

            if (!hrefPath) return;

            const href = Host + hrefPath;

            listData.push({
                aid: hrefPath.replaceAll('/', '@*'),
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
        console.error('[spankbang] HTML 解析失败:', err.message);
        return null;
    }
};

/**
 * 播放地址
 */
SpankHBangRouter.get("/spankbang/:uid", async (ctx) => {
    const { uid } = ctx.params;
    const url = Host + `${uid.replaceAll('@*', '/')}`;
    const key = `${cacheKey}_${uid}`;

    try {
        let data = await get(key);

        if (!data) {
            console.log('[spankbang] 播放页远程获取 =>', url);

            const res = await axiosClient({
                url,
                useProxy: true,
                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                        '(KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            
                    'Accept':
                        'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            
                    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            
                    'Referer': Host,
            
                    'Cache-Control': 'no-cache',
                    'Pragma': 'no-cache',
            
                    'Sec-Fetch-Site': 'same-origin',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Dest': 'document',
                    'Upgrade-Insecure-Requests': '1'
                }
            });
            

            const match = res.data.match(
                /https?:\/\/[^\s'"]+\.m3u8[^\s'"]*/i
            );
            
            if (!match) {
                response(ctx, 500, "", "未解析到 m3u8 播放地址");
                return;
            }
            
            const m3u8Url = match[0];
            
            data = m3u8Url;
            await set(key, data);

            response(ctx, 200, data, "从远程获取成功");
        } else {
            response(ctx, 200, data, "从缓存获取成功");
        }

    } catch (err) {
        console.error('[spankbang] 播放地址获取失败:', err.message);

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
SpankHBangRouter.get("/spankbang/:wd/:page", async (ctx) => {
    const { wd, page } = ctx.params;
    
    const url = `${Host}/s/${encodeURIComponent(wd)}/${page}/`;
    const cacheKeyUrl = `${cacheKey}_${url}`;

    try {
        let data = await get(cacheKeyUrl);
        const from = data ? "cache" : "server";

        if (!data) {
            console.log('[spankbang] 搜索远程获取 =>', url);

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
        console.error('[spankbang] 搜索失败:', err.message);

        ctx.body = {
            code: 500,
            message: "目标站点访问失败（代理异常或网络不可用）"
        };
    }
});

SpankHBangRouter.info = routerInfo;
module.exports = SpankHBangRouter;
