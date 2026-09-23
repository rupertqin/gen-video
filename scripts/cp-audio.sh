#!/usr/bin/env sh
# 拷贝 CosyVoice 产出的音频与字幕到 assets/audio/
# 需要的 2 个文件：audio.wav / audio.srt
# （字幕按"字"渲染，每个字的时间由所属分句均分推算，不再需要词级 srt）
# 源目录取 .env 里的 COSYVOICE_OUTPUT（也可用同名环境变量覆盖）
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC=${COSYVOICE_OUTPUT:-$(sed -n 's/^COSYVOICE_OUTPUT=//p' "$ROOT/.env" 2>/dev/null | head -1)}
DEST="$ROOT/assets/audio"
FILES="audio.wav audio.srt"

[ -n "$SRC" ] || { echo "未配置 COSYVOICE_OUTPUT（.env 或环境变量）" >&2; exit 1; }
[ -d "$SRC" ] || { echo "源目录不存在：$SRC" >&2; exit 1; }

# 先校验齐全再拷贝，避免出现半套资源
for f in $FILES; do
  [ -f "$SRC/$f" ] || { echo "缺少源文件：$SRC/$f" >&2; exit 1; }
done

mkdir -p "$DEST"
for f in $FILES; do cp "$SRC/$f" "$DEST/$f"; done
echo "已同步：$FILES -> $DEST"
