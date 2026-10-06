# 中西文自动间距

独立的 Chromium Manifest V3 扩展。默认在所有网页中启用浏览器原生 `text-autospace: normal`，仅调整中西文、中文与数字之间的排版间距。文字内容、字体、字号与连字设置保持原样。

点击工具栏图标，可切换全局开关，以及当前网站的“跟随全局/开启/关闭”。“管理所有网站设置”打开完整设置页，可以添加、编辑和删除网站规则。关闭扩展的间距样式后恢复网站原有设置；网站自身原本开启的自动间距仍会保留。

规则示例：`example.com` 匹配主域名及子域名，`docs.example.com` 的优先级更高；`example.com:443` 仅匹配对应端口。域名不填端口时匹配全部端口。同等规则采用列表中最先出现的条目。更具体的“跟随全局”规则也会覆盖较宽泛的站点规则。

从 [GitHub Release](https://github.com/Speechlessmanbilibili/native-auto-space/releases/latest) 下载版本 ZIP，拖入 Chrome/Edge 扩展管理页安装。需要浏览器支持 `text-autospace`；不支持时，设置页会提示更新浏览器。浏览器内部页和扩展商店等限制页面无法注入。本地文件需要在扩展管理页允许访问文件网址。

按全局与站点规则预注册 CSS，浏览器在 `document_start` 提前加载。提前样式放在匿名层中，利用重要声明的层优先级抵抗网页样式表（包括高权重选择器和分层的 `!important`）。后台随后通过 `insertCSS({ origin: "USER" })` 应用 `text-autospace: normal !important`，其优先级高于网页样式表及行内的重要声明。扩展不修改网页文字或行内样式，也不反复抢占用户或其他扩展有意提供的 USER 样式。

Chromium 的 `RegisteredContentScript` 没有 `origin` 字段，预注册 CSS 属于 AUTHOR 来源。因此，后台 USER 注入完成前，行内 `!important` 仍可能在首段网站脚本或首帧中生效，不能承诺这一窗口为零。运行中的 CSS 过渡也具有独立的高优先级，本扩展不通过禁用网站动画来掩盖这个边界。接口依据见 [Chrome scripting 文档](https://developer.chrome.com/docs/extensions/reference/api/scripting)、[Chromium 注册样式注入实现](https://github.com/chromium/chromium/blob/main/extensions/renderer/user_script_injector.cc)和 [CSS 层叠规范](https://www.w3.org/TR/css-cascade-5/#cascade-sort)。

关闭时，通过根元素开关停用已加载的提前样式，并移除用户样式，恢复网站原有间距。动态节点、普通 DOM 中的伪元素和占位文字直接受 CSS 覆盖，文字中不添加实际空格。Shadow DOM 内部元素不保证覆盖。每个网页框架按自身地址匹配规则；`about:blank` 和 `srcdoc` 框架沿用创建页面的来源。

配置使用 `chrome.storage.local`，仅保存在当前浏览器中，不上传、不同步浏览记录或页面内容。可与字体替换扩展分别安装；它的全局间距规则独立生效。

开发：`npm install`、`npm test`、`npm run build`。构建产物位于 `dist/`，版本 ZIP 同时复制到系统定义的下载目录。更新记录见 [CHANGELOG.md](CHANGELOG.md)。

自动测试默认使用 Playwright 安装的 Chromium，也可通过 `CHROMIUM_PATH` 指定独立测试浏览器。非 Windows 环境可运行 `node --test tests/background.test.cjs tests/early.test.cjs tests/extension.test.cjs`；完整 `npm test` 还会运行 Windows PowerShell 5.1 发布包检查。首屏回归将 USER 注入延迟至少 700 毫秒，输出普通声明、网页 `!important`、网页分层 `!important` 与行内 `!important` 在首段脚本、首帧和 USER 注入后的实测值。行内用例明确断言补充前的边界，不将其计作无窗口覆盖。另有动态覆盖、开关恢复、其他 USER 样式和离散过渡诊断。

站点地址解析沿用[字体替换扩展](https://github.com/Speechlessmanbilibili/system-font-substituter)的实现。本项目采用 [GNU GPL v3 或后续版本](LICENSE)，独立间距功能与界面新增于 2026-10-05。
