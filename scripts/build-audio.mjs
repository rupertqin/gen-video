// 一个脚本干两件事：
//   1) 由 assets/audio/ 的 srt 生成字幕组件 compositions/captions.html
//   2) 按 audio.wav 实际长度同步 index.html 与组件里的时长
//
// 字幕风格取自注册表组件 caption-editorial-emphasis（普通字 + 超大强调字，逐字原地淡入）
// 中文适配：Inter/Playfair → PingFang SC / Songti SC
//
// 数据来源只有 audio.srt（句子级）：字幕按"字"渲染，
// 每个字的时间由所属分句的 [start, end) 按字均分推算（见 scripts/lib/srt.mjs）。
// 所有可调项都在根目录的 caption.config.json：字号/间距/颜色/舞台/入场/强调词表/覆盖词表
//   - 关键词命中必须落在 jieba 词典的词边界上（"义"落在"意义"里不点亮），见 segment()
//   - 构建结束打印排版估算、覆盖率自检、跳过明细、强调字上下文审阅
//
// 合成运行时不读 srt —— 改了 srt 就重跑：npm run build-audio
import fs from "fs";
import path from "path";
import { cut, tag, add_word } from "jieba-wasm";
import { loadChars, countIn } from "./lib/srt.mjs";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const SENT_SRT = path.join(ROOT, "assets/audio/audio.srt");
const WAV = path.join(ROOT, "assets/audio/audio.wav");
const IDX = path.join(ROOT, "index.html");
const COMP_DIR = path.join(ROOT, "compositions");
const COMP = path.join(COMP_DIR, "captions.html");

const COMP_ID = "captions";
const SOURCE_COMPONENT = "caption-editorial-emphasis";
const TRACK = 5;
const CANVAS_W = 1080; // 画布尺寸由 index.html 的根合成决定，改这里不会改变画布
const CANVAS_H = 1920;

/* ---------- 读取并校验 caption.config.json ---------- */
const CFG_FILE = path.join(ROOT, "caption.config.json");
if (!fs.existsSync(CFG_FILE)) {
  console.error(`缺少配置文件：${path.relative(ROOT, CFG_FILE)}`);
  process.exit(1);
}
let CFG;
try {
  CFG = JSON.parse(fs.readFileSync(CFG_FILE, "utf8"));
} catch (e) {
  console.error(`${path.relative(ROOT, CFG_FILE)} 不是合法 JSON：${e.message}`);
  process.exit(1);
}
// 先校验再用：字段缺失或类型不对时给明确报错，避免 NaN 悄悄流进 CSS
const cfgNum = (v, key, min = 0, max = Infinity) => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max)
    throw new Error(
      `配置项 ${key} 应为 ${min}~${max} 的数字，当前是 ${JSON.stringify(v)}`,
    );
  return v;
};
const cfgStr = (v, key) => {
  if (typeof v !== "string" || !v.trim())
    throw new Error(`配置项 ${key} 应为非空字符串，当前是 ${JSON.stringify(v)}`);
  return v;
};

const F = CFG.font || {},
  C = CFG.color || {},
  S = CFG.stage || {},
  E = CFG.entrance || {};

const SCALE = cfgNum(CFG.scale, "scale", 0.1, 5);
const NORMAL_PX = Math.round(cfgNum(F.normalPx, "font.normalPx", 8) * SCALE);
const EMPHASIS_PX = Math.round(cfgNum(F.emphasisPx, "font.emphasisPx", 8) * SCALE);
const LINE_GAP_PX = Math.round(cfgNum(F.lineGapPx, "font.lineGapPx") * SCALE);
const WORD_GAP_PX = Math.round(cfgNum(F.wordGapPx, "font.wordGapPx") * SCALE);
const LINE_HEIGHT = cfgNum(F.lineHeight, "font.lineHeight", 0.8, 2);
const EMPHASIS_PAD_EM = cfgNum(F.emphasisPadEm, "font.emphasisPadEm", 0, 1);
const COLOR_TEXT = cfgStr(C.text, "color.text");
const COLOR_EMPHASIS = cfgStr(C.emphasis, "color.emphasis");
const COLOR_SHADOW = cfgStr(C.textShadow, "color.textShadow");
const COLOR_SCRIM = cfgStr(C.scrim, "color.scrim");
const STAGE_H = cfgNum(S.availableHeight, "stage.availableHeight", 100, CANVAS_H);
const STAGE_SIDE_PX = cfgNum(S.sidePadding, "stage.sidePadding", 0, CANVAS_W / 2);
const MARGIN_BOTTOM_PX = cfgNum(S.bottomMargin, "stage.bottomMargin", 0, CANVAS_H);
const SCRIM_H = cfgNum(S.scrimHeight, "stage.scrimHeight", 0, CANVAS_H);
const ENTRY = cfgNum(E.duration, "entrance.duration", 0.01, 2);
const ENTRY_FROM = cfgNum(E.fromScale, "entrance.fromScale", 1, 2);
const MAX_KW = cfgNum(CFG.maxKeywordsPerClause, "maxKeywordsPerClause", 1, 5);

