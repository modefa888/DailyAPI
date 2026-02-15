const Router = require("koa-router");
const apisRouter = new Router();

// 接口信息
const routerInfo = { name: "官方推荐API", title: "官方推荐", subtitle: "视频资源接口" };

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


apisRouter.info = routerInfo;
module.exports = apisRouter;
