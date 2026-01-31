const Router = require("koa-router");
const xi7Router = new Router();
const axiosClient = require("../../utils/axiosClient");
const { get, set, del } = require("../../utils/cacheData");
const response = require('../../utils/response')
const cheerio = require('cheerio');

// 接口信息
const routerInfo = {
  name: "7xiys", title: "7喜影视", subtitle: "每日榜", category: ""
};

// 缓存键名
const cacheKey = "QxiysData";

// 调用时间
let updateTime = new Date().toISOString();

const host = "https://7xiys.com";

// 数据处理
const getData = (data) => {
  if (!data) return [];
  const list = [];
  try {
    const $ = cheerio.load(data);
    $('.searchlist_item').each((index, element) => {
      const el = $(element);

      /* ========= 基础信息 ========= */

      // 详情页链接 + 标题
      const titleEl = el.find('.vodlist_title a');
      const href = titleEl.attr('href') || '';
      const title = titleEl
        .clone()
        .children('span')
        .remove()
        .end()
        .text()
        .trim();

      // 类型（连续剧 / 电影等）
      const type = titleEl.find('.info_right').text().trim();

      /* ========= 封面 & 状态 ========= */

      const thumbEl = el.find('.vodlist_thumb');

      // 封面图（background-image 里）
      const style = thumbEl.attr('style') || '';
      const imgMatch = style.match(/url\(['"]?(.*?)['"]?\)/);
      const cover = imgMatch ? imgMatch[1] : '';

      // 更新状态（已完结 / 更新至xx）
      const status = thumbEl.find('.pic_text').text().trim();

      /* ========= 主演 ========= */

      const actors = [];
      el.find('.vodlist_sub')
        .eq(0)
        .find('a.searchkey')
        .each((_, a) => {
          actors.push($(a).text().trim());
        });

      /* ========= 导演 ========= */

      const directors = [];
      el.find('.vodlist_sub')
        .eq(1)
        .find('a.searchkey')
        .each((_, a) => {
          directors.push($(a).text().trim());
        });

      /* ========= 简介 ========= */

      const desc = el
        .find('.vodlist_sub.hidden_xs')
        .text()
        .replace('简介：', '')
        .replace(/\s+/g, ' ')
        .trim();

      /* ========= 汇总 ========= */

      list.push({
        aid: href.split('/')[2],
        title,
        type,
        href: host + href,
        cover,
        status,
        actors,
        directors,
        desc
      });
    });


    return list;
  } catch (error) {
    console.error("数据处理出错" + error);
    return false;
  }
};

// 播放地址
xi7Router.get("/7xiys/watch", async (ctx) => {
  const { url } = ctx.query;
  console.log(`请求地址 => ${url}`);

  const res = await axiosClient({
    url,
    useProxy: false
  });

  const html = res.data;

  try {
    // 🔒 精准正则：以 url_next 作为结束边界
    const match = html.match(/"url"\s*:\s*"(.+?)","url_next"/);

    if (!match) {
      throw new Error('未匹配到 url 字段');
    }

    const encodedUrl = match[1];
    console.log('提取到的 url =>', encodedUrl);

    const data = `https://safari4.jinbianpiao.com/p/d.html?p=27pan&u=${encodedUrl}`;
    response(ctx, 200, data, '成功');
  } catch (err) {
    console.error(err);
    response(ctx, 606, '', '此类数据有毒，但是很好看！');
  }
});


// 7喜影视搜索
xi7Router.get("/7xiys/:wd/:page", async (ctx) => {
  const { wd, page } = ctx.params;

  const url = `${host}/vod/search/page/${page}/wd/${wd}.html`;
  console.log(`获取7喜影视 ${url}`);
  const cacheKeyUrl = `${cacheKey}_${wd}_${page}`;
  try {
    // 从缓存中获取数据
    let data = await get(cacheKeyUrl);
    const from = data ? "cache" : "server";
    if (!data) {
      // 如果缓存中不存在数据
      console.log("从服务端重新获取7喜影视");
      // 从服务器拉取数据
      const res = await axiosClient({
        url,
        useProxy: true,
        headers: {
          Referer: host
        }
      });
      data = getData(res.data);
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
      await set(cacheKeyUrl, data);
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


xi7Router.info = routerInfo;
module.exports = xi7Router;
