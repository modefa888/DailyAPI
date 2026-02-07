const Router = require("koa-router");
const J1HostRouter = new Router();
const cheerio = require("cheerio");

const axiosClient = require("../../utils/axiosClient");
const { get, set } = require("../../utils/cacheData");
const response = require("../../utils/response");

/* ================== 接口信息 ================== */

const routerInfo = {
    name: "91",
    title: "91影视",
    subtitle: "每日榜",
    category: ""
};

const cacheKey = "91Data";
const Host = "https://91porny.com";
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
        console.warn(`[91][FETCH_FAILED] ${url} ${err.message}`);
        throw new Error("FETCH_BLOCKED");
    }
}

/* ================== 数据解析 ================== */

function getData(html) {
    if (!html) return { count: 0, data: [] };

    try {
        const $ = cheerio.load(html);
        const list = [];

        $(".colVideoList").each((_, el) => {
            const title = $(el).find(".title").text().trim();
            const hrefPath = $(el).find(".title").attr("href");
            if (!title || !hrefPath) return;

            const style = $(el).find(".img").attr("style") || "";
            const img = style
                .replace("background-image: url('", "")
                .replace("')", "");

            const href = Host + hrefPath;
            const desc = $(el)
                .find(".text-truncate")
                .text()
                .replace(/\s+/g, " ")
                .trim();

            const time = $(el).find(".layer").text().trim();

            list.push({
                aid: href.split("/")[5],
                title,
                img,
                href,
                desc,
                time,
                video_url:null
            });
        });

        return {
            count: $(".container-title").text().trim(),
            data: list
        };
    } catch (err) {
        console.warn("[91][PARSE_ERROR]", err.message);
        return { count: 0, data: [] };
    }
}

/* ================== 播放地址（新增：title解析 + 整合返回） ================== */

J1HostRouter.get("/91/:uid", async (ctx) => {
    const { uid } = ctx.params;
    const url = `${Host}/video/view/${uid}`;
    const key = `${cacheKey}_${uid}`;

    try {
        let data = await get(key);

        if (!data) {
            const html = await fetchHtml(url);
            // 1. 解析m3u8播放地址
            const m3u8Match = html.match(/data-src="(.+?)">/);
            // 2. 解析og:image:secure_url封面图
            const ogImgMatch = html.match(/<meta property="og:image:secure_url" content="(.+?)"/);
            // 3. 解析<title>标签内容（去空格、去换行）
            const titleMatch = html.match(/<title>([\s\S]*?)<\/title>/);
            
            // 任一核心字段解析失败则返回错误
            if (!m3u8Match || !ogImgMatch || !titleMatch) {
                response(ctx, 500, "", "播放地址/封面图/标题解析失败（页面结构变更）");
                return;
            }

            const m3u8 = m3u8Match[1].replace("&amp;m=", "&m=");
            const img = ogImgMatch[1];
            // 标题去空行、去多余空格，保留有效内容
            const title = titleMatch[1].replace(/\s+/g, " ").trim();
            
            // 整合所有数据：m3u8 + 封面图 + 标题
            data = { m3u8, img, title, url} 
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

J1HostRouter.get("/91/:wd/:page", async (ctx) => {
    const { wd, page } = ctx.params;
    const url = `${Host}/search?keywords=${wd}&page=${page}`;
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

J1HostRouter.info = routerInfo;
module.exports = J1HostRouter;