// 强调词表（人工提供）
if (!Array.isArray(CFG.keywords) || CFG.keywords.some((k) => typeof k !== "string"))
  throw new Error("配置项 keywords 应为字符串数组");
const MANUAL_KEYWORDS = [
  ...new Set(CFG.keywords.map((k) => k.trim()).filter(Boolean)),
];
if (!MANUAL_KEYWORDS.length) throw new Error("配置项 keywords 不能为空");

// 把人工关键词注入 jieba 词典，让它们成为"被词典认识的词"：
//   - 修正 jieba 的合并错误：`实践|理性分析` → 注入"实践理性"后正确切成 `实践理性|分析`
//   - 也修正 `仁义|礼智信` → `仁义礼智信`
// 频次必须【很低】，只要"被认识"即可。给高会反过来拆散更强的词 ——
//   实测 add_word("什么值得", 1000) 把 `为什么值得` 拆成 `为|什么值得`，
//   于是"什么值得"在"为什么值得"里的假命中就漏过来了；freq=10 时 `为什么` 完好。
// 只注入多字关键词：单字本来就是词，注入无收益、只增加拆散复合词的风险。
for (const w of MANUAL_KEYWORDS) if (w.length >= 2) add_word(w, 10, "n");

// 自动抽取：用 jieba 词性过滤 + TextRank 从本文里补一批主题词
const AK = CFG.autoKeywords || {};
const AUTO = {
  enabled: AK.enabled !== false,
  topN: cfgNum(AK.topN ?? 20, "autoKeywords.topN", 0, 300),
  minLen: cfgNum(AK.minLen ?? 2, "autoKeywords.minLen", 1, 8),
  minFreq: cfgNum(AK.minFreq ?? 3, "autoKeywords.minFreq", 1, 100),
  maxFreq: cfgNum(AK.maxFreq ?? 10, "autoKeywords.maxFreq", 1, 999),
  window: cfgNum(AK.window ?? 4, "autoKeywords.window", 2, 10),
  pos: new Set(
    Array.isArray(AK.pos)
      ? AK.pos
      : ["n", "nr", "ns", "nt", "nz", "vn", "i", "l", "j"],
  ),
};

// 词表：人工覆盖，用于词典没收录、但确实不该点亮的复合词（默认空）。
if (!Array.isArray(CFG.excludeWords))
  throw new Error("配置项 excludeWords 应为字符串数组");
const EXCLUDE_WORDS = [
  ...new Set(CFG.excludeWords.map((w) => String(w).trim()).filter(Boolean)),
].sort((a, b) => b.length - a.length);

/** 命中 [a,b) 是否被词表里某个更长的词完全包住；返回那个词或 null */
const biggerWordAt = (s, a, b) => {
  for (const w of EXCLUDE_WORDS) {
    if (w.length <= b - a) continue; // 不比关键词长就不算"更大的词"
    let i = 0;
    while ((i = s.indexOf(w, i)) !== -1) {
      if (i <= a && i + w.length >= b) return w;
      i += w.length;
    }
  }
  return null;
};

/* ---------- 分词边界（jieba） ---------- */
// 关键词命中必须落在词典的词边界上：命中的字符区间要能由若干个完整的词拼出来。
//   "义" 落在 "意义" 里 → 意义 是词典词，边界对不上 → 跳过
//   "元命题" 被切成 元|命题 两个词 → 两个完整词拼成 → 仍然命中
// 用 cut(text, false)：纯词典模式，不启用 HMM 的未登录词合并。
// 开 HMM 会把 "合于义" 合成一个伪词，反而把该点亮的 "义" 挡掉。
const segment = (text) => {
  const segs = cut(text, false);
  // 分词结果必须能原样拼回，否则偏移对不上，此时放弃边界约束（只靠人工词表）
  if (segs.join("") !== text) return null;
  const bounds = new Set([0]);
  let acc = 0;
  for (const w of segs) {
    acc += w.length;
    bounds.add(acc);
  }
  return {
    segs,
    bounds,
    // 命中 [a,b) 覆盖到的那些词，用 | 连起来 —— 报告"边界为什么对不上"
    overlapping: (a, b) => {
      const out = [];
      let o = 0;
      for (const w of segs) {
        if (o < b && o + w.length > a) out.push(w);
        o += w.length;
      }
      return out.join("|");
    },
  };
};

