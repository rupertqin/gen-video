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
  const out = [];
  for (const b of text.trim().split(/\n\s*\n/)) {
    const l = b.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const i = l.findIndex((x) => x.includes("-->"));
    if (i < 0) continue;
    const [a, z] = l[i].split("-->");
    const body = l.slice(i + 1).join("");
    if (body) out.push({ start: sec(a), end: sec(z), text: body });
  }
  return out;
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
 *   cues   原始分句
 *   plain  去标点全文（计数基准）
 */
export function loadChars(sentSrtPath) {
  const cues = parseSrt(fs.readFileSync(sentSrtPath, "utf8"));
  const chars = [];
  const groups = [];

  for (const cue of cues) {
    // 分字：标点并入前一个字
    const units = [];
    for (const ch of cue.text) {
      if (isPunct(ch) && units.length) units[units.length - 1].text += ch;
      else units.push({ text: ch, spoken: isPunct(ch) ? 0 : 1 });
    }
    if (!units.length) continue;

    const slots = Math.max(1, units.reduce((n, u) => n + u.spoken, 0));
    const span = cue.end - cue.start;
    const ws = chars.length;
    let acc = 0;
    for (const u of units) {
      const start = cue.start + (span * acc) / slots;
      acc += u.spoken;
      chars.push({
        text: u.text,
        start,
        end: cue.start + (span * acc) / slots,
        group: groups.length,
      });
    }
    groups.push({
      index: groups.length,
      ws,
      we: chars.length - 1,
      start: cue.start,
      end: cue.end,
      text: cue.text,
    });
  }

  return {
    chars,
    groups,
    cues,
    plain: strip(cues.map((c) => c.text).join("")),
  };
}
