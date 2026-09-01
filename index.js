#!/usr/bin/env node
// index.js —— latency 命令行入口
//
// 用法：
//   node index.js --list                    列出可用麦克风设备
//   node index.js [选项]                    执行延迟测量
//
// 常用选项：
//   --ffmpeg <path>        ffmpeg.exe 路径（默认从 PATH / 环境变量 FFMPEG_PATH /
//                          D:\ffmpeg-master-latest-win64-gpl-shared\bin 查找）
//   --ffplay <path>        ffplay.exe 路径（默认从 PATH / 环境变量 FFPLAY_PATH /
//                          同 ffmpeg 目录查找）
//   --input <device>       录音设备（麦克风）名
//   --times <n>            测量次数（非引导默认 5，引导默认 3）
//   --reference <ms>       参考基线（ms），用于计算输出链路净延迟
//   --lead <seconds>       chirp 前导静音（默认 2.0，覆盖链路唤醒）
//   --rate <hz>            采样率（默认 48000）
//   --min-quality <q>      波形相关辅助阈值 0..1（默认 0.10）
//   --min-significance <s> 峰值显著性阈值（默认 20，主判据）
//   --audio <file>         用音频文件代替 chirp 作为测试信号
//   --playback-latency <ms> 播放器开销（ffplay/SDL 缓冲），从结果扣除
//   --mic-latency <ms>      麦克风固有延迟（如 USB 麦克风），从结果扣除
//   --loopback             WASAPI loopback 双路模式（输出→麦克风净延迟）
//   --no-loopback         旧模式（播放启动→麦克风，含播放缓冲）
//   --no-guided           关闭引导式流程（默认开启）
//   --print-latency       打印每次测量的延迟过程行（默认不打印）
//   --keep                 保留临时 WAV 文件（调试用）
//   --no-pause             运行结束后不暂停（默认“按任意键继续”）

import fs from 'node:fs';
import readline from 'node:readline';
import { findFfmpeg, findFfplay, listDevices } from './src/ffmpeg.js';
import { measureOnce, measureRepeated } from './src/measure.js';
import { DEFAULT_SAMPLE_RATE } from './src/signal.js';

const HELP = `
latency —— 测量音频输出 → 麦克风的声学延迟

用法:
  node index.js --list                      列出可用麦克风设备
  node index.js [选项]                      执行延迟测量

选项:
  --ffmpeg <path>     ffmpeg.exe 路径（否则按 FFMPEG_PATH / PATH /
                      D:\\ffmpeg-master-latest-win64-gpl-shared\\bin 查找）
  --ffplay <path>     ffplay.exe 路径（否则按 FFPLAY_PATH / PATH /
                      同 ffmpeg 目录查找）
  --input <device>    录音设备（麦克风）名，见 --list
  --times <n>         测量次数（非引导默认 5，引导默认 3）
  --reference <ms>    参考基线延迟（ms）。输出链路净延迟 = 测得值 - 基线
  --lead <seconds>    chirp 前导静音时长（默认 2.0，覆盖链路唤醒）
  --rate <hz>         采样率（默认 48000）
  --min-quality <q>   波形相关辅助阈值 0..1（默认 0.10）
  --min-significance <s>  峰值显著性阈值（默认 20，主判据：录音中确有测试信号）
  --audio <file>      用音频文件（如简单音乐）代替 chirp 作为测试信号
  --playback-latency <ms>  播放器开销（ffplay/SDL 音频缓冲），从结果扣除
  --mic-latency <ms>   麦克风固有延迟（如 USB 麦克风），从结果扣除
  --loopback         用 WASAPI loopback 双路测量“输出→麦克风”净延迟
  --no-loopback      旧模式：播放启动→麦克风（含播放缓冲，数值会偏大）
  --no-guided        关闭引导式流程（默认开启：每副设备自动测 3 次取中位数）
  --print-latency    打印每次测量的延迟过程行（默认不打印，含显著性/相关性）
  --keep              保留临时 WAV 文件（调试用）
  --no-pause          运行结束后不暂停（默认会“按任意键继续”，方便双击运行）

测量原理:
  播放一段已知的线性调频信号（chirp），用麦克风录下输出设备（耳机/扬声器）
  发出的声音，通过互相关找到 chirp 在录音中的到达时刻，减去播放启动偏移，
  得到"从发出播放命令到麦克风拾音"的声学往返延迟。
  该值含系统播放/录音链路开销，用 --reference 差分可得到输出链路净延迟。

注意:
  部分蓝牙耳机空闲时链路会挂起，播放开始的前几百毫秒音频会被唤醒过程
  吞掉，因此 chirp 前必须留足静音（默认 2 秒），否则 chirp 会被吞、
  麦克风录不到信号。有线/扬声器等设备可把 --lead 调小（如 0.5）。
`;

