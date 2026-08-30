# 代码核心思路

## 总体流程

```
生成测试信号 → 播放 → 录音 → 互相关定位 → 计算延迟
```

入口 `index.js` 负责 CLI、设备选择、引导式交互；`src/measure.js` 负责单次/多次测量编排；`src/correlate.js` 是 DSP 核心；`src/signal.js` 生成/读写 WAV；`src/ffmpeg.js` 封装 ffmpeg/ffplay 进程与 loopback helper 调用。

## 两种测量模式

### 1. loopback 模式（`mode: 'loopback'`，有线可用时最准）

- 由 `loopback-recorder.ps1`（PowerShell 内嵌 C#，WASAPI）**同时**抓两路：
  - channel 0 = 系统输出 loopback（扬声器发声前的音频流）
  - channel 1 = 麦克风
- 两路都用 QPC 时间戳对齐，输出 48k 立体声 WAV。
- Node 侧读双通道，分别与 chirp 模板做 `matchChirp`：

```
输出→麦克风 = (麦克风里 chirp 位置 − loopback 里 chirp 位置) / 采样率
```

播放缓冲完全在 loopback 参考点上游，**自动被排除**。

### 2. 麦克风模式（`mode: 'mic'`，含播放缓冲）

- `ffmpeg -f dshow` 录音，`ffplay` 播放。
- 时间对齐（消除 ffplay 进程启动延迟）：
  - 录音侧：`recStarted.time`（采集开始检测）+ `arrivalMs`（chirp 在录音中的样本偏移）
  - 播放侧：用 ffplay `-stats` 音频时钟 `clockStart` 推算 `M = leadSilence` 的时刻，即 chirp 开始播放的墙钟时刻
- 结果 = 播放缓冲 + 输出→麦克风，因此需要扣偏移或做差分。

## 信号检测（src/correlate.js）

- `crossCorrelate`：FFT 频域互相关。
- `crossCorrelatePhat`：GCC-PHAT，白化幅度谱只留相位，抗频谱整形。
- `findPeak`：全局峰值 + 抛物线亚样本插值。
- `demeanNcc`：去均值归一化相关，衡量波形相似度。
- `resampleSegment` / `compensateRateOffsetNcc`：在 ±200ppm 内搜索最佳重采样比（并修正 PHAT 定位的少量样本偏移），补偿播放/录音采样时钟偏差后再算 NCC。
- `peakSignificance`：峰值/本底 RMS，判断“确实有 chirp”。
- `matchChirp`：一站式：PHAT 定位 + 质量 + 显著性。

有效性判据（`measureRepeated`）：`significance ≥ 20`（默认）且 `quality ≥ 0.15`；loopback 结果还要求 `loopQuality ≥ 0.9` 且延迟在 5~500ms 的合理范围内。

## 引导式流程（index.js `guidedMeasure`）

1. **第一次测量用有线基准**：loopback N 次得 `延迟`（有线 QPC 对齐可靠），mic N 次得 `含缓冲`，`偏移 = 含缓冲 − 延迟`。
2. **每副设备**：
   - 先试 loopback，合理才采信；某次无效自动补测 1 次，连续 3 次无效即放弃；
   - 蓝牙等不可靠设备 → mic 模式，`延迟 = 含缓冲 − 偏移`。
3. 目标是拿到 N 个有效值，N 默认 3、可用 `--times <n>` 覆盖；正常拿满取中位数，提前停止时对已有有效值取平均（全部无效按无效处理）。过程行默认不打印（`--print-latency` 开启，含每次测量的显著性/相关性）；汇总只输出 `延迟`，仅在 `--print-latency` 时括号列出含缓冲、偏移。

## 关键文件


| 文件                     | 职责                                                       |
| ------------------------ | ---------------------------------------------------------- |
| `index.js`               | CLI、引导式交互、统计输出、暂停逻辑                        |
| `src/measure.js`         | 测量编排、时间戳对齐、模式分发、多次统计                   |
| `src/correlate.js`       | FFT、PHAT、峰值、质量、显著性                              |
| `src/signal.js`          | chirp 生成、WAV 读写（含多声道）                           |
| `src/ffmpeg.js`          | ffmpeg/ffplay 进程、设备枚举、loopback helper、decodeAudio |
| `loopback-recorder.ps1`  | WASAPI loopback+麦克风双路录制 helper                      |
| `test/correlate.test.js` | 信号检测单元测试                                           |

## 打包（dist/）

1. esbuild 把 ESM 源码 bundle 成单文件 CJS（SEA 用）与压缩 ESM（`latency.min.js`）。
2. `node --experimental-sea-config` 生成 blob。
3. 复制 `node.exe` 并用 postject 注入 blob → `latency.exe`。
4. `dist/` 附带 `loopback-recorder.ps1` 与 ffmpeg/ffplay + DLL，可独立分发。

## 已知限制

- **蓝牙 A2DP 端点可能不支持 WASAPI loopback**（0x88890008），此时走“含缓冲 − 偏移”差分路径。
- ffplay 的 SDL/WASAPI 播放缓冲大且不可从外部时间戳观测，loopback 是唯一干净解法。
- `IAudioClient` 的 COM vtable 必须按真实顺序完整声明，否则 HRESULT 错乱。
- `clockStart` 在异步回调中填充，返回对象需用 getter 读取最新值。
- 麦克风波形会被 DSP/回声消除扭曲（质量低但显著性够），所以有效性以显著性为主。
