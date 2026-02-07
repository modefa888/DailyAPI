const Router = require("koa-router");
const KanavHostRouter = new Router();
const cheerio = require("cheerio");

const axiosClient = require("../../utils/axiosClient");
const { get, set } = require("../../utils/cacheData");
const response = require("../../utils/response");

/* ================== 接口信息 ================== */

const routerInfo = {
    name: "kanav",
    title: "kanav影视",
    subtitle: "每日榜",
    category: ""
};

const cacheKey = "kanavData";
const Host = "https://kanav.ad";
let updateTime = new Date().toISOString();

/* ================== axios 请求（代理 → 直连 fallback） ================== */

async function fetchHtml(url) {
    try {
        const res = await axiosClient({
            url,
            useProxy: true,
            headers: {
                Referer: Host
            }
        });
        return res.data;
    } catch (err) {
        console.warn(`[Kanav][FETCH_FAILED] ${url} ${err.message}`);
        throw new Error("FETCH_BLOCKED");
    }
}

/* ================== 数据解析 ================== */

function getData(html) {
    if (!html) return { count: 0, data: [] };

    try {
        const $ = cheerio.load(html);
        const list = [];

        $(".video-item").each((_, el) => {
            const linkEl = $(el).find(".featured-content-image a").first();
            const hrefPath = linkEl.attr("href");
            const title =
                $(el).find(".entry-title a").first().text().trim() ||
                linkEl.find("img").attr("alt") ||
                "";
            if (!title || !hrefPath) return;

            const imgEl = linkEl.find("img");
            const img =
                imgEl.attr("data-original") ||
                imgEl.attr("src") ||
                "";

            const href = Host + hrefPath;

            const tags = [];
            const subtitle = $(el).find(".model-view-left").text().trim();
            const meta = $(el).find(".model-view").text().trim();
            if (subtitle) tags.push(subtitle);
            if (meta) tags.push(meta);
            const desc = tags.join(" ");

            const entryText = $(el)
                .find(".entry-title")
                .clone()
                .children("a")
                .remove()
                .end()
                .text()
                .replace(/\s+/g, " ")
                .trim();
            const time = entryText;

            const idMatch = hrefPath.match(/\/id\/(\d+)/);

            list.push({
                aid: idMatch ? idMatch[1] : hrefPath,
                title,
                img,
                href,
                desc,
                time,
                video_url: null
            });
        });

        return {
            count: list.length,
            data: list
        };
    } catch (err) {
        console.warn("[Kanav][PARSE_ERROR]", err.message);
        return { count: 0, data: [] };
    }
}

/* ================== 播放地址（新增：title解析 + 整合返回） ================== */

KanavHostRouter.get("/kanav/:uid", async (ctx) => {
    const { uid } = ctx.params;
    const url = `${Host}/index.php/vod/play/id/${uid}/sid/1/nid/1.html`;
    console.log(url)
    const key = `${cacheKey}_${uid}`;

    try {
        let data = await get(key);

        if (!data) {
            const html = await fetchHtml(url);

            // 1. 解析 player_aaaa 中的播放地址（url 字段）
            const playerMatch = html.match(/var\s+player_aaaa\s*=\s*(\{[\s\S]*?\})\s*;/);
            let m3u8 = "";
            const urlMatch = html.match(/},"url":"(.*?)","url_next"/);
            if (urlMatch && urlMatch[1]) {
                const rawUrl = urlMatch[1];
                let decoded = rawUrl;
                if (/^[A-Za-z0-9+/=]+$/.test(rawUrl) && rawUrl.startsWith("JT")) {
                    try {
                        decoded = Buffer.from(rawUrl, "base64").toString("utf8");
                    } catch (err) {
                        decoded = rawUrl;
                    }
                }
                try {
                    m3u8 = decodeURIComponent(decodeURIComponent(decoded));
                } catch (err) {
                    try {
                        m3u8 = decodeURIComponent(decoded);
                    } catch (innerErr) {
                        m3u8 = decoded;
                    }
                }
            }
            // 2. 解析详情页封面图与标题（video-countext）
            const $detail = cheerio.load(html);
            const img = $detail(".video-countext img.countext-img").attr("src") || "";
            const title = $detail(".video-title h1").first().text().trim() || "";

            if (!m3u8 || !img || !title) {
                const missing = [];
                if (!m3u8) missing.push("播放地址");
                if (!img) missing.push("封面图");
                if (!title) missing.push("标题");
                response(ctx, 500, "", `${missing.join("/")}解析失败（页面结构变更）`);
                return;
            }

            // 整合所有数据：m3u8 + 封面图 + 标题
            data = { m3u8, img, title ,url}
            await set(key, data); // 一起缓存，后续直接取

            response(ctx, 200, data, "从远程获取成功（代理自动兜底）");
        } else {
            response(ctx, 200, data, "从缓存获取成功");
        }
    } catch {
        response(
            ctx,
            606,
            "",
            "目标站点不可达（代理异常或网络受限）"
        );
    }
});

/* ================== 搜索 ================== */

KanavHostRouter.get("/kanav/:wd/:page", async (ctx) => {
    const { wd, page } = ctx.params;
    const url = `${Host}/index.php/vod/search/by/time_add/page/${page}/wd/${wd}.html`;
    const cacheKeyUrl = `${cacheKey}_${wd}_${page}`;

    try {
        let data = await get(cacheKeyUrl);
        const from = data ? "cache" : "server";

        if (!data) {
            const html = await fetchHtml(url);
            data = getData(html);
            updateTime = new Date().toISOString();
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
    } catch {
        ctx.status = 403;
        ctx.body = {
            code: 403,
            message: "目标站点访问失败（代理 / 网络异常）"
        };
    }
});

KanavHostRouter.info = routerInfo;
module.exports = KanavHostRouter;
