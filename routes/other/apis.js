const Router = require("koa-router");
const apisRouter = new Router();

// 接口信息
const routerInfo = { name: "官方推荐API", title: "官方推荐", subtitle: "视频资源接口" };
const videoAccessPassword = process.env.VIDEO_ACCESS_PASSWORD || "123456";

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
    ctx.body = {
        code: 200,
        message: "获取成功",
        ...routerInfo,
        total: officialApis.length,
        data: officialApis,
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
    };
});


apisRouter.info = routerInfo;
module.exports = apisRouter;
