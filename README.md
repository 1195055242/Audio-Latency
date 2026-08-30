# Audio-Latency

测量“音频输出 → 麦克风”延迟的 Windows 工具，支持有线耳机/扬声器与蓝牙耳机。

延迟 = 麦克风接收时间点 - 音频流离开系统的时间点（蓝牙则是准备进入蓝牙协议栈的时间点）。

![1787532437479](images/README/1787532437479.png)

## 快速开始

```bash
node index.js            # 引导式测量（默认）
node index.js --list     # 列出麦克风设备
```

打包版：`dist\latency.exe`（双击运行）或 `node dist\latency.min.js`。

## 引导式流程

1. **第一次测量请用有线耳机/扬声器**作为基准参考，扬声器靠近麦克风，按 Enter。
2. 程序测出有线基准：loopback 3 次得 `延迟`（loopback 抓取点 → 麦克风）、mic 3 次得 `含缓冲`（播放启动 → 麦克风）、`偏移 = 含缓冲 − 延迟`。
3. 之后每副设备按 Enter 测量：
   - 先试 loopback（最多 3 次），延迟合理 → 直接给出 `延迟`；
   - 否则（如蓝牙）→ mic 3 次，用 `延迟 = 含缓冲 − 偏移` 计算。
4. 每副输出：`延迟: X ms`；加 `--print-latency` 时额外显示 `(含缓冲 Y ms，偏移 Z ms)`。

过程行默认不打印，加 `--print-latency` 可查看每次测量值（含显著性、相关性）。

## 全部选项


| 选项                      | 说明                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------- |
| `--list`                  | 列出麦克风设备                                                                               |
| `--ffmpeg <path>`         | 指定 ffmpeg.exe 路径（否则按`FFMPEG_PATH` / 可执行文件同目录 / `PATH` / 默认目录查找）       |
| `--ffplay <path>`         | 指定 ffplay.exe 路径（否则按`FFPLAY_PATH` / 可执行文件同目录 / `PATH` / 同 ffmpeg 目录查找） |
| `--input <device>`        | 指定录音（麦克风）设备名，见`--list`                                                         |
| `--times <n>`             | 测量次数（默认 3）                                                                           |
| `--reference <ms>`        | 参考基线延迟（ms）。输出链路净延迟 = 测得值 − 基线                                          |
| `--lead <seconds>`        | chirp 前导静音时长（默认 2.0，覆盖链路唤醒）                                                 |
| `--rate <hz>`             | 采样率（默认 48000）                                                                         |
| `--min-quality <q>`       | 波形相关辅助阈值 0..1（默认 0.15）                                                           |
| `--min-significance <s>`  | 峰值显著性阈值（默认 20，主判据）                                                            |
| `--audio <file>`          | 用音频文件代替 chirp 作为测试信号                                                            |
| `--playback-latency <ms>` | 播放器开销（ffplay/SDL 缓冲），从结果中扣除                                                  |
| `--loopback`              | 强制 WASAPI loopback 双路模式（输出→麦克风净延迟）                                          |
| `--no-loopback`           | 旧模式：播放启动→麦克风（含播放缓冲，数值偏大）                                             |
| `--no-guided`             | 关闭引导式流程（默认开启）                                                                   |
| `--print-latency`         | 打印每次测量的延迟过程行（含显著性、相关性）                                                 |
| `--keep`                  | 保留临时 WAV 文件（调试用）                                                                  |
| `--no-pause`              | 运行结束后不暂停（默认“按任意键继续”）                                                     |
| `--help`, `-h`            | 显示帮助                                                                                     |

## 测量原理

播放一段已知的 chirp（默认 500~8000Hz），用 GCC-PHAT 互相关定位到达时刻：

- **loopback 模式**：同时抓系统输出(loopback)与麦克风，两路 chirp 位置差 = 输出→麦克风延迟，播放缓冲自动消掉。
- **含缓冲模式**：用 ffplay 音频时钟与麦克风到达时刻相减，含播放缓冲，用于计算偏移/差分。

有效判据：峰值显著性 ≥ 20（默认）且波形相关 ≥ 0.15；loopback 模式还要求 loop 通道波形相关 ≥ 0.9。

## 构建

```bash
npx esbuild index.js --bundle --platform=node --format=esm --minify --outfile=dist/latency.min.js
```

更多细节见 [docs/glossary.md](docs/glossary.md) 与 [docs/architecture.md](docs/architecture.md)。
