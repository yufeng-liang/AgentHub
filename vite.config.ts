import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import Components from "unplugin-vue-components/vite";
import { ElementPlusResolver } from "unplugin-vue-components/resolvers";

// Electron 前端配置：dev 端口 1420（与 electron/main.cjs 的加载地址一致）
// base 用相对路径，便于 Electron 通过 file:// 加载打包后的 index.html
export default defineConfig({
  plugins: [
    vue(),
    // Element Plus 按需注册：模板里的 <el-*> 自动引入组件与各自样式，替代原来的
    // app.use(ElementPlus) 全量注册 + index.css 全量样式（361 KB）。
    // directives: false —— 全库没用 v-loading / ElInfiniteScroll 等指令式组件。
    // dirs: [] —— 关掉默认的 src/components 递归扫描。本仓库所有本地组件都是显式
    // import 的，留着它只会往 components.d.ts 里塞 19 条没人用的全局声明（实测产物逐字节相同）。
    Components({
      resolvers: [ElementPlusResolver({ directives: false })],
      dirs: [],
      dts: "src/components.d.ts",
    }),
  ],
  base: "./",
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  build: {
    target: ["es2021", "chrome100"],
    minify: "esbuild",
    sourcemap: false,
    outDir: "dist",
  },
});