function parseArgs(argv) {
  const args = { times: 5, lead: 2.0, rate: DEFAULT_SAMPLE_RATE, guided: true };
  const num = (name, v, { min = -Infinity, max = Infinity, integer = false } = {}) => {
    if (!Number.isFinite(v)) throw new Error(`选项 ${name} 需要一个数字，收到: ${v}`);
    if (integer && !Number.isInteger(v)) throw new Error(`选项 ${name} 需要整数，收到: ${v}`);
    if (v < min || v > max) throw new Error(`选项 ${name} 超出允许范围 [${min}, ${max}]`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--list': args.list = true; break;
      case '--ffmpeg': args.ffmpeg = next(); break;
      case '--ffplay': args.ffplay = next(); break;
      case '--input': args.input = next(); break;
      case '--times': args.times = Number(next()); args.timesSet = true; break;
      case '--reference': args.reference = Number(next()); break;
      case '--lead': args.lead = Number(next()); break;
      case '--rate': args.rate = Number(next()); break;
      case '--min-quality': args.minQuality = Number(next()); break;
      case '--min-significance': args.minSignificance = Number(next()); break;
      case '--audio': args.audio = next(); break;
      case '--playback-latency': args.playbackLatency = Number(next()); break;
      case '--mic-latency': args.micLatency = Number(next()); break;
      case '--keep': args.keep = true; break;
      case '--no-pause': args.noPause = true; break;
      case '--loopback': args.loopback = true; break;
      case '--no-loopback': args.loopback = false; break;
      case '--no-guided': args.guided = false; break;
      case '--print-latency': args.printLatency = true; break;
      case '--help': case '-h': args.help = true; break;
      default:
        throw new Error(`未知选项: ${a}\n\n${HELP}`);
    }
  }
  if (args.times != null) args.times = num('--times', args.times, { min: 1, integer: true });
  if (args.reference != null) args.reference = num('--reference', args.reference, { min: 0 });
  if (args.lead != null) args.lead = num('--lead', args.lead, { min: 0 });
  if (args.rate != null) args.rate = num('--rate', args.rate, { min: 8000, integer: true });
  if (args.minQuality != null) args.minQuality = num('--min-quality', args.minQuality, { min: 0, max: 1 });
  if (args.minSignificance != null) args.minSignificance = num('--min-significance', args.minSignificance, { min: 1 });
  if (args.playbackLatency != null) args.playbackLatency = num('--playback-latency', args.playbackLatency, { min: 0 });
  if (args.micLatency != null) args.micLatency = num('--mic-latency', args.micLatency, { min: 0 });
  return args;
}

function fmt(ms) {
  return ms == null ? 'n/a' : `${ms.toFixed(1)} ms`;
}

