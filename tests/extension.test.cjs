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
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".svg") ? "image/svg+xml" : "text/html; charset=utf-8");
    if (["options.html", "popup.html", "shared.js", "ui.js", "ui.css", "kit/kit.css", "icons/source.svg", "icons/mark.svg"].includes(name)) response.end(fs.readFileSync(path.join(root, name)));
    else response.end(fixture);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  origin = "http://127.0.0.1:" + server.address().port;
  browser = await chromium.launch({ headless: true, executablePath });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

async function uiPage(name, stored = {}, currentURL = "https://docs.example.com/page") {
  const page = await browser.newPage();
  await page.addInitScript(({ stored, currentURL }) => {
    window.__stored = stored;
    window.chrome = {
      storage: { local: { get: async () => ({ settings: __stored }), set: async value => { __stored = value.settings; } } },
      tabs: { query: async () => [{ url: currentURL }] },
      runtime: { sendMessage: async () => ({ ok: true }), openOptionsPage: () => { window.__opened = true; } }
    };
  }, { stored, currentURL });
  await page.goto(origin + "/" + name);
  await page.waitForFunction(() => document.getElementById("enabled").checked === (window.__stored.enabled !== false));
  return page;
}

test("设置页添加、校验、保存、删除及全局开关正确，窄屏无溢出", async () => {
  const page = await uiPage("options.html");
  assert.equal(await page.locator("#live-preview").evaluate(el => getComputedStyle(el).textAutospace), "normal");
  assert.equal(await page.locator(".preview-without").first().evaluate(el => getComputedStyle(el).textAutospace), "no-autospace");
  assert.equal(await page.locator("#live-preview").textContent(), "中文与English、数字2026自然衔接。");
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
  for (const selector of ["#live-preview", "#live-preview-detail"]) {
    assert.equal(await page.locator(selector).evaluate(el => getComputedStyle(el).textAutospace), "no-autospace");
  }
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
  await page.waitForFunction(() => document.getElementById("effective").textContent.includes("匹配example.com"));
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

test("弹窗修改当前主机的显式默认端口规则，不被原规则覆盖", async () => {
  for (const [currentURL, domain] of [["https://docs.example.com/page", "docs.example.com:443"],
    ["http://docs.example.com/page", "docs.example.com:80"], ["http://docs.example.com:8443/page", "docs.example.com:8443"]]) {
    const page = await uiPage("popup.html", { enabled: false, siteRules: [{ domain, mode: "off" }] }, currentURL);
    try {
      await page.waitForFunction(() => document.getElementById("effective").textContent.includes("匹配"));
      await page.getByText("开启", { exact: true }).click();
      await page.waitForFunction(() => __stored.siteRules[0].mode === "on");
      assert.deepEqual(await page.evaluate(() => __stored), { enabled: false, siteRules: [{ domain, mode: "on" }] });
      assert.equal(await page.locator('[value="on"]').isChecked(), true);
      assert.match(await page.locator("#effective").textContent(), /^当前：开启/);
      await page.getByText("跟随全局", { exact: true }).click();
      await page.waitForFunction(() => __stored.siteRules[0].mode === "inherit");
      assert.equal(await page.locator('[value="inherit"]').isChecked(), true);
      assert.match(await page.locator("#effective").textContent(), /^当前：关闭/);
    } finally { await page.close(); }
  }
});

test("弹窗按最新配置保存所选字段，保留其他窗口更新的全局开关与网站规则", async () => {
  const page = await uiPage("popup.html", { enabled: true, siteRules: [] });
  try {
    await page.waitForFunction(() => document.getElementById("effective").textContent.includes("跟随全局"));
    await page.evaluate(() => { __stored.siteRules.push({ domain: "example.net", mode: "off" }); });
    await page.locator("#enabled").uncheck();
    await page.waitForFunction(() => __stored.enabled === false);
    assert.deepEqual(await page.evaluate(() => __stored.siteRules), [{ domain: "example.net", mode: "off" }]);
    await page.evaluate(() => { __stored.enabled = true; __stored.siteRules.push({ domain: "other.example.net", mode: "on" }); });
    await page.getByText("开启", { exact: true }).click();
    await page.waitForFunction(() => __stored.siteRules.length === 3);
    assert.deepEqual(await page.evaluate(() => __stored), { enabled: true, siteRules: [
      { domain: "example.net", mode: "off" }, { domain: "other.example.net", mode: "on" }, { domain: "docs.example.com", mode: "on" }
    ] });
  } finally { await page.close(); }
});

test("弹窗读取最新配置失败时保留原设置，恢复控件并允许重试", async () => {
  const page = await uiPage("popup.html", { enabled: true, siteRules: [] });
  try {
    await page.waitForFunction(() => document.getElementById("effective").textContent.includes("跟随全局"));
    await page.evaluate(() => { chrome.storage.local.get = async () => { throw new Error("模拟读取失败"); }; });
    await page.locator("#enabled").click();
    await page.waitForFunction(() => document.getElementById("status").textContent.includes("保存失败"));
    assert.equal(await page.locator("#enabled").isChecked(), true);
    assert.equal(await page.locator("#enabled").isEnabled(), true);
    assert.deepEqual(await page.evaluate(() => __stored), { enabled: true, siteRules: [] });
    await page.evaluate(() => { chrome.storage.local.get = async () => ({ settings: __stored }); });
    await page.locator("#enabled").uncheck();
    await page.waitForFunction(() => __stored.enabled === false);
  } finally { await page.close(); }
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

test("页面仅报告完成的 USER 样式状态，排队、失败及过时回复不会复用旧确认", async () => {
  const page = await browser.newPage();
  try {
    await page.goto(origin + "/content-harness");
    await page.evaluate(() => {
      window.__requests = [];
      window.chrome = {
        runtime: { sendMessage: message => new Promise((resolve, reject) => __requests.push({ message, resolve, reject })) },
        storage: { onChanged: { addListener(listener) { window.__change = listener; } } }
      };
      window.__settingsChanged = enabled => __change({ settings: { newValue: { enabled, siteRules: [] } } }, "local");
    });
    await page.addScriptTag({ path: path.join(root, "shared.js") });
    await page.addScriptTag({ path: path.join(root, "content.js") });
    assert.equal(await page.evaluate(() => __requests[0].message.userStyle), null);
    await page.evaluate(() => __requests[0].resolve({ enabled: true }));
    await page.evaluate(() => __settingsChanged(true));
    assert.equal(await page.evaluate(() => __requests[1].message.userStyle), true);
    await page.evaluate(() => __settingsChanged(false));
    assert.equal(await page.evaluate(() => __requests[2].message.userStyle), null);
    await page.evaluate(() => { __requests[1].resolve({ enabled: true }); __requests[2].reject(new Error("后台停止")); });
    await page.evaluate(() => __settingsChanged(true));
    assert.equal(await page.evaluate(() => __requests[3].message.userStyle), null);
    await page.evaluate(() => __requests[3].resolve({ enabled: false }));
    await page.evaluate(() => __settingsChanged(true));
    assert.equal(await page.evaluate(() => __requests[4].message.userStyle), false);
    await page.evaluate(() => __requests[4].resolve({ enabled: true }));
    await page.evaluate(() => __settingsChanged(true));
    assert.equal(await page.evaluate(() => __requests[5].message.userStyle), true);
  } finally { await page.close(); }
});

test("设置页保存局部草稿时合并其他窗口的新开关与规则", async () => {
  const page = await uiPage("options.html", { enabled: true, siteRules: [] });
  await page.evaluate(() => { __stored = { enabled: false, siteRules: [{ domain: "other.example.com", mode: "off" }] }; });
  await page.locator("#add-rule").click();
  await page.locator(".domain").fill("example.com");
  await page.locator("#save").click();
  await page.waitForFunction(() => document.getElementById("status").textContent.startsWith("已保存"));
  const stored = await page.evaluate(() => __stored);
  assert.equal(stored.enabled, false);
  assert.deepEqual(stored.siteRules.map(rule => rule.domain), ["example.com", "other.example.com"]);
  assert.equal(await page.locator("#enabled").isChecked(), false);
  await page.close();
});
