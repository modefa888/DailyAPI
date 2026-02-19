const Router = require("koa-router");
const client = require("../../utils/mongo");

const shareRouter = new Router();
const routerInfo = { name: "分享", title: "分享播放", subtitle: "公开分享链接" };
const DB_NAME = process.env.MONGODB_DB || undefined;

const getDb = async () => {
    await client.connect();
    return DB_NAME ? client.db(DB_NAME) : client.db();
};

shareRouter.get("/share/:shareId", async (ctx) => {
    const shareId = String(ctx.params.shareId || "").trim();
    if (!shareId) {
        ctx.status = 400;
        ctx.body = { code: 400, message: "分享ID不能为空" };
        return;
    }
    const db = await getDb();
    const share = await db.collection("user_shares").findOne({ shareId });
    if (!share) {
        ctx.status = 404;
        ctx.body = { code: 404, message: "分享不存在" };
        return;
    }
    const expiresAtMs = share.expiresAt ? share.expiresAt.getTime() : 0;
    if (expiresAtMs && Date.now() > expiresAtMs) {
        ctx.status = 410;
        ctx.body = { code: 410, message: "分享已过期" };
        return;
    }
    ctx.body = {
        code: 200,
        message: "获取成功",
        ...routerInfo,
        data: {
            shareId: share.shareId,
            url: share.url,
            title: share.title,
            pic: share.pic,
            source: share.source,
            expiresAt: expiresAtMs,
            createdAt: share.createdAt ? share.createdAt.getTime() : Date.now(),
            updatedAt: share.updatedAt ? share.updatedAt.getTime() : null,
        },
    };
});

shareRouter.info = routerInfo;
module.exports = shareRouter;
