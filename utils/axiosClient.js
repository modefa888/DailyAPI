const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

/**
 * 创建 axios 实例
 */
function createAxiosInstance({ proxy, timeout = 15000 }) {
    const config = {
        timeout,
        headers: {
            'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
    };

    if (proxy) {
        // socks5://127.0.0.1:10808
        // http://127.0.0.1:7890
        const agent =
            proxy.startsWith('socks')
                ? new SocksProxyAgent(proxy)
                : new HttpsProxyAgent(proxy);

        config.httpAgent = agent;
        config.httpsAgent = agent;
    }

    return axios.create(config);
}

/**
 * axiosClient
 * @param {Object} options
 * @param {string} options.url
 * @param {string} options.method
 * @param {Object} options.params
 * @param {Object} options.data
 * @param {boolean} options.useProxy 是否启用代理
 * @param {string} options.proxy 代理地址
 */
async function axiosClient(options) {
    const {
        url,
        method = 'GET',
        params,
        data,
        headers,
        useProxy = false,
        proxy = 'http://127.0.0.1:10808',
    } = options;

    // 1️⃣ 优先：代理请求
    if (useProxy) {
        try {
            const proxyAxios = createAxiosInstance({ proxy });
            const res = await proxyAxios({
                url,
                method,
                params,
                data,
                headers,
            });

            return res;
        } catch (err) {
            console.warn('[axiosClient] 代理失败，切换直连:', err.message);
        }
    }

    // 2️⃣ fallback：直连
    const directAxios = createAxiosInstance({});
    return directAxios({
        url,
        method,
        params,
        data,
        headers,
    });
}

module.exports = axiosClient;
