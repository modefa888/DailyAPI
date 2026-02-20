const fs = require("fs");
const path = require("path");
const Router = require("koa-router");

const router = new Router();

// 全部路由数据
const allRouterInfo = {
    name: "全部接口",
    subtitle: "除了特殊接口外的全部接口列表",
    total: 0,
    data: [],
};

// 根目录
router.get("/", async (ctx) => {
    await ctx.render("index");
});

function registerRoutes(folderPath, router, allRouterInfo, folderName) {
    fs.readdirSync(folderPath)
        .filter((filename) => filename.endsWith(".js") && filename !== "index.js")
        .forEach((filename) => {
            const routerPath = path.join(folderPath, filename);
            const routerModule = require(routerPath);
            // 自动注册路由
            if (routerModule instanceof Router) {
                // 写入路由数据
                if (routerModule?.info) {
                    allRouterInfo.total++;
                    allRouterInfo.data.push({
                        ...routerModule.info,
                        folder: folderName || path.basename(folderPath),
                        file: filename,
                        stack: routerModule.stack,
                    });
                }
                // 引用路由
                router.use(routerModule.routes())
            }
        });
}

// 遍历video文件夹下的所有路由模块
registerRoutes(__dirname + "/video", router, allRouterInfo, "video");

// 遍历hot文件夹下的所有路由模块
registerRoutes(__dirname + "/hot", router, allRouterInfo, "hot");


// 遍历other文件夹下的所有路由模块
registerRoutes(__dirname + "/other", router, allRouterInfo, "other");

// 遍历music文件夹下的所有路由模块
registerRoutes(__dirname + "/music", router, allRouterInfo, "music");

// 遍历bit文件夹下的所有路由模块
registerRoutes(__dirname + "/bit", router, allRouterInfo, "bit");

// 遍历comics文件夹下的所有路由模块
registerRoutes(__dirname + "/comics", router, allRouterInfo, "comics");

// 遍历live文件夹下的所有路由模块
registerRoutes(__dirname + "/live", router, allRouterInfo, "live");

// 遍历story文件夹下的所有路由模块
registerRoutes(__dirname + "/story", router, allRouterInfo, "story");

// 遍历v19文件夹下的所有路由模块
registerRoutes(__dirname + "/v19", router, allRouterInfo, "v19");

// 遍历proxy文件夹下的所有路由模块
registerRoutes(__dirname + "/proxy", router, allRouterInfo, "proxy");

// 遍历scheduleJob文件夹下的所有路由模块
registerRoutes(__dirname + "/scheduleJob", router, allRouterInfo, "scheduleJob");

// 遍历user文件夹下的所有路由模块
registerRoutes(__dirname + "/user", router, allRouterInfo, "user");

// 全部接口路由
router.get("/all", async (ctx) => {
    console.log("获取全部接口路由");
    if (allRouterInfo.total > 0) {
        ctx.body = {
            code: 200,
            message: "获取成功",
            ...allRouterInfo,
        };
    } else if (allRouterInfo.total === 0) {
        ctx.body = {
            code: 200,
            message: "暂无接口，请添加",
            ...allRouterInfo,
        };
    } else {
        ctx.body = {
            code: 500,
            message: "获取失败",
            ...allRouterInfo,
        };
    }
});

// 404 路由
router.use(async (ctx) => {
    await ctx.render("404");
});

module.exports = router;
