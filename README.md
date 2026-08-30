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
   - 否则（如蓝牙）→ mic 5 次，用 `延迟 = 含缓冲 − 偏移` 计算。
4. 每副输出：`延迟: X ms (含缓冲 Y ms，偏移 Z ms)`。

过程行默认不打印，加 `--print-latency` 可查看每次测量值。

## 常用选项


| 选项               | 说明                     |
| ------------------ | ------------------------ |
| `--list`           | 列出麦克风设备           |
| `--input <name>`   | 指定录音麦克风           |
| `--print-latency`  | 打印每次测量的延迟过程行 |
| `--no-guided`      | 关闭引导式流程           |
| `--no-loopback`    | 强制含缓冲模式           |
| `--reference <ms>` | 差分基线                 |
| `--keep`           | 保留临时 WAV 调试        |

## 测量原理

播放一段已知的 chirp（默认 500~8000Hz），用 GCC-PHAT 互相关定位到达时刻：

- **loopback 模式**：同时抓系统输出(loopback)与麦克风，两路 chirp 位置差 = 输出→麦克风延迟，播放缓冲自动消掉。
- **含缓冲模式**：用 ffplay 音频时钟与麦克风到达时刻相减，含播放缓冲，用于计算偏移/差分。

有效判据：峰值显著性 ≥ 20（默认）且波形相关 ≥ 0.05；loopback 模式还要求 loop 通道波形相关 ≥ 0.5。

## 构建

```bash
npx esbuild index.js --bundle --platform=node --format=esm --minify --outfile=dist/latency.min.js
```

更多细节见 [docs/glossary.md](docs/glossary.md) 与 [docs/architecture.md](docs/architecture.md)。
