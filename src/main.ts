import { createApp } from "vue";
import { createPinia } from "pinia";
// ElMessageBox 是显式 import 的服务式组件（Sidebar.vue:7 等三处），插件不接管它的样式
import "element-plus/es/components/message-box/style/css";
// select 只在懒加载视图里出现，它的样式会跟着 JS chunk 在 element.css 之后注入并反超覆盖层
// （同特异性后到者赢）；显式静态引入，让它回到入口图里、排在 element.css 之前，顺带去重
import "element-plus/es/components/select/style/css";
// dark css-vars 绑定 html.dark，须在 element.css 之前引入，让项目主题变量赢
import "element-plus/theme-chalk/dark/css-vars.css";
import App from "./App.vue";
import "./assets/phosphor/phosphor-used.css";
import "./styles/global.css";
import "./styles/skills.css";
import "./styles/sync.css";
import "./styles/memory.css";
import "./styles/element.css";
// 液滴光标 + 点击涟漪（纯装饰动效层：触屏/减弱动效下自动不安装）
// 首帧镜像（与 config 异步加载形成双轨）：界面动效默认开启，镜像为 "0" 才关（缺失跟随默认）；
// 粒子尘场 / 光池追随默认关闭，镜像为 "1" 才开；个性化鼠标样式默认开启，镜像为 "0" 才关。
// html 类在这里同步切好，首帧即按配置态渲染
import { setCursorFX } from "./motion/cursor";

const app = createApp(App);
app.use(createPinia());
// mount 前安装：动效开启的用户光标已就位，避免先闪一下系统箭头
const fxOn = localStorage.getItem("agenthub.fx") !== "0";
// 液滴光标与总开关联动：任一关掉都恢复系统指针
const cursorOn = fxOn && localStorage.getItem("agenthub.fxCursor") !== "0";
const root = document.documentElement;
root.classList.toggle("fx-off", !fxOn);
root.classList.toggle("fx-particles-off", localStorage.getItem("agenthub.fxParticles") !== "1");
root.classList.toggle("fx-pools-off", localStorage.getItem("agenthub.fxPools") !== "1");
setCursorFX(cursorOn);
app.mount("#app");
