const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const http = require("node:http");
const { chromium, executablePath } = require("./browser.cjs");
const root = path.resolve(__dirname, "..");
const sandbox = { URL };
vm.runInNewContext(fs.readFileSync(path.join(root, "shared.js"), "utf8"), sandbox);
const { normalize, parseDomain, resolve } = sandbox.AutoSpace;
let server, origin, browser;
const fixture = '<!doctype html><meta charset="utf-8"><style>* {text-autospace:no-autospace!important;} body {font:16px Arial;} .mixed::before {content:"中文English";}</style><p id="text" class="mixed">中文English数字123</p><input id="search" placeholder="中文Search"><div id="dynamic"></div>';
before(async () => {
  server = http.createServer((request, response) => {
    const name = request.url.slice(1).split("?")[0];
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html; charset=utf-8");
    if (["options.html", "popup.html", "shared.js", "ui.js", "ui.css"].includes(name)) response.end(fs.readFileSync(path.join(root, name)));
    else response.end(fixture);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({ headless: true, executablePath });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

test("默认全局开启，站点三态、子域名、端口及同等规则顺序正确", () => {
  assert.equal(normalize(null).enabled, true);
  assert.equal(normalize({ enabled: false }).enabled, false);
  const settings = normalize({ enabled: false, siteRules: [
    { domain: "example.com", mode: "on" }, { domain: "docs.example.com", mode: "off" },
    { domain: "docs.example.com:443", mode: "inherit" }, { domain: "docs.example.com:443", mode: "on" }
  ] });
  assert.equal(resolve(settings, "https://other.example.com").enabled, true);
  assert.equal(resolve(settings, "https://docs.example.com").enabled, false);
  assert.equal(resolve(settings, "http://docs.example.com").rule.mode, "off");
  assert.equal(resolve(settings, "https://notexample.com").rule, null);
  assert.equal(parseDomain("https://EXAMPLE.com:443/path").domain, "example.com:443");
  assert.equal(parseDomain("[::1]:80").domain, "[::1]:80");
  assert.equal(parseDomain("例子.中国").host, "xn--fsqu00a.xn--fiqs8s");
  for (const domain of ["", "bad domain", "https://a@b", "ftp://example.com", "example.com:65536"]) assert.equal(parseDomain(domain), null);
});

async function uiPage(name, stored = {}, currentURL = "https://docs.example.com/page") {
  const page = await browser.newPage();
  await page.addInitScript(({ stored, currentURL }) => {
    window.__stored = stored;
    window.chrome = {
      storage: { local: { get: async () => ({ settings: __stored }), set: async value => { __stored = value.settings; } } },
      tabs: { query: async () => [{ url: currentURL }] },
      runtime: { openOptionsPage: () => { window.__opened = true; } }
    };
  }, { stored, currentURL });
  await page.goto(origin + "/" + name);
  await page.waitForFunction(() => document.getElementById("enabled").checked === (window.__stored.enabled !== false));
  return page;
}

test("设置页添加、校验、保存、删除及全局开关正确，窄屏无溢出", async () => {
  const page = await uiPage("options.html");
  await page.getByRole("button", { name: "添加网站" }).click();
  await page.locator(".domain").fill("https://EXAMPLE.com:443/path");
  await page.getByText("关闭", { exact: true }).click();
  await page.getByRole("button", { name: "保存设置" }).click();
  await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("已保存"));
  assert.deepEqual(await page.evaluate(() => __stored), { enabled: true, siteRules: [{ domain: "example.com:443", mode: "off" }] });
  await page.getByRole("button", { name: "添加网站" }).click();
  await page.locator(".domain").last().fill("example.com:443");
  await page.getByRole("button", { name: "保存设置" }).click();
  assert.equal(await page.locator(".domain").last().evaluate(el => el.validationMessage), "此域名已有规则。");
  assert.equal((await page.evaluate(() => __stored.siteRules)).length, 1);
  await page.locator(".delete").last().click();
  await page.locator("#enabled").uncheck();
  await page.getByRole("button", { name: "保存设置" }).click();
  await page.waitForFunction(() => __stored.enabled === false);
  await page.locator(".delete").click();
  await page.getByRole("button", { name: "保存设置" }).click();
  await page.waitForFunction(() => __stored.siteRules.length === 0);
  for (const width of [360, 768]) {
    await page.setViewportSize({ width, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  await page.close();
});

test("工具栏显示继承规则，本站覆盖和跟随全局及时保存", async () => {
  const page = await uiPage("popup.html", { enabled: true, siteRules: [{ domain: "example.com", mode: "off" }] });
  await page.waitForFunction(() => document.getElementById("effective").textContent.includes("匹配 example.com"));
  assert.equal(await page.locator('[value="off"]').isChecked(), true);
  await page.getByText("开启", { exact: true }).click();
  await page.waitForFunction(() => __stored.siteRules.length === 2);
  assert.deepEqual((await page.evaluate(() => __stored.siteRules))[1], { domain: "docs.example.com", mode: "on" });
  await page.getByText("跟随全局", { exact: true }).click();
  await page.waitForFunction(() => __stored.siteRules[1].mode === "inherit");
  await page.locator("#enabled").uncheck();
  await page.waitForFunction(() => document.getElementById("effective").textContent.startsWith("当前：关闭"));
  await page.getByRole("button", { name: /管理所有网站/ }).click();
  assert.equal(await page.evaluate(() => __opened), true);
  await page.close();
});

test("保存期间的新编辑保留为草稿，失败后仍能重试", async () => {
  const page = await uiPage("options.html", { enabled: true, siteRules: [{ domain: "example.com", mode: "off" }] });
  await page.waitForFunction(() => document.querySelector(".domain"));
  await page.evaluate(() => {
    chrome.storage.local.set = value => new Promise(resolve => { window.__finishSave = () => { __stored = value.settings; resolve(); }; });
  });
  await page.getByRole("button", { name: "保存设置" }).click();
  await page.waitForFunction(() => !!window.__finishSave);
  await page.locator(".domain").fill("docs.example.com");
  await page.evaluate(() => __finishSave());
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("仍有未保存"));
  assert.equal(await page.locator(".domain").inputValue(), "docs.example.com");
  assert.equal(await page.evaluate(() => __stored.siteRules[0].domain), "example.com");
  await page.evaluate(() => { chrome.storage.local.set = async () => { throw Error("模拟写入失败"); }; });
  await page.getByRole("button", { name: "保存设置" }).click();
  await page.waitForFunction(() => document.getElementById("status").textContent.includes("保存失败"));
  assert.equal(await page.locator(".domain").inputValue(), "docs.example.com");
  assert.equal(await page.locator("#save").isEnabled(), true);
  await page.close();
});

test("受限制页面仍能设置全局，本站设置停用且不报错", async () => {
  const page = await uiPage("popup.html", {}, "chrome://extensions");
  await page.waitForFunction(() => document.getElementById("host").textContent.includes("不支持"));
  assert.equal(await page.locator("#site-mode").evaluate(el => el.disabled), true);
  await page.locator("#enabled").uncheck();
  await page.waitForFunction(() => __stored.enabled === false);
  await page.close();
});

test("真实 MV3 注入覆盖网页重要声明，动态内容、框架及实时设置正确", async t => {
  const context = await chromium.launchPersistentContext("", { headless: true, executablePath,
    args: ["--disable-extensions-except=" + root, "--load-extension=" + root] });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
    const errors = [];
    worker.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
    const page = await context.newPage();
    await page.goto(origin + "/page");
    await page.waitForFunction(() => getComputedStyle(document.getElementById("text")).textAutospace === "normal");
    assert.equal(await page.locator("#text").textContent(), "中文English数字123");
    assert.equal(await page.locator("#text").evaluate(el => getComputedStyle(el).fontFamily), "Arial");
    assert.equal(await page.locator("#text").evaluate(el => getComputedStyle(el, "::before").textAutospace), "normal");
    assert.equal(await page.locator("#search").evaluate(el => getComputedStyle(el, "::placeholder").textAutospace), "normal");
    await page.evaluate(() => {
      document.getElementById("dynamic").innerHTML = '<p id="new-text">中文Dynamic</p><iframe id="child" src="' + location.href.replace("127.0.0.1", "localhost") + '"></iframe><iframe id="blank"></iframe>';
      document.getElementById("blank").contentDocument.body.innerHTML = '<p id="blank-text">中文Blank</p>';
    });
    await page.waitForFunction(() => getComputedStyle(document.getElementById("new-text")).textAutospace === "normal");
    await page.frameLocator("#child").locator("#text").waitFor();
    await page.waitForFunction(() => document.getElementById("blank").contentWindow.getComputedStyle(document.getElementById("blank").contentDocument.getElementById("blank-text")).textAutospace === "normal");
    // 关闭全局后保留本站开启，另一个框架独立关闭；空白框架沿用创建者来源。
    await worker.evaluate(() => chrome.storage.local.set({ settings: { enabled: false, siteRules: [
      { domain: "127.0.0.1", mode: "on" }, { domain: "localhost", mode: "off" }
    ] } }));
    await page.waitForFunction(() => getComputedStyle(document.getElementById("text")).textAutospace === "normal");
    await page.frameLocator("#child").locator("#text").evaluate(async el => {
      const started = performance.now();
      while (getComputedStyle(el).textAutospace !== "no-autospace" && performance.now() - started < 3000) await new Promise(resolve => setTimeout(resolve, 10));
    });
    assert.equal(await page.frameLocator("#child").locator("#text").evaluate(el => getComputedStyle(el).textAutospace), "no-autospace");
    await worker.evaluate(() => chrome.storage.local.set({ settings: { enabled: false, siteRules: [] } }));
    await page.waitForFunction(() => getComputedStyle(document.getElementById("text")).textAutospace === "no-autospace");
    const disabledWidth = await page.locator("#text").evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); return range.getBoundingClientRect().width; });
    await worker.evaluate(() => chrome.storage.local.set({ settings: { enabled: true, siteRules: [] } }));
    await page.waitForFunction(() => getComputedStyle(document.getElementById("text")).textAutospace === "normal");
    const enabledWidth = await page.locator("#text").evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); return range.getBoundingClientRect().width; });
    assert.ok(enabledWidth > disabledWidth, "自动间距应改变混排文字的实际宽度");
    // 密集控件与文字变化不产生扩展样式节点或字体标记。
    await page.locator("#search").fill("中文Search123");
    await page.evaluate(() => { for (let i = 0; i < 200; i++) { document.getElementById("dynamic").className = "hover-" + i; document.getElementById("new-text").textContent = "中文Dynamic" + i; } });
    assert.equal(await page.locator("style").count(), 1);
    assert.equal(await page.locator("[data-sfs-replaced]").count(), 0);
    const extensionURL = worker.url().replace(/background\.js$/, "options.html");
    const options = await context.newPage();
    await options.goto(extensionURL);
    await options.getByRole("button", { name: "添加网站" }).click();
    await options.locator(".domain").fill("127.0.0.1");
    await options.getByText("关闭", { exact: true }).click();
    await options.getByRole("button", { name: "保存设置" }).click();
    await page.waitForFunction(() => getComputedStyle(document.getElementById("text")).textAutospace === "no-autospace");
    assert.equal(errors.length, 0);
    t.diagnostic(JSON.stringify({ disabledWidth, enabledWidth, text: await page.locator("#text").textContent() }));
  } finally { await context.close(); }
});
