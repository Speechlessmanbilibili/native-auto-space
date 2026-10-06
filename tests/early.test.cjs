const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
let context, worker, server, otherServer, port, otherPort;
const errors = [];
const fixture = '<!doctype html><meta charset="utf-8"><style>*{text-autospace:no-autospace}body{font:24px Arial}</style><p id=t>中文English数字2026</p><script>window.earlySpacing=getComputedStyle(t).textAutospace;requestAnimationFrame(()=>window.firstFrameSpacing=getComputedStyle(t).textAutospace);</script>';
function serve() { return http.createServer((_, response) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(fixture); }); }
before(async () => {
  server = serve(); otherServer = serve();
  await Promise.all([new Promise(r => server.listen(0, "127.0.0.1", r)), new Promise(r => otherServer.listen(0, "127.0.0.1", r))]);
  port = server.address().port; otherPort = otherServer.address().port;
  context = await chromium.launchPersistentContext("", { executablePath: chromium.executablePath(), headless: true,
    args: ["--disable-extensions-except=" + root, "--load-extension=" + root, "--no-proxy-server", "--host-resolver-rules=MAP example.com 127.0.0.1, MAP *.example.com 127.0.0.1, MAP *.example.net 127.0.0.1"] });
  worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker");
  worker.on("console", x => { if (x.type() === "error") errors.push(x.text()); });
});
after(async () => { await context?.close(); await Promise.all([server && new Promise(r => server.close(r)), otherServer && new Promise(r => otherServer.close(r))]); });
async function settings(value) {
  await worker.evaluate(async value => {
    await chrome.storage.local.set({ settings: value });
    await new Promise(resolve => setTimeout(resolve, 30));
    await syncRegistration();
  }, value);
}
async function opened(host, targetPort = port) {
  const page = await context.newPage();
  await page.goto(`http://${host}:${targetPort}/early`);
  return page;
}
test("提前注册的间距在第一段网站脚本及首帧生效，不等待 USER 补充", async () => {
  await settings({ enabled: true, siteRules: [] });
  await worker.evaluate(() => {
    globalThis.savedInsertCSS = chrome.scripting.insertCSS;
    globalThis.injected = 0;
    chrome.scripting.insertCSS = options => new Promise((resolve, reject) => setTimeout(() => {
      savedInsertCSS(options).then(value => { injected++; resolve(value); }, reject);
    }, 700));
  });
  try {
    const page = await opened("example.com");
    assert.equal(await page.evaluate(() => earlySpacing), "normal");
    await page.waitForFunction(() => window.firstFrameSpacing);
    assert.equal(await page.evaluate(() => firstFrameSpacing), "normal");
    assert.equal(await worker.evaluate(() => injected), 0);
    assert.equal(await page.locator("#t").textContent(), "中文English数字2026");
    await page.close();
  } finally { await worker.evaluate(() => { chrome.scripting.insertCSS = savedInsertCSS; }); }
});
test("首次绘制按全局、子域名、显式端口、继承和同等规则顺序决定间距", async () => {
  await settings({ enabled: true, siteRules: [
    { domain: "example.com", mode: "off" }, { domain: "docs.example.com", mode: "on" },
    { domain: "docs.example.com:" + port, mode: "off" }, { domain: "docs.example.com:" + port, mode: "on" },
    { domain: "child.docs.example.com", mode: "inherit" }
  ] });
  for (const [host, targetPort, expected] of [["example.com", port, "no-autospace"], ["docs.example.com", port, "no-autospace"],
    ["docs.example.com", otherPort, "normal"], ["child.docs.example.com", port, "normal"], ["outer.example.net", port, "normal"]]) {
    const page = await opened(host, targetPort);
    assert.equal(await page.evaluate(() => earlySpacing), expected, host + ":" + targetPort);
    await page.close();
  }
  await settings({ enabled: false, siteRules: [{ domain: "example.com", mode: "on" }, { domain: "docs.example.com", mode: "inherit" }] });
  for (const [host, expected] of [["example.com", "normal"], ["docs.example.com", "no-autospace"], ["outer.example.net", "no-autospace"]]) {
    const page = await opened(host); assert.equal(await page.evaluate(() => earlySpacing), expected, host); await page.close();
  }
});
test("撤销提前注册后，已打开页面的反复关闭恢复作者间距，快速保存沿用最终配置", async () => {
  await settings({ enabled: true, siteRules: [] });
  const page = await opened("example.com");
  for (const enabled of [false, true, false, true]) {
    await settings({ enabled, siteRules: [] });
    await page.waitForFunction(expected => getComputedStyle(t).textAutospace === expected, enabled ? "normal" : "no-autospace");
  }
  await worker.evaluate(async () => {
    for (const enabled of [false, true, false]) await chrome.storage.local.set({ settings: { enabled, siteRules: [] } });
    await syncRegistration();
  });
  await page.waitForFunction(() => getComputedStyle(t).textAutospace === "no-autospace");
  assert.equal((await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts())).length, 0);
  await page.close();
});
test("空白子框架按创建者来源提前注入，关闭后恢复原间距，IPv6 规则可以注册", async () => {
  await settings({ enabled: false, siteRules: [{ domain: "example.com", mode: "on" }, { domain: "[::1]:" + port, mode: "on" }] });
  const page = await opened("example.com");
  await page.evaluate(text => { const frame = document.createElement("iframe"); frame.id = "child"; frame.srcdoc = text; document.body.append(frame); }, fixture);
  const child = page.frameLocator("#child");
  await child.locator("#t").waitFor();
  assert.equal(await child.locator("#t").evaluate(() => earlySpacing), "normal");
  await settings({ enabled: false, siteRules: [] });
  await child.locator("#t").evaluate(async node => {
    while (getComputedStyle(node).textAutospace !== "no-autospace") await new Promise(resolve => requestAnimationFrame(resolve));
  });
  assert.equal(await child.locator("#t").evaluate(node => getComputedStyle(node).textAutospace), "no-autospace");
  await page.close();
});
test("后台停止后重新开页，持久注册仍在网站脚本之前生效", async () => {
  await settings({ enabled: true, siteRules: [] });
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  await session.send("ServiceWorker.enable"); await session.send("ServiceWorker.stopAllWorkers");
  await page.goto(`http://example.com:${port}/cold`);
  assert.equal(await page.evaluate(() => earlySpacing), "normal");
  await session.detach(); await page.close();
});
test("提前注册和首屏注入没有后台错误", () => { assert.deepEqual(errors, []); });
