#!/usr/bin/env sh
# 由母版 assets/audio/audio.wav 生成压缩版 assets/audio/audio.m4a。
#
# 为什么需要它：框架运行时会强制 audio.preload="auto"，也就是把整个音频读完并等它就绪；
# 母版 111MB 时这一步的开销非常大。压缩版 15MB，体积小约 7 倍。
# 母版 wav 保留作时长基准（build-audio.mjs 的 wavDuration 读它）与再生成来源。
#
# 幂等：m4a 比 wav 新就跳过。改/换音频后运行：npm run preview-audio
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC="$ROOT/assets/audio/audio.wav"
DST="$ROOT/assets/audio/audio.m4a"

[ -f "$SRC" ] || { echo "缺少 $SRC" >&2; exit 1; }
command -v ffmpeg >/dev/null 2>&1 || { echo "需要 ffmpeg 才能生成 m4a" >&2; exit 1; }

if [ -f "$DST" ] && [ "$DST" -nt "$SRC" ]; then
  echo "已是最新：$(basename "$DST")（$(du -h "$DST" | cut -f1)）"
  exit 0
fi

# 语音单声道 96kbps / 保持源采样率 24000，时长与原文件完全一致
ffmpeg -hide_banner -v error -y -i "$SRC" -c:a aac -b:a 96k -ac 1 -ar 24000 "$DST"
echo "已生成：$(basename "$DST")  $(du -h "$DST" | cut -f1)  （母版 $(du -h "$SRC" | cut -f1)）"
