import { EnvHttpProxyAgent } from 'undici';

// 网页工具与远程 MCP 使用同一组部署环境代理设置，内部地址由 NO_PROXY 决定是否直连。
export const envHttpProxyDispatcher = new EnvHttpProxyAgent();
