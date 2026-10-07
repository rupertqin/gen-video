// SRT 装载（供 build-audio.mjs 使用）
//
// 唯一数据来源是 audio.srt（句子级，含标点）。不再依赖词级字幕。
//
// 字幕按"字"渲染：每个字是一个独立的渲染单位与时间单位。
// 每个字的时间由所属分句的 [start, end) 按字均分推算 ——
// 句子级字幕没有比"分句"更细的时间信息，均分是唯一可行的推算方式。
// 误差约 ±0.1~0.2s，但字幕没有口型参照，远低于感知阈值。
//
// 标点并入前一个字（且不占时间槽），避免标点被单独拆成一格。
import fs from "fs";

export const sec = (t) => {
  const [hms, ms] = t.trim().replace(".", ",").split(",");
  const [h, m, s] = hms.split(":").map(Number);
  return h * 3600 + m * 60 + s + Number(ms || 0) / 1000;
};

export function parseSrt(text) {
  const cues = [];
  let orphanLines = 0;
  for (const b of text.trim().split(/\n\s*\n/)) {
    const l = b.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const i = l.findIndex((x) => x.includes("-->"));
    if (i < 0) {
      // 源文件损坏：条目正文中间多了一个空行，于是「正文的后半截」被切成了独立一块，
      // 既没有序号也没有时间戳。直接丢弃会把整句字幕吃掉（实测本片有 18 处），
      // 所以接到上一条后面当续行 —— 它本来就和上一条共用同一个时间戳。
      const prev = cues[cues.length - 1];
      if (prev && l.length) {
        prev.text += l.join("");
        orphanLines++;
      }
      continue;
    }
    const [a, z] = l[i].split("-->");
    const body = l.slice(i + 1).join("");
    if (body) cues.push({ start: sec(a), end: sec(z), text: body });
  }
  return { cues, orphanLines };
}

export const strip = (s) => s.replace(/[\s\p{P}\p{S}]/gu, "");
export const isPunct = (s) => /^[\s\p{P}\p{S}]+$/u.test(s);

/** 在去标点全文里统计 term 的非重叠出现次数 */
export const countIn = (plain, term) => {
  let i = 0,
    c = 0;
  while ((i = plain.indexOf(term, i)) !== -1) {
    c++;
    i += term.length;
  }
  return c;
};

/**
 * 把 audio.srt 展开成"字"序列。
 * 返回：
 *   chars  [{ text, start, end, group }]  text 可能带尾随标点
 *   groups [{ index, ws, we, start, end, text }]
 *   cues   分句（已做下面的碎片归并）
 *   plain  去标点全文（计数基准）
 *   mergedFragments  被归并掉的碎片 cue 数
 *   orphanLines      被接回上一条的「无时间戳续行」块数（源文件损坏，见 parseSrt）
 *   movedQuotes      被挪回上一句末尾的收尾引号数
 *
 * 碎片 cue 归并：ASR（CosyVoice 等）偶尔会把一个收尾引号单独切成一条 cue，还给它 2~3 秒的
 * 独立窗口 —— 落到画面上就是「整屏一个 ” 停三秒」。这类 cue 不含任何实字，永远不该单独成块，
 * 所以这里把它的文本并进相邻那一句：收尾类（”』）… 等）并进上一句，开头类（“‘《 等）并进下一句。
 * **时间戳一律不动** —— 否则那句的「按字数均分」会被拉长，逐字节奏就落后于声音了。
 * 并进上一句时引号会挂在最后一个字上（标点本来就并入前一个字），跟着它一起出现。
 *
 * 选项：
 *   offset   整体平移（秒）。负数 = 字幕整体提前，正数 = 整体延后。
 *            在"句"这一层先平移、再按字数均分 —— 句内节奏因此不受影响；
 *            越出 [0, maxTime] 的部分在句级被截断，不会把某句压成零点几秒。
 *   maxTime  上界（通常是音频长度），默认不限。
 */
