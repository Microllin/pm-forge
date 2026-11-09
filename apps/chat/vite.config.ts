import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

import { loadConfig } from "./server/config.js";

// 端口与服务端同一套环境变量（PMFORGE_CHAT_PORT / PMFORGE_CHAT_WEB_PORT），
// 这样能并排起第二套实例（比如验收用）而不撞默认的 4400 / 3200。
const { port, webPort } = loadConfig();
/**
 * 页面服务监听在哪。默认只给本机；部署到开发机给局域网用时设 PMFORGE_CHAT_WEB_HOST=0.0.0.0，
 * 同时把浏览器打开的地址加进 PMFORGE_CHAT_ALLOWED_ORIGINS（否则写请求被 Origin 闸拦下）。
 * 对话服务本身始终只听回环，局域网只能经这里的 /api 代理进去。
 */
const webHost = process.env.PMFORGE_CHAT_WEB_HOST ?? "127.0.0.1";
const proxy = {
  "/api": {
    target: `http://127.0.0.1:${String(port)}`,
    changeOrigin: true,
  },
};

/**
 * 前端开发服务器。/api 代理到对话服务；changeOrigin 让 Host 满足服务端的 Host 闸，
 * Origin 原样转发（服务端白名单里有前端端口）。
 */
export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "../dist", emptyOutDir: true },
  server: {
    host: webHost,
    port: webPort,
    strictPort: true,
    proxy,
  },
  /** 正式运行（pnpm start）：先 build，再用 preview 托管打包产物，同一套代理。 */
  preview: {
    host: webHost,
    port: webPort,
    strictPort: true,
    proxy,
  },
});
