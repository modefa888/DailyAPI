const Router = require("koa-router");
const MadoutvHostRouter = new Router();

const { get, set } = require("../../utils/cacheData");
const response = require("../../utils/response");

// ✅ 使用你封装好的 axiosClient（代理优先 → 直连 fallback）
const axiosClient = require("../../utils/axiosClient");

/* ================== 接口信息 ================== */

const routerInfo = {
    name: "madoutv",
    title: "madoutv影视",
    subtitle: "每日榜",
    category: ""
};
const host = 'https://hsex.icu';
const cacheKey = "madoutvData";
let updateTime = new Date().toISOString();

/* ================== 工具函数（原逻辑不变） ================== */

function t(e) {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    let n = "";
    for (let r = 0; r < e; r++) {
        n += chars[Math.ceil(35 * Math.random())];
    }
    return n;
}

const CryptoJS = require("crypto-js");
const hsexRouter = require("../v19/hsex");
const r = CryptoJS;
const o = "-p9B[~PnPs";
const a = "Vq234zBeSdGgYXzVTEfnnjjdmaTkk7A4";

function i(e, t) {
    const iv = r.enc.Utf8.parse(o + t);
    const key = r.enc.Utf8.parse(a);
    const encrypted = r.AES.encrypt(e, key, {
        iv,
        mode: r.mode.CBC,
        padding: r.pad.Pkcs7,
        format: r.format.OpenSSL
    });
    return encrypted.toString();
}

function c(e, t) {
    const iv = r.enc.Utf8.parse(o + t);
    const key = r.enc.Utf8.parse(a);
    const decrypted = r.AES.decrypt(e, key, {
        iv,
        mode: r.mode.CBC,
        padding: r.pad.Pkcs7,
        formatter: r.format.OpenSSL
    });
    return decrypted.toString(r.enc.Utf8);
}

function md5(t) {
    return CryptoJS.MD5(t).toString();
}

const b = "m}q%ea6:LDcmS?aK)CeF287bPvd99@E,9Up^";

function encode_sign(obj) {
    const arr = [];
    for (const k in obj) {
        if (obj[k] !== "" && obj[k] !== null && obj[k] !== undefined) {
            arr.push(`${k}=${obj[k]}`);
        }
    }
    const str = arr.sort().join("&") + "&" + b;
    return md5(str);
}

function timestamp() {
    return Date.now();
}

function dataJSON(wd, pg) {
    const ts = timestamp();
    const base = {
        page: parseInt(pg),
        list_row: 100,
        keyword: wd,
        timestamp: ts
    };
    return {
        ...base,
        encode_sign: encode_sign(base)
    };
}

/* ================== 核心请求（走代理工具包） ================== */

async function search(wd, page) {
    const data = dataJSON(wd, page);
    const suffix = t(6);
    const postData = {
        "post-data": i(JSON.stringify(data), suffix)
    };

    const url = "https://api.nzp1ve.com/video/list";

    try {
        const res = await axiosClient({
            url,
            method: "POST",
            data: postData,
            useProxy: true, // ✅ 启用代理（失败自动直连）
            headers: {
                suffix,
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36",
                "Content-Type": "application/json",
                Accept: "application/json"
            }
        });

        const raw = res.data;
        const result = JSON.parse(c(raw.data, raw.suffix));
        return result;
    } catch (err) {
        console.error(
            `[madoutv][SEARCH_ERROR] wd=${wd} page=${page} →`,
            err.message
        );
        throw err;
    }
}

/* ================== 路由 ================== */

MadoutvHostRouter.get("/madoutv/:wd/:page", async (ctx) => {
    const { wd, page } = ctx.params;
    const key = `${cacheKey}_${wd}_${page}`;

    console.log(`[madoutv] 请求: ${wd} | page=${page}`);

    try {
        let data = await get(key);
        const from = data ? "cache" : "server";

        if (!data) {
            console.log("[madoutv] 缓存未命中，开始请求（代理优先）");
            data = await search(wd, page);

            if (!data) {
                return response(ctx, 500, null, "远程接口返回为空");
            }

            updateTime = new Date().toISOString();
            await set(key, data);
        }

        const newData = data.data.data.map(item => {
            return {
                aid: item.id,
                title: item.title,
                img: item.panorama,
                href: `${host}/video-${item.id}.htm`,
                desc: item.description,
                time: item.comefrom,
                video_url: item.video_url,
            };
        });

        ctx.body = {
            code: 200,
            message: "获取成功",
            ...routerInfo,
            from,
            total: data.data.total,
            updateTime,
            data: {count:data.data.total, data: newData}
        };
    } catch (err) {
        console.error("[madoutv] 接口异常:", err.message);
        ctx.status = 502;
        ctx.body = {
            code: 502,
            message: "目标接口访问失败（请检查代理或接口状态）"
        };
    }
});

MadoutvHostRouter.info = routerInfo;
module.exports = MadoutvHostRouter;
