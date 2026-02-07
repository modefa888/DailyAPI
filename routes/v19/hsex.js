const Router = require("koa-router");
const hsexRouter = new Router();
const cheerio = require("cheerio");

const axiosClient = require("../../utils/axiosClient");
const { get, set } = require("../../utils/cacheData");
const response = require("../../utils/response");

/* ================== 接口信息 ================== */

const routerInfo = {
    name: "hsex",
    title: "hsex影视",
    subtitle: "每日榜",
    category: ""
};

const cacheKey = "hsexData";
const Host = "https://hsex.icu";
let updateTime = new Date().toISOString();

/* ================== 列表解析 ================== */

function getData(html) {
    if (!html) return [];

    try {
        const $ = cheerio.load(html);
        const list = [];

        $(".thumbnail").each((_, el) => {
            const title = $(el).find(".title").text().trim();
            const href = $(el).find(".title a").attr("href");
            const duration = $(el).find(".duration").text().trim();

            const style = $(el).find(".image").attr("style") || "";
            const img = style
                .replace("background-image: url('", "")
                .replace("')", "");

            if (!title || !href) return;

            list.push({
                aid: href,
                title,
                img,
                href: Host + "/" + href.replace(/^\/+/, ""),
                time: duration,
                video_url:null
            });
        });

        return { data:list };
    } catch (err) {
        console.warn("[hsex][PARSE_ERROR]", err.message);
        return [];
    }
}

/* ================== 播放详情 ================== */

hsexRouter.get("/hsex/:uid", async (ctx) => {
    const { uid } = ctx.params;
    const url = `${Host}/${uid}`;
    const key = `${cacheKey}_${uid}`;

    try {
        let data = await get(key);

        if (!data) {
            console.log("[hsex] 播放页远程获取 =>", url);

            const res = await axiosClient({
                url,
                useProxy: true
            });

            const html = res.data;

            const title =
                html.match(/<h3[^>]*class="panel-title"[^>]*>([^<]+)</)?.[1] ||
                "";

            const m3u8 =
                html.match(/<source[^>]+src="([^"]+\.m3u8[^"]*)"/)?.[1] ||
                "";

            const img =
                html.match(/poster="([^"]+)"/)?.[1] ||
                "";

            if (!m3u8) {
                response(ctx, 500, null, "未解析到播放地址（页面结构可能变更）");
                return;
            }

            data = { title, m3u8, img, url};
            await set(key, data);

            response(ctx, 200, data, "从远程获取成功（代理）");
        } else {
            response(ctx, 200, data, "从缓存获取成功");
        }

    } catch (err) {
        console.error("[hsex] 播放地址获取失败:", err.message);
        response(
            ctx,
            606,
            "",
            "目标站点不可达或被拦截（代理 / 网络异常）"
        );
    }
});

/* ================== 搜索 ================== */

hsexRouter.get("/hsex/:wd/:page", async (ctx) => {
    const { wd, page } = ctx.params;
    const regex = /^[\u4e00-\u9fa5]{2,}$/;

    if (!regex.test(wd)) {
        ctx.body = {
            code: 400,
            message: "wd 参数必须包含至少两个中文字符"
        };
        return;
    }

    const url = `${Host}/search-${page}.htm?search=${wd}`;
    const key = `${cacheKey}_${wd}_${page}`;

    try {
        let data = await get(key);
        const from = data ? "cache" : "server";

        if (!data) {
            console.log("[hsex] 搜索页远程获取 =>", url);

            const res = await axiosClient({
                url,
                useProxy: true
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
            total: data.length,
            updateTime,
            data
        };

    } catch (err) {
        console.error("[hsex] 搜索失败:", err.message);
        ctx.body = {
            code: 403,
            message: "目标站点访问受限（请检查代理）"
        };
    }
});

hsexRouter.info = routerInfo;
module.exports = hsexRouter;