/* ---------- helpers ---------- */
function wavDuration(file) {
  const b = fs.readFileSync(file);
  let off = 12,
    byteRate = 0,
    dataSize = 0;
  while (off + 8 <= b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "fmt ") byteRate = b.readUInt32LE(off + 16);
    else if (id === "data") dataSize = size;
    off += 8 + size + (size % 2);
  }
  return byteRate ? dataSize / byteRate : 0;
}

/* ---------- read ---------- */
for (const f of [SENT_SRT, WAV, IDX]) {
  if (!fs.existsSync(f)) {
    console.error("缺少文件：" + f);
    process.exit(1);
  }
}
const audioLen = wavDuration(WAV);
const dur = +audioLen.toFixed(3);

/* ---------- 字 / 分句（见 scripts/lib/srt.mjs） ---------- */
const { chars: units, groups, plain } = loadChars(SENT_SRT);

/* ---------- 自动抽取主题词：jieba 词性过滤 + TextRank ---------- */
// 三个要求分别由三件事解决：
//   有含义   → tag() 的词性过滤，滤掉 连词/副词/代词/助词/介词/数词 等虚词
//   高频     → 词频（minFreq 阈值）
//   主题相关 → TextRank 的图中心性：与其它重要词共现越密，排名越高
// TextRank 只需单篇文本，不需要外部语料，正好适合"从这篇文章里提词"。
function textrank(docs, { pos, minLen, win }) {
  const freq = new Map();
  const adj = new Map();
  const link = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Map());
    adj.get(a).set(b, (adj.get(a).get(b) || 0) + 1);
  };
  for (const text of docs) {
    const ws = tag(text, true)
      .filter((t) => pos.has(t.tag) && t.word.length >= minLen)
      .map((t) => t.word);
    for (let i = 0; i < ws.length; i++) {
      freq.set(ws[i], (freq.get(ws[i]) || 0) + 1);
      for (let j = i + 1; j < Math.min(ws.length, i + win); j++) {
        if (ws[i] === ws[j]) continue; // 自环不计
        link(ws[i], ws[j]);
        link(ws[j], ws[i]);
      }
    }
  }
  const outSum = new Map();
  for (const [w, m] of adj) {
    let s = 0;
    for (const v of m.values()) s += v;
    outSum.set(w, s);
  }
  const D = 0.85;
  let score = new Map([...adj.keys()].map((w) => [w, 1]));
  for (let it = 0; it < 40; it++) {
    const next = new Map();
    for (const [w, nbrs] of adj) {
      let s = 0;
      for (const [v, weight] of nbrs) {
        const os = outSum.get(v);
        if (os) s += (weight / os) * score.get(v);
      }
      next.set(w, 1 - D + D * s);
    }
    score = next;
  }
  return [...freq.entries()]
    .map(([w, f]) => ({ w, f, rank: score.get(w) || 0, len: w.length }))
    .sort((a, b) => b.rank - a.rank);
}

// 关键词已改为在对话式大模型里挑（见 keywords.prompt.md），这里只作为可选的
// 本地兜底：只有 enabled 时才计算并并入，避免每次构建都白跑一遍分词+词性标注。
const AUTO_RANKED = AUTO.enabled
  ? textrank(
      groups.map((g) => g.text),
      { pos: AUTO.pos, minLen: AUTO.minLen, win: AUTO.window },
    ).filter((x) => x.f >= AUTO.minFreq && x.f <= AUTO.maxFreq)
  : [];
const AUTO_KEYWORDS = (AUTO.enabled ? AUTO_RANKED : [])
  // 被人工长词包住的候选永远不会点亮（如"命题"⊂"元命题"），直接剔除
  .filter((x) => !MANUAL_KEYWORDS.some((m) => m.includes(x.w)))
  .slice(0, AUTO.topN)
  .map((x) => x.w);

/* ---------- 合并：人工词表 + 自动抽取 ---------- */
const KW_ORIGIN = new Map();
for (const k of MANUAL_KEYWORDS) KW_ORIGIN.set(k, "人工");
for (const k of AUTO_KEYWORDS) if (!KW_ORIGIN.has(k)) KW_ORIGIN.set(k, "自动");
const KEYWORDS = [...KW_ORIGIN.keys()].sort((a, b) => b.length - a.length);

/* ---------- 标记强调词（每个分句最多 MAX_KW 个） ---------- */
const kwHits = new Map(KEYWORDS.map((k) => [k, 0]));
const kwAt = new Map(KEYWORDS.map((k) => [k, []]));
const cappedGroups = [];
const skippedAll = []; // 因落在更长的词内而被跳过
let termSeq = 0;

