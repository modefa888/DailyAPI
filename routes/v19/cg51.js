const Router = require("koa-router");
const cgRouter = new Router();
const cheerio = require("cheerio");

const axiosClient = require("../../utils/axiosClient");
const { get, set } = require("../../utils/cacheData");
const { loadBackgroundImage } = require("../../utils/51cgjm");
const response = require("../../utils/response");

/* ================== 基础信息 ================== */

const routerInfo = {
    name: "51cg",
    title: "51吃瓜",
    subtitle: "每日榜",
    category:
        "wpac(今日吃瓜) mrdg(每日吃瓜) rdsj(热门吃瓜) bkdg(必看大瓜) whhl(网红黑料) xsxy(学生学校) whmx(明星黑料)"
};

const cgHost = "https://51cg1.com";
const cacheKey = "51cgData";
let updateTime = new Date().toISOString();

/* ================== axios 请求（走工具包） ================== */

async function fetchHtml(url) {
    try {
        const res = await axiosClient({
            url,
            useProxy: true,
            headers: {
                Referer: cgHost
            }
        });
        return res.data;
    } catch (err) {
        console.warn(`[51cg][FETCH_BLOCKED] ${url}`);
        throw new Error("FETCH_BLOCKED");
    }
}

/* ================== 工具 ================== */

function getImgProxyHost(ctx) {
    return `http://${ctx.request.host}/51cg/img?url=`;
}

/* ================== 数据解析 ================== */

function getData(html, imgHost) {
    if (!html) return [];

    try {
        const $ = cheerio.load(html);
        const list = [];

        $("article").each((_, el) => {
            const title = $(el).find(".post-card-title").text().trim();
            const href = $(el).find("a").attr("href");
            const date = $(el).find(".post-card-info span").text().trim();

            let pic = null;
            const match = /loadBannerDirect\('([^']+)'/.exec($(el).text());
            if (match?.[1]) {
                pic = imgHost + match[1];
            }

            if (!title || !date || !href) return;

            list.push({
                title,
                desc: title,
                date,
                pic,
                hot: 0,
                url: href.replace(cgHost, ""),
                mobileUrl: pic,
                href: cgHost + href.replace(cgHost, "")
            });
        });

        return list;
    } catch {
        console.warn("[51cg][PARSE_ERROR]");
        return [];
    }
}

/* ================== 首页 ================== */

cgRouter.get("/51cg", async (ctx) => {
    try {
        let data = await get(cacheKey);
        const from = data ? "cache" : "server";

        if (!data) {
            const html = await fetchHtml(cgHost);
            data = getData(html, getImgProxyHost(ctx));
            updateTime = new Date().toISOString();
            await set(cacheKey, data);
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
    } catch {
        ctx.status = 403;
        ctx.body = { code: 403, message: "目标站点访问受限（请检查代理）" };
    }
});

/* ================== 分类 ================== */

cgRouter.get("/51cg/:param1/:param2", async (ctx) => {
    const { param1, param2 } = ctx.params;
    const url = `${cgHost}/category/${param1}/${param2}`;
    const key = `${cacheKey}_${param1}_${param2}`;

    try {
        let data = await get(key);
        const from = data ? "cache" : "server";

        if (!data) {
            const html = await fetchHtml(url);
            data = getData(html, getImgProxyHost(ctx));
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
    } catch {
        ctx.status = 403;
        ctx.body = { code: 403, message: "目标站点访问受限（请检查代理）" };
    }
});

/* ================== 搜索 ================== */

cgRouter.get("/51cg/search", async (ctx) => {
    const { wd, pg } = ctx.query;
    const url = `${cgHost}/search/${wd}/${pg}/`;
    const key = `${cacheKey}_${wd}_${pg}`;

    try {
        let data = await get(key);
        const from = data ? "cache" : "server";

        if (!data) {
            const html = await fetchHtml(url);
            data = getData(html, getImgProxyHost(ctx));
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
    } catch {
        ctx.status = 403;
        ctx.body = { code: 403, message: "目标站点访问受限（请检查代理）" };
    }
});

/* ================== 详情 ================== */

cgRouter.get("/51cg/detail", async (ctx) => {
    const { uid } = ctx.query;
    const url = `${cgHost}/archives/${uid}`;
    const key = `${cacheKey}_${uid}`;

    try {
        let data = await get(key);

        if (!data) {
            const html = await fetchHtml(url);
            const $ = cheerio.load(html);

            const ImageList = [];
            $(".post-content img").each((_, el) => {
                const img = $(el).attr("data-xkrkllgl");
                if (img) ImageList.push(getImgProxyHost(ctx) + img);
            });

            const urls = [];
            const reg = /"url":"(.+?)"/g;
            let m;
            while ((m = reg.exec(html))) {
                urls.push(m[1].replace(/\\/g, ""));
            }

            data = {
                title: $(".post-title").text().trim(),
                ImageList,
                date: $("time").eq(0).text().replace(/\s+/g, ""),
                url: urls.length ? urls : [""]
            };

            await set(key, data);
            response(ctx, 200, data, "从远程获取成功（代理）");
        } else {
            response(ctx, 200, data, "从缓存获取成功");
        }
    } catch {
        ctx.status = 403;
        ctx.body = { code: 403, message: "目标站点访问受限（请检查代理）" };
    }
});

/* ================== 图片解密 ================== */

cgRouter.get("/51cg/img", async (ctx) => {
    try {
        const base64 = await loadBackgroundImage(ctx.query.url);
        ctx.type = "image/jpeg";
        ctx.body = Buffer.from(base64.split(",")[1], "base64");
    } catch {
        ctx.status = 403;
        ctx.body = "Error";
    }
});

cgRouter.info = routerInfo;
module.exports = cgRouter;
