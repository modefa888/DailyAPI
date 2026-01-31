const Router = require("koa-router");
const baiduRouter = new Router();
const axios = require("axios");
const { get, set, del } = require("../../utils/cacheData");

// 接口信息
const routerInfo = { name: "baidu", title: "百度", subtitle: "热搜榜" };

// 缓存键名
const cacheKey = "baiduData";

// 调用时间
let updateTime = new Date().toISOString();

// 调用路径
const url = "https://top.baidu.com/board?tab=realtime";

// 数据处理
const xpath = require('xpath');
const { DOMParser } = require('xmldom');

const getData = (html) => {
  if (!html) return [];

  const list = [];

  try {
    const doc = new DOMParser({
      errorHandler: { warning: null, error: null }
    }).parseFromString(html, 'text/html');

    // 每一条热搜卡片
    const items = xpath.select(
      "//*[contains(@class,'category-wrap')]",
      doc
    );

    items.forEach((node) => {
      /* ===== 标题 ===== */
      const titleNode = xpath.select1(
        ".//*[contains(@class,'c-single-text-ellipsis')]",
        node
      );
      const title = titleNode?.textContent.trim() || '';

      /* ===== 链接 ===== */
      const urlNode = xpath.select1(
        ".//a[contains(@class,'title')]",
        node
      );
      const url = urlNode?.getAttribute('href') || '';

      /* ===== 描述（优先短描述） ===== */
      const descNode =
        xpath.select1(".//*[contains(@class,'hot-desc') and contains(@class,'small')]", node)
        || xpath.select1(".//*[contains(@class,'hot-desc') and contains(@class,'large')]", node);

      const desc = descNode
        ? descNode.textContent.replace(/查看更多>.*/g, '').trim()
        : '';

      /* ===== 热度 ===== */
      const hotNode = xpath.select1(
        ".//*[contains(@class,'hot-index')]",
        node
      );
      const hot = hotNode
        ? Number(hotNode.textContent.replace(/\s+/g, ''))
        : 0;

      /* ===== 图片 ===== */
      const imgNodes = xpath.select(
        ".//img",
        node
      );
      const pic =
        imgNodes.length > 1
          ? imgNodes[1].getAttribute('src')
          : imgNodes[0]?.getAttribute('src') || '';

      if (!title) return;

      list.push({
        title,
        desc,
        pic,
        hot,
        url,
        mobileUrl: url
      });
    });

    return list;
  } catch (err) {
    console.error('[XPATH_PARSE_ERROR]', err.message);
    return [];
  }
};



// 百度热搜
baiduRouter.get("/baidu", async (ctx) => {
  console.log("获取百度热搜");
  try {
    // 从缓存中获取数据
    let data = await get(cacheKey);
    const from = data ? "cache" : "server";
    if (!data) {
      // 如果缓存中不存在数据
      console.log("从服务端重新获取百度热搜");
      // 从服务器拉取数据
      const response = await axios.get(url);
      data = getData(response.data);
      updateTime = new Date().toISOString();
      if (!data) {
        ctx.body = {
          code: 500,
          ...routerInfo,
          message: "获取失败",
        };
        return false;
      }
      // 将数据写入缓存
      await set(cacheKey, data);
    }
    ctx.body = {
      code: 200,
      message: "获取成功",
      ...routerInfo,
      from,
      total: data.length,
      updateTime,
      data,
    };
  } catch (error) {
    console.error(error);
    ctx.body = {
      code: 500,
      message: "获取失败",
    };
  }
});

// 百度热搜 - 获取最新数据
baiduRouter.get("/baidu/new", async (ctx) => {
  console.log("获取百度热搜 - 最新数据");
  try {
    // 从服务器拉取最新数据
    const response = await axios.get(url);
    const newData = getData(response.data);
    updateTime = new Date().toISOString();
    console.log("从服务端重新获取百度热搜");

    // 返回最新数据
    ctx.body = {
      code: 200,
      message: "获取成功",
      ...routerInfo,
      total: newData.length,
      updateTime,
      data: newData,
    };

    // 删除旧数据
    await del(cacheKey);
    // 将最新数据写入缓存
    await set(cacheKey, newData);
  } catch (error) {
    // 如果拉取最新数据失败，尝试从缓存中获取数据
    console.error(error);
    const cachedData = await get(cacheKey);
    if (cachedData) {
      ctx.body = {
        code: 200,
        message: "获取成功",
        ...routerInfo,
        total: cachedData.length,
        updateTime,
        data: cachedData,
      };
    } else {
      // 如果缓存中也没有数据，则返回错误信息
      ctx.body = {
        code: 500,
        ...routerInfo,
        message: "获取失败",
      };
    }
  }
});

baiduRouter.info = routerInfo;
module.exports = baiduRouter;
