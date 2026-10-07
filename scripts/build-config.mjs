// 把根目录 config.json 的可视化配置写进 index.html。
// 另外从 caption.config.json 取「安全线」（stage.leftPadding / rightPadding）——
// 那是字幕和标题/页脚共用的同一组数字，只能有一个来源，否则改一处就会错位。
//
// 为什么是构建期而不是运行时：合成运行时不读外部文件（determinism 规则禁止网络读取），
// 配置只能在构建时落到 index.html 里 —— 和 caption.config.json → captions.html 是同一套思路。
//
// 写入位置：index.html 里两个 <!-- __HF_CONFIG_*__ --> 标记之间的 <style> 块，整块重写，幂等。
// 改完运行：npm run build-config（或 npm run build —— 配置 + 字幕一起重建）
import fs from "fs";
import path from "path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const CFG = path.join(ROOT, "config.json");
const CAPTION_CFG = path.join(ROOT, "caption.config.json");
const IDX = path.join(ROOT, "index.html");

const START = "<!-- __HF_CONFIG_START__ -->";
const END = "<!-- __HF_CONFIG_END__ -->";

const fail = (msg) => {
  console.error(`\n✗ config.json：${msg}\n`);
  process.exit(1);
};
const failCap = (msg) => {
  console.error(`\n✗ caption.config.json：${msg}\n`);
  process.exit(1);
};

/* ---------- 读并校验 ---------- */
if (!fs.existsSync(CFG)) fail("找不到 " + path.relative(ROOT, CFG));
let cfg;
try {
  cfg = JSON.parse(fs.readFileSync(CFG, "utf8"));
} catch (e) {
  fail("不是合法 JSON —— " + e.message);
}
if (cfg === null || typeof cfg !== "object" || Array.isArray(cfg))
  fail("顶层应该是一个对象");

// 背景标题文字
if ("ghostText" in cfg && !("title" in cfg))
  fail("字段 ghostText 已改名为 title，请把 config.json 里的 ghostText 换成 title");
if (typeof cfg.title !== "string")
  fail(`title 应为字符串，当前是 ${JSON.stringify(cfg.title)}`);

// 背景图两档铺法的几何。
// width 档的 720 = 1080 ÷ 原图宽高比（bg1.webp 960×640 → 1.5）：
// 换背景图且新图比例不同的话，改这一档的 height（width 档高度 = 1080 ÷ 新图宽高比）。
const PRESET = {
  width: { h: "720px", top: "482px" }, // 按原图宽度铺满；底边 1202 = 字幕区顶边
  height: { h: "1152px", top: "0px" }, // 按高度铺满（1920 × 0.6）；顶端顶到画面顶部
};
if (!Object.prototype.hasOwnProperty.call(PRESET, cfg.heroFit))
  fail(
    `heroFit 只能是 ${Object.keys(PRESET)
      .map((k) => JSON.stringify(k))
      .join(" 或 ")}，当前是 ${JSON.stringify(cfg.heroFit)}`,
  );
const p = PRESET[cfg.heroFit];

/* ---------- 安全线：唯一来源是 caption.config.json ----------
   字幕的 #cap-stage 由 build-audio.mjs 用这两个值生成；标题 / 页脚的 --gutter 由这里生成。
   以前是两处手写、靠人工保持一致，改一处就错位，现在都从这里取。
   取值范围与 build-audio.mjs 一致（0 ~ 画幅一半）。 */
if (!fs.existsSync(CAPTION_CFG))
  failCap("找不到 " + path.relative(ROOT, CAPTION_CFG) + "（--gutter 需要它的 stage.leftPadding / rightPadding）");
let capCfg;
try {
  capCfg = JSON.parse(fs.readFileSync(CAPTION_CFG, "utf8"));
} catch (e) {
  failCap("不是合法 JSON —— " + e.message);
}
const stage = (capCfg && capCfg.stage) || {};
const side = (v, key) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 540)
    failCap(`stage.${key} 应为 0~540 的数字，当前是 ${JSON.stringify(v)}`);
  return v;
};
const gutterL = side(stage.leftPadding, "leftPadding");
const gutterR = side(stage.rightPadding, "rightPadding");

/* ---------- 生成样式块 ---------- */
// 用 JSON.stringify 得到带引号的 CSS 字符串字面量；文字为空时就是 ""，::before 不产出内容
const text = JSON.stringify(cfg.title);
const block = `${START}
  <style>
    /* 自动生成：来自根目录 config.json + caption.config.json，请勿手改。改配置后运行 npm run build-config */
    :root {
      /* 安全线：与字幕共用同一组数字，来源 caption.config.json 的 stage.leftPadding / rightPadding。
         标题、页脚用它；照片是全幅通栏，不受影响 */
      --gutter: ${gutterL}px;
      --gutter-right: ${gutterR}px;
      --title: ${text};
      --hero-fit: cover;
      /* width 档的框比例恰好等于原图比例 → cover 等于整幅不裁切；
         height 档的框更瘦 → cover 自动变成「按高度铺 + 左右裁掉」 */
      --hero-h: ${p.h};
      --hero-top: ${p.top};
    }
  </style>
  ${END}`;

/* ---------- 写回 index.html ---------- */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const re = new RegExp(esc(START) + "[\\s\\S]*?" + esc(END));

let html = fs.readFileSync(IDX, "utf8");
if (re.test(html)) {
  html = html.replace(re, block);
} else {
  if (!html.includes("</head>")) fail("index.html 里找不到 </head>，无法插入配置块");
  html = html.replace("</head>", `\n  ${block}\n</head>`);
}
fs.writeFileSync(IDX, html, "utf8");

/* ---------- 报告 ---------- */
console.log("\n──── 配置已写入 index.html ────");
console.log(`  title     = ${JSON.stringify(cfg.title)}${cfg.title ? "" : "（空 → 不显示标题）"}`);
console.log(`  heroFit   = ${cfg.heroFit}   →  照片区高 ${p.h} / 顶边 ${p.top}`);
console.log(
  `  安全线    = 左 ${gutterL}px / 右 ${gutterR}px  ←  caption.config.json 的 stage.leftPadding / rightPadding（与字幕同源）`,
);
console.log("  写入位置  = " + path.relative(ROOT, IDX) + " 的 __HF_CONFIG 标记块");