groups.forEach((g, gi) => {
  const slice = units.slice(g.ws, g.we + 1);
  const concat = slice.map((w) => w.text).join("");
  const offs = [];
  let acc = 0;
  for (const w of slice) {
    offs.push([acc, acc + w.text.length]);
    acc += w.text.length;
  }

  // 1) 收集本分句内的全部命中（同一段字符不重复计）
  //    渲染单位就是"字"，所以字符级命中天然等于单位级命中。
  //    但命中必须落在词典的词边界上，否则视为"落在更大的词里"而跳过。
  const seg = segment(g.text);
  const found = [],
    taken = [];
  for (const kw of KEYWORDS) {
    let i = 0;
    while ((i = concat.indexOf(kw, i)) !== -1) {
      const a = i,
        b = i + kw.length;
      const at = +g.start.toFixed(1);
      const override = biggerWordAt(concat, a, b);
      if (override) skippedAll.push({ kw, big: override, src: "词表", at });
      else if (seg && !(seg.bounds.has(a) && seg.bounds.has(b)))
        skippedAll.push({ kw, big: seg.overlapping(a, b), src: "词典", at });
      else if (!taken.some(([x, y]) => a < y && b > x)) {
        found.push({ kw, a, b });
        taken.push([a, b]);
      }
      i += kw.length;
    }
  }

  // 2) 超出上限的丢弃：长词优先（术语更具体），同长则靠前的优先
  found.sort((p, q) => q.kw.length - p.kw.length || p.a - q.a);
  const keep = found.slice(0, MAX_KW);
  const drop = found.slice(MAX_KW);
  if (drop.length)
    cappedGroups.push({
      gi,
      at: +g.start.toFixed(1),
      text: g.text,
      dropped: drop.map((d) => d.kw),
    });

  // 3) 标记保留的命中（多字关键词覆盖到的字共用一个 term id，渲染时合并成一个整体）
  for (const h of keep) {
    kwHits.set(h.kw, kwHits.get(h.kw) + 1);
    kwAt.get(h.kw).push(+g.start.toFixed(1));
    const tid = ++termSeq;
    for (let k = 0; k < slice.length; k++) {
      if (offs[k][0] < h.b && offs[k][1] > h.a) {
        units[g.ws + k].kw = 1;
        units[g.ws + k].term = tid;
      }
    }
  }
});

/* ---------- 排块：每句一个 block，拆成 1~2 行 ---------- */
// 行内条目 = [首字下标, 类型, 合并的字数]
// 多字关键词覆盖的字若各自渲染，屏幕上会出现多个互相独立的大字，
// 所以共用一个 term id 的那些字合并成一个整体渲染。
const STAGE_W = CANVAS_W - STAGE_SIDE_PX * 2; // 可用宽度
const toLine = (list) => {
  const out = [];
  for (let k = 0; k < list.length; k++) {
    const i = list[k];
    const t = units[i].term;
    if (t == null) {
      out.push([i, units[i].kw ? "e" : "n"]);
      continue;
    }
    let len = 1;
    while (k + len < list.length && units[list[k + len]].term === t) len++;
    out.push([i, "e", len]);
    k += len - 1;
  }
  return out;
};

const blocks = groups.map((g) => {
  const idx = [];
  for (let i = g.ws; i <= g.we; i++) idx.push(i);
  const firstEm = idx.findIndex((i) => units[i].kw);
  let l1, l2;
  if (firstEm > 0) {
    l1 = idx.slice(0, firstEm);
    l2 = idx.slice(firstEm);
  } else if (idx.length > 1) {
    const mid = Math.ceil(idx.length / 2);
    l1 = idx.slice(0, mid);
    l2 = idx.slice(mid);
  } else {
    l1 = idx;
    l2 = null;
  }
  return {
    start: +g.start.toFixed(3),
    end: +g.end.toFixed(3),
    l1: toLine(l1),
    l2: l2 ? toLine(l2) : null,
  };
});

const emCount = units.filter((w) => w.kw).length;
const emLineCount = blocks.filter(
  (b) => b.l2 && b.l2.some((p) => p[1] === "e"),
).length;
const emGroups = blocks.filter(
  (b) =>
    b.l1.some((p) => p[1] === "e") || (b.l2 || []).some((p) => p[1] === "e"),
).length;

const W_JSON = JSON.stringify(
  units.map((w) => ({
    t: w.text,
    s: +w.start.toFixed(3),
    e: +w.end.toFixed(3),
  })),
);
const B_JSON = JSON.stringify(blocks);

