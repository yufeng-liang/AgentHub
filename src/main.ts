import { createApp } from "vue";
import { createPinia } from "pinia";
import zhCn from "element-plus/es/locale/lang/zh-cn";
// ElMessageBox 是显式 import 的服务式组件（Sidebar.vue:7 等三处），插件不接管它的样式
import "element-plus/es/components/message-box/style/css";
// dark css-vars 绑定 html.dark，须在 element.css 之前引入，让项目主题变量赢
import "element-plus/theme-chalk/dark/css-vars.css";
import App from "./App.vue";
import "./assets/phosphor/style.css";
import "./styles/global.css";
import "./styles/skills.css";
import "./styles/sync.css";
import "./styles/element.css";
// 液滴光标 + 点击涟漪（纯装饰动效层：触屏/减弱动效下自动不安装；「界面动效」默认关闭，
// 仅镜像显式为 1 才安装，缺失视为关 —— 新装用户冷启动不闪现光标；fx-off 类在这里同步切好，首帧即按关闭态渲染）
import { setCursorFX } from "./motion/cursor";

const app = createApp(App);
app.use(createPinia());
// mount 前安装：动效开启的用户光标已就位，避免先闪一下系统箭头
const fxOn = localStorage.getItem("agenthub.fx") === "1";
document.documentElement.classList.toggle("fx-off", !fxOn);
setCursorFX(fxOn);
app.mount("#app");
