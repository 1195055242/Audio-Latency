# latency

测量“音频输出 → 麦克风”延迟的 Windows 工具（以麦克风接收为准），适用于有线耳机/扬声器与蓝牙耳机的延迟测量。

## 快速开始

```bash
# 源码运行（默认引导式流程：每副设备自动测 5 次取中位数）
node index.js

# 列出麦克风设备
node index.js --list
```

`dist/` 里是打包好的自包含版本：

```bash
dist\latency.exe          # 双击运行
node dist\latency.min.js  # 压缩单文件运行
```

## 引导式流程（默认）

每副设备（有线/蓝牙任意顺序）自动测 5 次并取中位数：

1. 接好待测耳机/扬声器并设为默认播放，按 Enter。
2. 每次播放同时得到两个值：`延迟`（输出→麦克风）与 `含缓冲`（播放启动→麦克风）。
3. 汇总显示：`延迟` 为主，括号内列 `含缓冲`、`偏移`。
4. 支持 loopback 的设备直接得到延迟；不支持的设备用 `延迟 = 含缓冲 − 偏移` 计算。
5. 提示是否继续测下一副。

## 常用选项

| 选项 | 说明 |
|---|---|
| `--list` | 列出麦克风设备 |
| `--input <name>` | 指定录音麦克风 |
| `--times <n>` | 非引导模式测量次数（默认 5） |
| `--reference <ms>` | 差分基线，输出净延迟 = 中位数 − 基线 |
| `--audio <file>` | 用音频文件（如音乐）代替 chirp 作为测试信号 |
| `--playback-latency <ms>` | 从结果中扣除播放器开销 |
| `--no-guided` | 关闭引导式流程 |
| `--no-loopback` | 强制旧模式（含播放缓冲） |
| `--keep` | 保留临时 WAV 调试 |
| `--no-pause` | 运行结束不暂停 |

## 测量原理

播放一段已知的线性调频信号（chirp，默认 500~8000Hz），麦克风录音后用 **GCC-PHAT 互相关**定位 chirp 到达时刻：

- **loopback 模式**：同时抓系统输出与麦克风，两路 chirp 位置差 = 输出→麦克风延迟（播放缓冲自动消掉）。
- **旧模式**：用播放启动时刻与麦克风到达时刻相减，结果含播放缓冲，适合做 `--reference` 差分。

有效性判据：峰值显著性 ≥ 35 且波形相关 ≥ 0.05。

## 环境要求

- Windows（ffmpeg/ffplay 与 WASAPI loopback helper 均为 Windows 能力）
- Node ≥ 18（源码运行时）
- `dist/` 版自带 ffmpeg/ffplay/DLL，无需安装 Node 或 ffmpeg

## 构建

```bash
# 压缩单文件
npx esbuild index.js --bundle --platform=node --format=esm --minify --outfile=dist/latency.min.js

# 可执行文件（Node SEA）
npx esbuild index.js --bundle --platform=node --format=cjs --outfile=dist/bundle.cjs
node --experimental-sea-config sea-config.json
copy node.exe dist\latency.exe
npx postject dist/latency.exe NODE_SEA_BLOB dist/sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

## 文档

- [核心名词解释](docs/glossary.md)
- [代码核心思路](docs/architecture.md)