// 运行结束后是否暂停（默认 true，双击 exe 时防止窗口一闪而过）；--no-pause 关闭
let pauseAtEnd = true;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  pauseAtEnd = !args.noPause;
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const ffmpeg = args.ffmpeg || findFfmpeg();
  if (!ffmpeg) {
    throw new Error('未找到 ffmpeg。请用 --ffmpeg <path> 指定，或设置环境变量 FFMPEG_PATH，' +
      '或将其放入 D:\\ffmpeg-master-latest-win64-gpl-shared\\bin。');
  }

  if (args.list) {
    const { inputs } = await listDevices(ffmpeg);
    console.log('可用麦克风（录音）设备:');
    if (inputs.length === 0) {
      console.log('  （未找到音频输入设备）');
    } else {
      inputs.forEach((d, i) => console.log(`  [${i}] ${d}`));
    }
    console.log('\n提示: 请把待测输出设备（耳机/扬声器）设为系统默认播放设备，然后用 --input 指定麦克风。');
    return;
  }

  const ffplay = args.ffplay || findFfplay();
  if (!ffplay) {
    throw new Error('未找到 ffplay。请用 --ffplay <path> 指定，或设置环境变量 FFPLAY_PATH，' +
      '或将其放入 D:\\ffmpeg-master-latest-win64-gpl-shared\\bin。');
  }

  // 确定录音设备
  let inputDevice = args.input;
  if (!inputDevice) {
    const { inputs } = await listDevices(ffmpeg);
    if (inputs.length === 0) {
      throw new Error('未找到麦克风设备。请用 --input <device> 指定。');
    }
    inputDevice = inputs[0];
    console.log(`未指定 --input，使用第一个麦克风: ${inputDevice}`);
  }

  console.log('==================================================');
  console.log('音频输出延迟测试');
  console.log('--------------------------------------------------');
  console.log(`  录音设备: ${inputDevice}`);
  const modeText =
    args.loopback === false
      ? '含播放缓冲（旧模式）'
      : args.loopback === true
        ? '强制 loopback 双路'
        : '自动（优先 loopback，否则含缓冲）';
  console.log(`  测量方式: ${modeText}`);
  console.log(`  测试信号: ${args.audio ? `音频文件 ${args.audio}` : 'chirp 500~8000Hz'}`);
  console.log(`  采样率:   ${args.rate} Hz`);
  if (args.playbackLatency != null) console.log(`  扣除播放器开销: ${fmt(args.playbackLatency)}`);
  if (args.reference != null) console.log(`  参考基线: ${fmt(args.reference)}`);
  console.log('--------------------------------------------------');
  console.log('请把输出设备（耳机/扬声器）放好，并靠近麦克风（扬声器朝向麦克风）。');
  console.log('开始测量…\n');

  if (args.audio && !fs.existsSync(args.audio)) {
    throw new Error(`音频文件不存在: ${args.audio}`);
  }

  const cfg = {
    ffmpegPath: ffmpeg,
    ffplayPath: ffplay,
    inputDevice,
    sampleRate: args.rate,
    leadSilence: args.lead,
  };
  if (args.audio) cfg.audioFile = args.audio;
  if (args.playbackLatency != null) cfg.playbackLatency = args.playbackLatency;
  if (args.micLatency != null) cfg.micLatency = args.micLatency;
  cfg.mode = args.loopback === false ? 'mic' : args.loopback === true ? 'loopback' : 'auto';
  if (args.minQuality != null) cfg.minQuality = args.minQuality;
  if (args.minSignificance != null) cfg.minSignificance = args.minSignificance;

  // 引导式流程：每副设备自动测量并取中位数（仅交互终端）
  if (args.guided && process.stdin.isTTY && process.stdout.isTTY) {
    if (args.reference != null) {
      console.warn('提示: 引导式流程会自行测量有线基准，--reference 在此模式被忽略。');
    }
    await guidedMeasure(cfg, args);
    return;
  }

  const stats = await measureRepeated(cfg, args.times, (i, r) => {
    if (!args.printLatency) return;
    const sigText = r.significance != null ? `显著性 ${r.significance.toFixed(0)}` : '显著性 n/a';
    const corrText = r.quality != null ? `相关 ${(r.quality * 100).toFixed(0)}%` : '相关 n/a';
    const peakText = r.peakDb != null ? `峰值 ${r.peakDb.toFixed(0)}dBFS` : '';
    console.log(
      `  #${String(i).padStart(2)}  延迟 ${r.valid ? fmt(r.roundTripMs) : '无效'}  (${sigText}  ${corrText}  ${peakText}${r.valid ? '' : ' ✗'})`
    );
  });

  console.log('--------------------------------------------------');
  if (stats.validCount === 0) {
    console.log('  所有测量均无效（未检测到有效信号）。');
    console.log('  请确认：');
    console.log('    1. 输出设备（耳机/扬声器）已设为系统默认播放设备且正在发声；');
    console.log('    2. 输出设备扬声器靠近并朝向麦克风；');
    console.log('    3. 输出设备音量足够大（每行“峰值”应 ≥ -20 dBFS）；');
    console.log('    4. 关闭麦克风的“音频增强/回声消除/降噪”（Windows 设置 → 系统 →');
    console.log('       声音 → 麦克风 → 音频增强），它会抑制扬声器发出的测试音；');
    console.log('    5. 仍无效可试 --audio <音乐文件> 用自然音频代替 chirp，或 --keep 保留录音排查。');
  } else {
    console.log(
      `  延迟: 中位数 ${fmt(stats.medianMs)}   均值 ${fmt(stats.meanMs)}  ` +
      `(有效 ${stats.validCount}/${stats.total})`
    );
    console.log(`            标准差 ${fmt(stats.stdMs)}   范围 ${fmt(stats.minMs)} ~ ${fmt(stats.maxMs)}`);
    if (args.reference != null) {
      const net = stats.medianMs - args.reference;
      console.log('--------------------------------------------------');
      console.log(`  输出链路净延迟 ≈ ${fmt(net)}  (测得中位数 - 参考基线 ${fmt(args.reference)})`);
    }
  }
  console.log('==================================================');

  if (!args.keep) {
    // 清理临时文件
    for (const r of stats.results) {
      for (const f of Object.values(r.files)) {
        try { fs.unlinkSync(f); } catch { /* ignore */ }
      }
    }
  }

  if (stats.validCount > 0 && stats.validCount < stats.total) {
    console.log('\n⚠ 部分测量无效。可能原因：麦克风离输出设备太远、环境噪声过大、输出设备音量太小。');
  }
}