/* ---------- 生成字幕组件 ---------- */
const comp = `<!doctype html>
<html lang="zh-CN">
<head>
  <!-- ⚠️ 自动生成：scripts/build-audio.mjs —— 请勿手改；改了 srt 后运行 npm run build-audio -->
  <meta charset="UTF-8">
  <meta name="viewport" content="width=${CANVAS_W}, height=${CANVAS_H}">
  <title>Captions · editorial emphasis</title>
</head>
<body>
  <template>
    <style>
      @font-face { font-family: "PingFang SC"; src: local("PingFang SC"), local("PingFangSC-Regular"), local("Hiragino Sans GB"); }
      @font-face { font-family: "Songti SC"; src: local("Songti SC"), local("STSong"), local("Songti"); }
      * { margin: 0; padding: 0; box-sizing: border-box; }
      #root { position: absolute; inset: 0; z-index: 10; pointer-events: none; }
      .bs-scrim {
        position: absolute; left: 0; right: 0; bottom: 0; height: ${SCRIM_H}px;
        background: ${COLOR_SCRIM};
      }
      #cap-stage { position: absolute; left: ${STAGE_SIDE_PX}px; right: ${STAGE_SIDE_PX}px; bottom: ${MARGIN_BOTTOM_PX}px; height: ${STAGE_H}px; }
      .cap-block {
        position: absolute; left: 0; bottom: 0; width: 100%;
        opacity: 0; will-change: transform, opacity;
      }
      .cap-line { display: flex; flex-wrap: wrap; align-items: baseline; gap: ${LINE_GAP_PX}px ${WORD_GAP_PX}px; line-height: ${LINE_HEIGHT}; }
      .cap-line + .cap-line { margin-top: ${LINE_GAP_PX}px; }
      .w {
        display: inline-block; color: ${COLOR_TEXT}; white-space: nowrap;
        text-shadow: ${COLOR_SHADOW};
      }
      .w--n { font-family: "PingFang SC", sans-serif; font-weight: 700; font-size: ${NORMAL_PX}px; }
      .w--e { font-family: "Songti SC", serif; font-weight: 700; font-size: ${EMPHASIS_PX}px; line-height: 1; color: ${COLOR_EMPHASIS}; padding: 0 ${EMPHASIS_PAD_EM}em; }
      /* 逐词入场：由完全看不见 → 看见（无位移） */
      .w--anim { opacity: 0; transform: scale(${ENTRY_FROM}); transform-origin: 0% 100%; }
    </style>

    <div id="root" data-composition-id="${COMP_ID}" data-width="${CANVAS_W}" data-height="${CANVAS_H}" data-start="0" data-duration="${dur}">
      <div class="bs-scrim"></div>
      <div id="cap-stage"></div>
    </div>

    <script>
      (function () {
        var W = ${W_JSON};
        var BLOCKS = ${B_JSON};
        var ENTRY = ${ENTRY};

        var stage = document.getElementById("cap-stage");
        BLOCKS.forEach(function (b, bi) {
          var el = document.createElement("div");
          el.className = "cap-block";
          el.id = "cb" + bi;
          [["l1", b.l1], ["l2", b.l2]].forEach(function (pair) {
            if (!pair[1]) return;
            var line = document.createElement("div");
            line.className = "cap-line";
            line.id = "cb" + bi + pair[0];
            pair[1].forEach(function (p, k) {
              var sp = document.createElement("span");
              sp.className = "w w--" + p[1] + " w--anim";
              sp.id = "cb" + bi + pair[0] + "w" + k;
              // p[2] = 合并的 token 数：一个术语整体一个 span，内部不再有字距
              var len = p[2] || 1, s = "";
              for (var q = 0; q < len; q++) s += W[p[0] + q].t;
              sp.textContent = s;
              line.appendChild(sp);
            });
            el.appendChild(line);
          });
          stage.appendChild(el);
        });

        window.__timelines = window.__timelines || {};
        var tl = gsap.timeline({ paused: true });

        BLOCKS.forEach(function (b, bi) {
          var el = document.getElementById("cb" + bi);
          tl.set(el, { opacity: 1 }, b.start);

          // 两行统一处理：每个词原地"隐藏 → 显示"（opacity + 轻微 scale），不做任何位移
          [["l1", b.l1], ["l2", b.l2]].forEach(function (pair) {
            if (!pair[1]) return;
            pair[1].forEach(function (p, k) {
              tl.to("#cb" + bi + pair[0] + "w" + k, { opacity: 1, scale: 1, duration: ENTRY, ease: "power2.out" }, W[p[0]].s);
            });
          });

          tl.set(el, { opacity: 0 }, b.end);
        });

        window.__timelines["${COMP_ID}"] = tl;
      })();
    </script>
  </template>
</body>
</html>
`;
if (!fs.existsSync(COMP_DIR)) fs.mkdirSync(COMP_DIR, { recursive: true });
fs.writeFileSync(COMP, comp, "utf8");

