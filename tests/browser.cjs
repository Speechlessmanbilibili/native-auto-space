const { chromium } = require("playwright");

// 自动测试使用独立浏览器；可显式选择已安装的 Chromium。
const executablePath = process.env.CHROMIUM_PATH || chromium.executablePath();
module.exports = { chromium, executablePath };