/**
 * 引导式测量（通用，不限有线/蓝牙顺序）：
 *   第一副（有线基准）：loopback 测 N 次取中位数，mic 测 N 次取含缓冲中位数，偏移 = 含缓冲 − 延迟。
 *   之后每副设备：
 *     - 先试 loopback（最多 N 次），延迟合理直接采信；
 *     - loopback 不可用（如蓝牙）→ mic 测 N 次取含缓冲中位数，延迟 = 含缓冲 − 偏移。
 *   N 默认 3，--times 可覆盖。
 *   每次列出：延迟；仅在 --print-latency 时附带含缓冲、偏移与每次测量的显著性/相关性。
 */
async function guidedMeasure(cfg, args) {
  const keep = !!args.keep;
  const tries = args.timesSet ? args.times : 3; // 引导式默认 3 次，--times 可覆盖
  const minQuality = cfg.minQuality ?? 0.10;
  const minSignificance = cfg.minSignificance ?? 20;

  const fmtSigCorr = (r) => {
    const sig = r.significance != null ? `显著性 ${r.significance.toFixed(0)}` : '显著性 n/a';
    const corr = r.quality != null ? `相关 ${(r.quality * 100).toFixed(0)}%` : '相关 n/a';
    const loop = r.loopQuality != null ? `  loop相关 ${(r.loopQuality * 100).toFixed(0)}%` : '';
    return `${sig}  ${corr}${loop}`;
  };

  const cleanup = (r) => {
    if (keep || !r || !r.files) return;
    for (const f of Object.values(r.files)) {
      try { fs.unlinkSync(f); } catch { /* ignore */ }
    }
  };

  // loopback 结果有效：mic 与 loop 两路都要可信，延迟还要在合理物理范围内。
  // loop 通道读包时刻时间戳会引入 ±5ms 抖动，loopQuality（波形 NCC）会偏低，
  // 因此除了 loopQuality ≥ 0.9 外，还允许用 loop 通道自己的 PHAT 显著性，
  // 或“mic 显著性>50 且 mic 相关>0.5”作为 loop 通道有效的旁证。
  const loopbackOk = (r) => {
    const loopEvident =
      (r.loopQuality ?? 0) >= 0.9 ||
      (r.loopSignificance ?? 0) >= 50 ||
      (r.significance >= 50 && r.quality >= 0.5);
    return (
      r.quality >= minQuality &&
      (r.significance ?? Infinity) >= minSignificance &&
      loopEvident &&
      r.roundTripMs >= 5 &&
      r.roundTripMs <= 500
    );
  };

  // mic 结果有效：与 measureRepeated 相同的显著性 + 质量判据
  const micOk = (r) =>
    r.quality != null &&
    r.significance != null &&
    r.roundTripMs != null &&
    r.quality >= minQuality &&
    r.significance >= minSignificance;

  /**
   * 引导式测量带补测的多次采样：
   *   目标是拿到 tries 个有效值；某次无效就补测 1 次。
   *   连续 3 次无效则停止，并对已有有效值取平均；全部无效返回 null。
   *   正常拿满 tries 个有效值时返回中位数（偶数取平均）。
   */
  const measureWithRetry = async ({ mode, tries, isValid, label, minValid = 1 }) => {
    const validResults = [];
    let consecutiveBad = 0;
    let attempt = 0;
    const maxAttempts = tries * 2; // 防止“有效/无效交替”导致无限补测
    while (validResults.length < tries && consecutiveBad < 3 && attempt < maxAttempts) {
      attempt++;
      let r = null;
      try {
        r = await measureOnce({ ...cfg, mode });
      } catch (err) {
        if (mode === 'loopback' && err.message.startsWith('LOOPBACK_UNAVAILABLE')) break;
        if (mode === 'loopback') throw err;
        // mic 模式的单次失败按无效处理，走补测逻辑
      }
      const ok = r ? isValid(r) : false;
      if (ok) {
        validResults.push(r);
        consecutiveBad = 0;
      } else {
        consecutiveBad++;
      }
      if (args.printLatency) {
        const tag = attempt <= tries ? `${attempt}/${tries}` : `补测 ${attempt}/${tries}`;
        const delay = ok
          ? fmt(r.roundTripMs)
          : (r && r.roundTripMs != null ? `无效 (原始 ${fmt(r.roundTripMs)})` : '无效');
        const head = label ? `${label} ${delay}` : `延迟 ${delay}`;
        const metrics = r ? `(${fmtSigCorr(r)})` : '';
        console.log(`  ${tag}  ${head}  ${metrics}`);
      }
      if (r) cleanup(r);
    }

    if (validResults.length < minValid) return null;
    if (validResults.length === tries) {
      const sorted = [...validResults].sort((a, b) => a.roundTripMs - b.roundTripMs);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 1
        ? sorted[mid].roundTripMs
        : (sorted[mid - 1].roundTripMs + sorted[mid].roundTripMs) / 2;
    }
    // 提前停止（连续无效 / loopback 不可用 / 达到补测上限）：按已有有效值取平均
    return validResults.reduce((sum, r) => sum + r.roundTripMs, 0) / validResults.length;
  };

  const tryLoopbackMedian = (tries) =>
    measureWithRetry({ mode: 'loopback', tries, isValid: loopbackOk, label: '', minValid: Math.min(2, tries) });

  const runMicMedian = (times, label) =>
    measureWithRetry({ mode: 'mic', tries: times, isValid: micOk, label });

  console.log('==================================================');
  console.log('第一次测量请把有线耳机/扬声器设为默认播放设备，作为基准参考。\n');

  let offsetMs = null; // 基准设备测得的播放缓冲偏移（播放路径上游缓冲，与输出设备无关）

  let no = 1;
  while (true) {
    const go = await ask(`第 ${no} 副：接好并设为默认播放后按 Enter 测量（q 退出）: `);
    if (go.toLowerCase() === 'q') {
      console.log('结束。');
      return;
    }

    console.log(`#${no} 测量中...`);

    let delayMedian = null;
    let buffMedian = null;
    const isBaseline = no === 1;

    if (isBaseline) {
      // 第一副：必须是有线基准。loopback 最多 tries 次，连续 3 次不合理即放弃。
      delayMedian = await tryLoopbackMedian(tries);

      if (delayMedian != null) {
        // 基准的含缓冲：mic tries 次取中位数，建立偏移（此后不再更新）
        try {
          buffMedian = await runMicMedian(tries, '延迟(含缓冲)');
        } catch (err) {
          console.log(`  含缓冲测量失败: ${err.message}`);
        }
        if (buffMedian != null) offsetMs = buffMedian - delayMedian;
      }
    } else {
      // 后续设备：先试 loopback（最多 tries 次）；不可用/不合理时用 mic tries 次 + 已有偏移反推
      delayMedian = await tryLoopbackMedian(tries);
      if (delayMedian == null) {
        try {
          buffMedian = await runMicMedian(tries, '延迟(含缓冲)');
          if (offsetMs != null && buffMedian != null) {
            delayMedian = buffMedian - offsetMs;
          }
        } catch (err) {
          console.log(`  含缓冲测量失败: ${err.message}`);
        }
      }
    }

    console.log('  ----------------');
    const refParts = [];
    if (args.printLatency) {
      if (buffMedian != null) refParts.push(`含缓冲 ${fmt(buffMedian)}`);
      if (offsetMs != null) refParts.push(`偏移 ${fmt(offsetMs)}`);
    }
    if (delayMedian != null) {
      console.log(`  延迟: ${fmt(delayMedian)}${refParts.length ? `  (${refParts.join('，')})` : ''}`);
    } else {
      console.log(`  延迟: 未知${refParts.length ? `  (${refParts.join('，')})` : ''}（请先测一副支持 loopback 的设备）`);
    }
    console.log('  ----------------');

    const again = await ask('下一副？换好后 Enter 继续，q 退出: ');
    if (again.toLowerCase() === 'q') {
      console.log('结束。');
      return;
    }
    no++;
  }
}