/* ---------- index.html：维护挂载槽 + 同步时长 ---------- */
let html = fs.readFileSync(IDX, "utf8");
// 挂载槽整块重写（而不是只改 data-duration）：这样以后新增/调整属性也能补到已存在的槽上
const hostRe =
  /[ \t]*<div[^>]*class="clip caption-host"[^>]*data-composition-id="captions"[^>]*><\/div>/;
const buildSlot = (keep) =>
  "    <div" +
  (keep ? " " + keep : "") +
  ` id="${COMP_ID}" class="clip caption-host" data-composition-id="${COMP_ID}"` +
  ` data-composition-src="compositions/captions.html" data-start="0" data-duration="${dur}" data-track-index="${TRACK}"` +
  ` data-track-kind="captions" data-width="${CANVAS_W}" data-height="${CANVAS_H}" data-layout-ignore></div>`;

if (hostRe.test(html)) {
  const hf = (html.match(hostRe)[0].match(/data-hf-id="[^"]*"/) || [])[0]; // 保留 Studio 的稳定 id
  html = html.replace(hostRe, buildSlot(hf));
} else {
  const anchor = html.match(/[ \t]*<audio[^>]*id="voice"[^>]*><\/audio>\n/);
  if (!anchor)
    throw new Error(
      'index.html 中找不到 <audio id="voice">，无法插入字幕挂载槽',
    );
  html = html.replace(anchor[0], anchor[0] + "\n" + buildSlot("") + "\n");
}
html = html.replace(
  /(data-composition-id="main"[^>]*data-duration=")[0-9.]+(")/,
  `$1${Math.ceil(audioLen)}$2`,
);
html = html.replace(/(id="voice"[^>]*data-duration=")[0-9.]+(")/, `$1${dur}$2`);
fs.writeFileSync(IDX, html, "utf8");

/* ---------- 覆盖率自检 ---------- */
const dead = KEYWORDS.filter((k) => kwHits.get(k) === 0);
const wpad = (s) => {
  let n = 0;
  for (const ch of s) n += /[\u4e00-\u9fff]/.test(ch) ? 2 : 1;
  return n;
};
const col = (s, n) => s + " ".repeat(Math.max(0, n - wpad(s)));

console.log("\n──── 覆盖率自检 ────");
console.log(
  `分句 ${groups.length}   含强调的分句 ${emGroups}（${((emGroups / groups.length) * 100).toFixed(0)}%）   点亮字 ${emCount} / ${units.length}`,
);
console.log(
  `关键词 ${KEYWORDS.length} 个（人工 ${MANUAL_KEYWORDS.length} + 自动 ${AUTO_KEYWORDS.length}）：命中 ${KEYWORDS.length - dead.length}，死条目 ${dead.length}   每分句上限 ${MAX_KW} 个`,
);
console.log(
  `\n${col("关键词", 20)}${col("来源", 6)}${col("全文", 6)}${col("点亮", 6)}${col("覆盖", 8)}出现位置(秒)`,
);
console.log("-".repeat(78));
for (const k of [...KEYWORDS].sort(
  (a, b) => kwHits.get(b) - kwHits.get(a) || b.length - a.length,
)) {
  const tot = countIn(plain, k),
    hit = kwHits.get(k),
    at = kwAt.get(k);
  const rate = tot ? ((hit / tot) * 100).toFixed(0) + "%" : "—";
  const show = !hit
    ? "未点亮"
    : at.length > 5
      ? at.slice(0, 5).join(", ") + ` …+${at.length - 5}`
      : at.join(", ");
  console.log(
    `${col(k, 20)}${col(KW_ORIGIN.get(k) || "?", 6)}${col(String(tot), 6)}${col(String(hit), 6)}${col(rate, 8)}${show}`,
  );
}

// 本地抽取的候选：仅在 autoKeywords.enabled 时计算并打印
if (AUTO.enabled && AUTO_RANKED.length) {
  console.log(
    `\n自动抽取候选（词性 ${[...AUTO.pos].join("/")}  窗口 ${AUTO.window}  minFreq ${AUTO.minFreq}  minLen ${AUTO.minLen}）：`,
  );
  const top = Math.max(AUTO.topN, 15);
  console.log(
    `  ${col("词", 16)}${col("频次", 6)}${col("排名分", 10)}启用`,
  );
  for (const x of AUTO_RANKED.slice(0, top)) {
    const on = KW_ORIGIN.get(x.w) === "自动";
    const dup = MANUAL_KEYWORDS.includes(x.w) ? "（已在人工表）" : "";
    console.log(
      `  ${col(x.w, 16)}${col(String(x.f), 6)}${col(x.rank.toFixed(3), 10)}${on ? "✔" : ""}${dup}`,
    );
  }
  console.log(
    `  共 ${AUTO_RANKED.length} 个候选，本次启用前 ${AUTO_KEYWORDS.length} 个` +
      (AUTO.enabled
        ? ""
        : "（autoKeywords.enabled=false：仅作候选菜单，未并入强调词）"),
  );
}
if (dead.length)
  console.warn(
    `\n⚠ 死条目（0 命中，建议从脚本里的 KEYWORDS 删掉）：${dead.join(" · ")}`,
  );
else console.log("\n✔ 无死条目");
if (cappedGroups.length) {
  console.log(
    `\n受"每分句 ≤${MAX_KW} 个"限制被截掉的分句 ${cappedGroups.length} 处：`,
  );
  for (const c of cappedGroups)
    console.log(
      `  ${String(c.at).padStart(6)}s  ${c.text}   ←舍弃 ${c.dropped.join("/")}`,
    );
} else console.log(`\n✔ 无关分句触及 ≤${MAX_KW} 上限`);

// 被跳过的命中 —— 让"规则实际生效了什么"可见
if (skippedAll.length) {
  const agg = new Map();
  for (const s of skippedAll) {
    const k = [s.big ?? "?", s.kw, s.src].join("\t");
    agg.set(k, (agg.get(k) || 0) + 1);
  }
  const nBy = skippedAll.reduce(
    (a, s) => ((a[s.src] = (a[s.src] || 0) + 1), a),
    {},
  );
  console.log(
    `\n跳过"落在更长词内"的命中：${skippedAll.length} 处，${agg.size} 种   （词典 ${nBy["词典"] || 0} / 词表 ${nBy["词表"] || 0}）`,
  );
  for (const [k, n] of [...agg.entries()].sort((a, b) => b[1] - a[1])) {
    const [big, kw, src] = k.split("\t");
    // 词典：分词结果没能拼出该关键词；词表：关键词被某个更长的词包住
    console.log(
      `  ${col(String(n), 5)}${col(big, 20)}${src === "词典" ? "⊅" : "⊃"} ${kw}   [${src}]`,
    );
  }
} else console.log('\n✔ 没有被跳过的命中');

// 多字关键词覆盖的字会合并成一个整体渲染，所以"关键词个数"与"屏幕上的大字块数"不是一回事。
const spanTxt = (p) => {
  let s = "";
  for (let q = 0; q < (p[2] || 1); q++) s += units[p[0] + q].text;
  return s;
};
const lineE = (l) => (l || []).filter((p) => p[1] === "e").length;
const perLine = blocks.map((b) => Math.max(lineE(b.l1), lineE(b.l2)));
const dist = perLine.reduce((a, n) => ((a[n] = (a[n] || 0) + 1), a), {});
const merged = blocks
  .flatMap((b) => [...b.l1, ...(b.l2 || [])])
  .filter((p) => (p[2] || 1) > 1);
const heavy = blocks.filter((b) => Math.max(lineE(b.l1), lineE(b.l2)) > MAX_KW);
const txt = (b) =>
  [...b.l1, ...(b.l2 || [])]
    .map((p) =>
      p[1] === "e"
        ? "【" + spanTxt(p).replace(/[\s\p{P}\p{S}]+$/u, "") + "】"
        : spanTxt(p),
    )
    .join("");
console.log(
  `\n渲染层面：单行超大字块数上限 ${Math.max(...perLine)}   分布（大字块数→行数）${JSON.stringify(dist)}`,
);
console.log(
  `  合并渲染的强调字块 ${merged.length} 个（最多合并 ${merged.length ? Math.max(...merged.map((p) => p[2])) : 0} 个字为一个整体）`,
);

// 强调字上下文审阅 —— 选关键词时最需要看的就是这张表。
// 渲染单位是"字"，所以"被点亮的字周围是什么"直接决定强调是否恰当：
// 关键词"义"在"合于义"里该亮，在"意义"里不该亮 —— 字符位置分不开，只能人来判断。
const plainChars = groups.map((g) =>
  units.slice(g.ws, g.we + 1).map((u) => u.text.replace(/[\s\p{P}\p{S}]+$/u, "")),
);
const litCtx = new Map();
let litTotal = 0;
for (const b of blocks) {
  for (const p of [...b.l1, ...(b.l2 || [])]) {
    if (p[1] !== "e") continue;
    litTotal++;
    const gi = units[p[0]].group;
    const cs = plainChars[gi];
    const off = p[0] - groups[gi].ws;
    const len = p[2] || 1;
    const kw = cs.slice(off, off + len).join("");
    const ctx =
      cs.slice(Math.max(0, off - 2), off).join("") +
      "【" + kw + "】" +
      cs.slice(off + len, off + len + 2).join("");
    if (!litCtx.has(kw)) litCtx.set(kw, new Map());
    const m = litCtx.get(kw);
    m.set(ctx, (m.get(ctx) || 0) + 1);
  }
}
console.log(`\n强调字上下文审阅（共 ${litTotal} 处，看是否有"意义/定义"这类误亮）：`);
let shown = 0;
const CTX_CAP = 140;
for (const kw of [...litCtx.keys()].sort((a, b) => a.length - b.length)) {
  const rows = [...litCtx.get(kw).entries()].sort((a, b) => b[1] - a[1]);
  rows.forEach(([ctx, n], i) => {
    if (shown >= CTX_CAP) return;
    shown++;
    console.log(
      `  ${col(i === 0 ? kw : "", 8)}${col(i === 0 ? String(n) : "", 5)}  …${ctx}…`,
    );
  });
}
if (shown >= CTX_CAP) console.log(`  …（已达显示上限 ${CTX_CAP} 行）`);
// 行宽估算：全角字符按 1em、半角按 0.55em，再加上词间距（近似值，用来提前发现换行/溢出）
const emW = (s) =>
  [...s].reduce(
    (n, ch) =>
      n + (/[\u2e80-\u9fff\u3000-\u303f\uff00-\uffef]/.test(ch) ? 1 : 0.55),
    0,
  );
const lineW = (l) => {
  if (!l || !l.length) return 0;
  const t = l.reduce(
    (n, p) => n + emW(spanTxt(p)) * (p[1] === "e" ? EMPHASIS_PX : NORMAL_PX),
    0,
  );
  return t + WORD_GAP_PX * (l.length - 1);
};
const rowsOf = (l) => (l && l.length ? Math.ceil(lineW(l) / STAGE_W) : 0);
const maxLineW = Math.max(...blocks.flatMap((b) => [lineW(b.l1), lineW(b.l2)]));
const wrapBlocks = blocks.filter((b) => rowsOf(b.l1) > 1 || rowsOf(b.l2) > 1);
const maxRows = Math.max(...blocks.map((b) => rowsOf(b.l1) + rowsOf(b.l2)));
// 竖向：块锚在舞台底部、向上生长，行数太多会顶出安全区（这才是放大字号的真风险）
const lineH = (l) => {
  if (!l || !l.length) return 0;
  const rowH = (l.some((p) => p[1] === "e") ? EMPHASIS_PX : NORMAL_PX) * LINE_HEIGHT;
  return rowsOf(l) * rowH;
};
const tallest = blocks
  .map((b) => ({ b, h: lineH(b.l1) + lineH(b.l2) + LINE_GAP_PX }))
  .sort((a, b) => b.h - a.h)[0];
console.log(
  `\n排版估算（${path.relative(ROOT, CFG_FILE)}）：SCALE=${SCALE}  字号 ${NORMAL_PX}/${EMPHASIS_PX}px  可用宽 ${STAGE_W}px  最长行 ${maxLineW.toFixed(0)}px（占 ${((maxLineW / STAGE_W) * 100).toFixed(0)}%）`,
);
console.log(
  `  折行：${wrapBlocks.length} / ${blocks.length} 个分句折成多行，单分句最多 ${maxRows} 行`,
);
console.log(
  `  竖向：最高分句 ${tallest.b.start}s 约 ${tallest.h.toFixed(0)}px / 舞台 ${STAGE_H}px（距底 ${MARGIN_BOTTOM_PX}px）`,
);
if (tallest.h > STAGE_H) {
  console.log(`  ⚠ 顶出安全区：${tallest.b.start}s  ${txt(tallest.b)}`);
  console.log(
    `    把 SCALE 降到约 ${(SCALE * (STAGE_H / tallest.h) * 0.95).toFixed(2)}，或加大 STAGE_H`,
  );
}
if (heavy.length) {
  console.log(`  ⚠ 偏重的行 ${heavy.length} 处（>${MAX_KW} 个超大词）：`);
  for (const b of heavy)
    console.log(`    ${String(b.start).padStart(7)}s  ${txt(b)}`);
}

console.log(`\n字幕组件=${SOURCE_COMPONENT}  →  compositions/captions.html`);
console.log(
  `units=${units.length} blocks=${blocks.length} 强调词=${emCount} 含强调的次行=${emLineCount}`,
);
console.log(
  `audio=${audioLen.toFixed(2)}s  根时长=${Math.ceil(audioLen)}  音轨/槽=${dur}`,
);
