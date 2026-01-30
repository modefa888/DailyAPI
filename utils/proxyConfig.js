/**
 * 代理配置
 * 关闭代理：enabled = false
 * 开启代理：enabled = true
 */

module.exports = {
    enabled: true,               // ⭐ 全局开关
    type: "http",               // socks5 | http
    host: "127.0.0.1",
    port: 10808,                  // socks5 常用 10808 / http 常用 7890
    timeout: 15000
};
