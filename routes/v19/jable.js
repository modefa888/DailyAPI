const Router = require("koa-router");
const jabletvRouter = new Router();
const cheerio = require("cheerio");
const { spawn } = require("child_process");

const { get, set } = require("../../utils/cacheData");
const response = require("../../utils/response");

// ✅ 使用你封装好的 axios 工具（代理优先 → 直连 fallback）
const axiosClient = require("../../utils/axiosClient");

/* ================== 接口信息 ================== */

const routerInfo = {
    name: "jabletv",
    title: "jabletv影视",
    subtitle: "每日榜",
    category: ""
};

const cacheKey = "jabletvData";
let updateTime = new Date().toISOString();

const Host = "https://jable.tv";

/* ================== 数据解析 ================== */

const getData = (html) => {
    if (!html) return [];

    try {
        const $ = cheerio.load(html);
        const list = [];

        $(".video-img-box").each((_, el) => {
            const title = $(el).find(".title").text().trim();
            const href = $(el).find(".title a").attr("href");
            const time = $(el).find(".label").text().trim();

            const img = $(el).find("img").attr("data-src");

            if (!title || !href) return;

            list.push({
                aid: href.split('/')[4],
                title,
                img,
                href: href,
                time,
                video_url:null
            });
        });

        return {data:list};
    } catch (err) {
        console.error("[jabletv][PARSE_ERROR]", err.message);
        return [];
    }
};

/* ================== 播放地址（Python，不动） ================== */

// jabletvRouter.get("/jabletv/:uid", async (ctx) => {
//     const { uid } = ctx.params;
//     const lowerUid = uid.toLowerCase();
//     const key = `${cacheKey}_${uid}`;

//     console.log(`[jabletv][PLAY] uid=${lowerUid}`);

//     try {
//         let data = await get(key);

//         if (data) {
//             return response(ctx, 200, data, "从缓存获取成功");
//         }

//         console.log("[jabletv][PLAY] 缓存未命中，调用 Python");

//         const pythonScriptPath = "/opt/DailyAPI/py/jable.py";
//         const pythonProcess = spawn("python", [pythonScriptPath, lowerUid]);

//         const result = await new Promise((resolve, reject) => {
//             let buffer = Buffer.from("");

//             pythonProcess.stdout.on("data", (chunk) => {
//                 buffer = Buffer.concat([buffer, chunk]);
//             });

//             pythonProcess.on("close", (code) => {
//                 if (code === 0) {
//                     resolve(buffer.toString("utf8"));
//                 } else {
//                     reject(new Error(`Python exit code ${code}`));
//                 }
//             });
//         });

//         await set(key, result);
//         response(ctx, 200, result, "从远程获取成功（Python）");

//     } catch (err) {
//         console.error("[jabletv][PLAY_ERROR]", err.message);
//         response(ctx, 500, null, "播放地址解析失败");
//     }
// });

/**
 * 播放地址
 */
jabletvRouter.get("/jabletv/:uid", async (ctx) => {
    const { uid } = ctx.params;
    const url = Host + `/videos/${uid}/`;
    const key = `${cacheKey}_${uid}`;

    try {
        let data = await get(key);

        if (!data) {
            console.log('[jabletv] 播放页远程获取 =>', url);

            const res = await axiosClient({
                url,
                useProxy: true
            });

            // ✅ 正确解析 m3u8
            const match = res.data.match(
                /var\s+hlsUrl\s*=\s*['"]([^'"]+\.m3u8)['"]/
            );

            if (!match) {
                response(ctx, 500, "", "未解析到 m3u8 播放地址");
                return;
            }

            const $ = cheerio.load(res.data);

            // 标题
            const title = $(".header-left h4")
                .first()
                .text()
                .trim();

            // 发布时间
            const publishTime = $(".header-left h6 span.mr-3")
                .first()
                .text()
                .trim();

            // 背景封面图（重点）
            const cover = $('meta[property="og:image"]').attr('content') || '';

            const data = {
                m3u8: match[1],
                title,
                publishTime,
                cover,
                url
            };

            await set(key, data);
            response(ctx, 200, data, "从远程获取成功");
        } else {
            response(ctx, 200, data, "从缓存获取成功");
        }

    } catch (err) {
        console.error('[jabletv] 播放地址获取失败:', err.message);
        response(ctx, 606, "", "目标站点不可达或被拦截");
    }
});



/* ================== 搜索（代理请求） ================== */

jabletvRouter.get("/jabletv/:wd/:page", async (ctx) => {
    const { wd, page } = ctx.params;

    // 至少两个中文
    if (!/^[\u4e00-\u9fa5]{2,}$/.test(wd)) {
        ctx.body = "wd 参数必须包含至少两个中文字符";
        return;
    }
    const url = `${Host}/search/${wd}/?mode=async&function=get_block&block_id=list_videos_videos_list_search_result&q=${wd}&sort_by=&from=$0{page}&_=1769756466263`;
    const key = `${cacheKey}_${url}`;

    console.log(`[jabletv][SEARCH] ${wd} page=${page}`);

    try {
        let data = await get(key);
        const from = data ? "cache" : "server";

        if (!data) {
            console.log("[jabletv][SEARCH] 缓存未命中，开始请求（代理优先）");

            const res = await axiosClient({
                url,
                method: "GET",
                useProxy: true,
                headers: {
                    Referer: Host,
                    "User-Agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
                }
            });

            data = getData(res.data);
            updateTime = new Date().toISOString();

            await set(key, data);
        }

        ctx.body = {
            code: 200,
            message: "获取成功",
            ...routerInfo,
            from,
            total: Array.isArray(data) ? data.length : 0,
            updateTime,
            data
        };

    } catch (err) {
        console.error("[jabletv][SEARCH_ERROR]", err.message);
        ctx.status = 502;
        ctx.body = {
            code: 502,
            message: "目标站点访问失败（请检查代理）"
        };
    }
});

jabletvRouter.info = routerInfo;
module.exports = jabletvRouter;