function ask(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

/**
 * 等待用户按键（用于运行结束后暂停）。仅在 stdin/stdout 都是 TTY 时生效，
 * 避免在管道/重定向/脚本调用时卡住。
 */
function waitForKey() {
  return new Promise((resolve) => {
    process.stdout.write('\n按任意键继续...');
    const finish = () => {
      process.stdout.write('\n');
      resolve();
    };
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.once('data', () => {
        try {
          process.stdin.setRawMode(false);
        } catch {
          /* ignore */
        }
        process.stdin.pause();
        finish();
      });
    } catch {
      // 不支持 raw mode 的终端：退化为等待回车
      process.stdin.resume();
      process.stdin.once('data', finish);
    }
  });
}

/**
 * 判断当前是否由 node 直接运行 js 脚本（而非 SEA 打包的可执行文件）。
 * node 运行 js 时终端不会自动关闭，无需暂停；SEA exe 的 execPath 是打包出的 .exe。
 */
function isNodeScript() {
  return /node(\.exe)?$/i.test(process.execPath);
}

async function run() {
  try {
    await main();
  } catch (err) {
    console.error('\n出错:', err.message);
    process.exitCode = 1;
  }
  // 仅在“可执行文件（SEA exe）”运行时暂停（双击 exe 后窗口会关）；
  // 用 node 跑 js 文件时不暂停；且需交互终端、未 --no-pause。
  if (pauseAtEnd && !isNodeScript() && process.stdin.isTTY && process.stdout.isTTY) {
    await waitForKey();
  }
}

run();
