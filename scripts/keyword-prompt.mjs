// 生成"关键词提取 prompt"文件（keywords.prompt.md）—— 不含任何网络调用。
//
//   npm run keyword-prompt
//
// 用法：打开生成的 keywords.prompt.md，从「复制开始」行往下一路全选，粘进任意
// 对话式大模型（DeepSeek / ChatGPT / Claude / Gemini 都行），把返回的 JSON 数组
// 填进 caption.config.json 的 keywords，再跑 npm run build-audio 验证。
//
// 字幕变了就重跑本命令重新生成（会把最新的独白全文嵌进去）。
import fs from "fs";
import path from "path";

const ROOT = path.resolve(new URL("..", import.meta.url).pathname);
const SRT = path.join(ROOT, "assets/audio/audio.srt");
const OUT = path.join(ROOT, "keywords.prompt.md");

/* ---------- 字幕 → 纯文本（去掉序号与时间轴） ---------- */
const transcript = fs
  .readFileSync(SRT, "utf8")
  .split(/\n\s*\n/)
  .map((b) =>
    b
      .split(/\r?\n/)
      .filter((l) => !l.includes("-->") && !/^\d+$/.test(l.trim()))
      .join("")
      .trim(),
  )
  .filter(Boolean)
  .join("\n");

/* ---------- prompt 正文 ---------- */
// 判据全部来自实战教训：泛用词混入、单字误亮、虚词混入、造词对不上原文…
const PROMPT = `你是一位中文短视频字幕的设计师。下面是一段独白，请挑出【适合放超大号字体强调】的词。

设计约束：
- 字幕竖屏、逐字显示
- 被选中的词会以约 2 倍字号、另一种颜色、衬线字体放大出现
- 每个分句最多只强调 2 个词，所以整段视频总共只需要 15~30 个词

挑选标准（请逐条遵守）：
1. 术语与概念优先：挑承载核心思想的术语、专名、概念短语。
   不要泛用抽象名词 —— 反面例子：价值、现实、个人、能力、问题、时候、东西、关系、理论、行动。
   正面例子：元命题、工具理性、精英认知外衣、仁义礼智信。
2. 长度 2~8 个字。单个汉字（如"仁""义"）只有在文中确实独立成词时才有意义；
   若原文是与之相关的固定短语，请直接选那个短语（如"仁者安仁"而不是"仁"）。
3. 全文出现次数 2~10 次为宜：只出现 1 次的多半太偶然，超过 10 次的多半太泛用。
4. 必须是原文中【原样连续出现】的字符串，不许改写、不许换字、不许造词。
5. 不要虚词：不要连词、副词、情态动词（能够、需要、其实、越来越、并不…）。
6. 优先能体现论述张力或对立面的词（如"工具理性""元命题缺位""实践理性"）。
7. 可以选取原文中带引号的短语（作者自己已经强调过的地方）。

输出格式：一个 JSON 字符串数组，**每行一个词**（这就是要直接粘进配置文件的格式）：

[
  "元命题",
  "工具理性"
]

不要任何解释，不要 markdown 代码块，不要把数组挤成一行。

独白全文：
${transcript}`;

/* ---------- 写成可整段复制的文件 ---------- */
const doc = `# 关键词提取 prompt

改关键词的流程（不需要任何 API key）：

1. 从下面那行 ========== 之后，一路全选到文件末尾（这段就是完整的待发送内容）
2. 粘进对话式大模型的聊天窗口（DeepSeek / ChatGPT / Claude / Gemini 都行），发送
3. 把返回的数组（每行一个词）**原样粘进** \`caption.config.json\` 的 \`keywords\` 里，不需要改格式
4. 跑 \`npm run build-audio\` 验证 —— 看「覆盖率自检」和「强调字上下文审阅」

字幕变了就重跑 \`npm run keyword-prompt\` 重新生成本文件（会把最新独白嵌进去）。

---

========== 以下整段复制（到文件末尾） ==========

${PROMPT}
`;

fs.writeFileSync(OUT, doc, "utf8");
console.log(`已生成 ${path.relative(ROOT, OUT)}`);
console.log(`  独白 ${transcript.split("\n").length} 句 / ${transcript.length} 字`);
console.log(`  打开后从那行 ========== 之后全选到末尾，粘进聊天窗口即可。`);