export function loadChars(sentSrtPath, { offset = 0, maxTime = Infinity } = {}) {
  const { cues: raw, orphanLines } = parseSrt(fs.readFileSync(sentSrtPath, "utf8"));
  const chars = [];
  const groups = [];

  // ---- 碎片 cue 归并（只有标点、没有实字的 cue）----
  const solid = (t) => t.replace(/[\s\p{P}\p{S}]/gu, "");
  const OPENING = /^[“‘「『（【《〈〔［]/;
  let mergedFragments = 0;

  // 第一遍：收尾类碎片并进上一条（追加文本 + 把上一条的显示窗口延长到碎片结束）
  const pass1 = [];
  for (const cue of raw) {
    const prev = pass1[pass1.length - 1];
    if (prev && !solid(cue.text) && !OPENING.test(cue.text)) {
      prev.text += cue.text;
      prev.holdEnd = Math.max(prev.holdEnd ?? prev.end, cue.end);
      mergedFragments++;
      continue;
    }
    pass1.push(cue);
  }
  // 第二遍：开头类碎片并进下一条（前置文本）；两侧都没有就丢弃
  const cues = [];
  for (let i = 0; i < pass1.length; i++) {
    const cue = pass1[i];
    if (solid(cue.text)) {
      cues.push(cue);
      continue;
    }
    const next = pass1[i + 1];
    if (next) next.text = cue.text + next.text;
    mergedFragments++; // 没有下一条时等于丢弃
    if (!next) continue;
  }

  // 收尾引号不可能出现在一句话的开头 —— 出现了就是源文件把它和上一条切散了（续行归并的副产物）。
  // 挪回上一条末尾；不动时间戳，它会跟着上一条最后一个字一起出现。
  let movedQuotes = 0;
  for (let i = 1; i < cues.length; i++) {
    const m = cues[i].text.match(/^[”』）】》」]+/);
    if (!m) continue;
    const rest = cues[i].text.slice(m[0].length);
    if (!rest) continue;
    cues[i].text = rest;
    cues[i - 1].text += m[0];
    movedQuotes++;
  }

  for (const cue of cues) {
    // 先做整体平移 + 边界截断，后续均分全部基于 cs/ce
    const cs = Math.min(maxTime, Math.max(0, cue.start + offset));
    // ce = 这句"说完"的时间，只用于按字数均分（决定逐字节奏）
    const ce = Math.min(maxTime, Math.max(cs, cue.end + offset));
    // ceHold = 整块"显示到"的时间。并进碎片后要比 ce 晚 —— 否则碎片那段窗口会全空白。
    // 两者分开：延长显示不会拖慢逐字节奏，句末的字按原节奏出现，然后整句停住直到 ceHold。
    const ceHold = Math.min(maxTime, Math.max(ce, (cue.holdEnd ?? cue.end) + offset));

    // 分字：标点并入前一个字
    const units = [];
    for (const ch of cue.text) {
      if (isPunct(ch) && units.length) units[units.length - 1].text += ch;
      else units.push({ text: ch, spoken: isPunct(ch) ? 0 : 1 });
    }
    if (!units.length) continue;

    const slots = Math.max(1, units.reduce((n, u) => n + u.spoken, 0));
    const span = ce - cs;
    const ws = chars.length;
    let acc = 0;
    for (const u of units) {
      const start = cs + (span * acc) / slots;
      acc += u.spoken;
      chars.push({
        text: u.text,
        start,
        end: cs + (span * acc) / slots,
        group: groups.length,
      });
    }
    groups.push({
      index: groups.length,
      ws,
      we: chars.length - 1,
      start: cs,
      end: ceHold, // 显示窗口（可能比 ce 长，见上）
      saidEnd: ce, // 这句实际说完的时间（逐字均分的终点），仅用于诊断
      text: cue.text,
    });
  }

  return {
    chars,
    groups,
    cues,
    plain: strip(cues.map((c) => c.text).join("")),
    mergedFragments,
    orphanLines,
    movedQuotes,
  };
}
