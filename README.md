# 中西文自动间距

独立的 Chromium Manifest V3 扩展。默认在所有网页中启用浏览器原生 `text-autospace: normal`，仅调整中西文、中文与数字之间的排版间距。文字内容、字体、字号与连字设置保持原样。

点击工具栏图标，可切换全局开关，以及当前网站的“跟随全局/开启/关闭”。当前主机命中端口规则时，网站开关更新该端口规则；弹窗修改会保留其他窗口已保存的设置。“管理所有网站设置”打开完整设置页，可以添加、编辑和删除网站规则。关闭扩展的间距样式后恢复网站原有设置；网站自身原本开启的自动间距仍会保留。

规则示例：`example.com` 匹配主域名及子域名，`docs.example.com` 的优先级更高；`example.com:443` 仅匹配对应端口。域名不填端口时匹配全部端口。同等规则采用列表中最先出现的条目。更具体的“跟随全局”规则也会覆盖较宽泛的站点规则。

从 [GitHub Release](https://github.com/Speechlessmanbilibili/native-auto-space/releases/latest) 下载版本 ZIP，拖入 Chrome/Edge 扩展管理页安装。需要浏览器支持 `text-autospace`；不支持时，设置页会提示更新浏览器。浏览器内部页和扩展商店等限制页面无法注入。本地文件需要在扩展管理页允许访问文件网址。

固定扩展 ID 为 `hciemeeoeagloegjphmccjmhlmdhjkfa`。更新时拖入新版 ZIP，覆盖原扩展并沿用已有设置。

按全局与站点规则预注册 CSS，浏览器在 `document_start` 提前加载。匿名样式层覆盖网页样式表中的高权重及分层重要声明；行内 `!important` 在后台 USER 样式完成后覆盖。后台重启时复用页面已确认的注入状态，保留后来加入的同权重 USER 样式顺序。

关闭时，通过根元素开关停用提前样式，并移除用户样式，恢复网站原有间距；网页重建根元素后继续保持关闭。动态节点、普通 DOM 中的伪元素和占位文字直接受 CSS 覆盖，文字中不添加实际空格。Shadow DOM 内部元素按自身样式和宿主传入的继承值排版。每个网页框架按自身地址匹配规则；空白、`srcdoc`、`blob` 和 `data` 框架沿用创建来源的域名和端口。

配置使用 `chrome.storage.local`，仅保存在当前浏览器中，不上传、不同步浏览记录或页面内容。可与字体替换扩展分别安装；它的全局间距规则独立生效。

开发：`npm install`、`npm test`、`npm run build`。构建产物位于 `dist/`，版本 ZIP 同时复制到系统定义的下载目录。更新记录见 [CHANGELOG.md](CHANGELOG.md)。

站点地址解析沿用[字体替换扩展](https://github.com/Speechlessmanbilibili/system-font-substituter)的实现。本项目采用 [GNU GPL v3 或后续版本](LICENSE)，独立间距功能与界面新增于 2026-10-05。
