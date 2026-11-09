import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // 只剩第三代 apps/chat（第二代 core/web 已于 2026-10-28 存档移除，见 tag archive/v2-core-web-20261028）。
    projects: [
      // apps/chat：独立对话服务，服务端与前端各一个 project。
      {
        test: {
          name: "chat-server",
          environment: "node",
          include: ["apps/chat/server/**/*.test.ts"],
        },
      },
      {
        test: {
          name: "chat-web",
          environment: "jsdom",
          setupFiles: ["./apps/chat/vitest.setup.ts"],
          include: ["apps/chat/web/**/*.test.{ts,tsx}"],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
    },
  },
});
