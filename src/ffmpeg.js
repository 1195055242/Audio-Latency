// ffmpeg.js —— 封装 ffmpeg（录音）与 ffplay（播放）进程，含设备枚举与时间戳对齐
//
// 测量对齐思路：
//   1. 先启动录音（ffmpeg），记录启动时刻 t_rec
//   2. 录音稳定后启动播放（ffplay），记录启动时刻 t_play
//   3. 录音文件中通过互相关找到 chirp 的偏移 offset（样本）
//   端到端往返延迟 ≈ offset / rate - (t_play - t_rec)
//
//   ffmpeg/ffplay 的进程启动延迟（D_rec、D_play）是系统偏置，
//   通过"参考设备差分法"（先测有线/扬声器基线，再测目标设备，相减）抵消，
//   从而得到目标输出链路（如蓝牙）本身引入的延迟。

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 默认查找目录（仅程序内查找兜底，不修改任何环境变量或系统文件）。
 * Windows 下若 PATH 中找不到 ffmpeg/ffplay，回退到该目录。
 */
const DEFAULT_BIN_DIRS =
  process.platform === 'win32'
    ? ['D:\\ffmpeg-master-latest-win64-gpl-shared\\bin']
    : [];

/** 定位可执行文件：env 覆盖 > 可执行文件同目录 > PATH 查找 > 默认目录兜底 */
function resolveBin(name, envKey) {
  if (process.env[envKey] && fs.existsSync(process.env[envKey])) {
    return process.env[envKey];
  }
  const exts = process.platform === 'win32' ? ['', '.exe'] : [''];
  // 1. 可执行文件同目录：打包成 exe 后，ffmpeg/ffplay 放在 exe 旁边即可被找到，
  //    便于把 dist/ 目录作为自包含应用分发。
  try {
    const exeDir = path.dirname(process.execPath);
    for (const ext of exts) {
      const full = path.join(exeDir, name + ext);
      if (fs.existsSync(full)) return full;
    }
  } catch {
    /* ignore */
  }
  // 2. 在 PATH 中查找
  const pathVar = process.env.PATH || '';
  for (const dir of pathVar.split(path.delimiter)) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try {
        if (fs.existsSync(full)) return full;
      } catch {
        /* ignore */
      }
    }
  }
  // 3. 默认目录兜底
  for (const dir of DEFAULT_BIN_DIRS) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext);
      try {
        if (fs.existsSync(full)) return full;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

export function findFfmpeg() {
  return resolveBin('ffmpeg', 'FFMPEG_PATH');
}

export function findFfplay() {
  return resolveBin('ffplay', 'FFPLAY_PATH');
}

/**
 * 运行 ffmpeg -list_devices 并解析音频输入（麦克风）设备名。
 * 设备列表由 ffmpeg 输出到 stderr。
 *
 * 新版 ffmpeg 输出形如：
 *   [in#0 @ 000...] "4-mic Microphone (4-mic Microphone)" (audio)
 *   [in#0 @ 000...]   Alternative name "@device_cm_{...}"
 *
 * @param {string} ffmpegPath
 * @returns {Promise<{ inputs: string[] }>}
 */
export function listDevices(ffmpegPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
      { windowsHide: true }
    );
    let out = '';
    child.stderr.on('data', (d) => (out += d.toString()));
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('error', reject);
    child.on('close', () => {
      const inputs = [];
      // 匹配形如  "设备名" (audio)  的行（引号内可能含括号）
      for (const line of out.split(/\r?\n/)) {
        const dev = line.match(/"([^"]+)"\s*\(audio\)/);
        if (dev) inputs.push(dev[1]);
      }
      resolve({ inputs });
    });
  });
}

/**
 * 启动录音。返回 { promise, startTime, waitUntilStarted, child }：
 *   startTime        = 进程启动时刻（performance.now，与调用方同一时钟）
 *   waitUntilStarted = 轮询等待麦克风真正开始采集（文件开始增长）后 resolve，
 *                      返回 { time, size }。用于对齐播放触发时刻。
 *   promise          = 录音完成时 resolve
 *
 * dshow 麦克风从进程启动到真正开始采集有约 1 秒的延迟，必须等它就绪
 * 才能启动播放，否则录音开头会缺失。加 -flush_packets 1 使数据实时落盘，
 * 以便通过文件大小轮询及时感知采集开始。
 *
 * @param {string} ffmpegPath
 * @param {{ device: string, duration: number, outPath: string, sampleRate: number }} opts
 */
export function startRecording(ffmpegPath, { device, duration, outPath, sampleRate }) {
  const startTime = performance.now();
  const child = spawn(
    ffmpegPath,
    [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'dshow', '-i', `audio=${device}`,
      '-t', String(duration),
      '-ar', String(sampleRate), '-ac', '1', '-c:a', 'pcm_s16le',
      '-flush_packets', '1',
      outPath,
    ],
    { windowsHide: true }
  );
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));

  const promise = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg 录音失败（退出码 ${code}）: ${stderr.trim()}`));
    });
  });

  // 轮询输出文件大小，直到开始增长（麦克风开始采集）或超时
  const waitUntilStarted = (timeoutMs = 15000, intervalMs = 10) =>
    new Promise((resolve, reject) => {
      const deadline = performance.now() + timeoutMs;
      const tick = () => {
        let size = 0;
        try {
          size = fs.statSync(outPath).size;
        } catch {
          /* 文件尚未创建 */
        }
        if (size > 0) {
          resolve({ time: performance.now(), size });
          return;
        }
        if (performance.now() > deadline) {
          reject(new Error(`等待麦克风开始录音超时（${timeoutMs}ms）: ${stderr.trim()}`));
          return;
        }
        setTimeout(tick, intervalMs);
      };
      tick();
    });

  return { promise, startTime, waitUntilStarted, child };
}

/**
 * 启动播放。返回 { promise, startTime, child, clockStart }。
 * 播放完成后 ffplay 自动退出（-autoexit）。
 *
 * 当 observeClock 为 true 时，加 -stats 并解析 ffplay 的音频时钟（M 值 = 已播放位置），
 * clockStart = { time, m } 记录第一行有效时钟的墙钟时刻与该时刻的播放位置（秒）。
 * 据此可在播放结束后精确推算出"测试信号开始播放"的墙钟时刻，从而消掉 ffplay 的
 * 进程启动延迟（Spawn → 音频时钟开始），比用 spawn 时刻更准。
 *
 * @param {string} ffplayPath
 * @param {string} filePath
 * @param {{ observeClock?: boolean }} [opts]
 */
export function startPlayback(ffplayPath, filePath, { observeClock = false } = {}) {
  const startTime = performance.now();
  const args = ['-nodisp', '-autoexit'];
  args.push(...(observeClock ? ['-stats'] : ['-loglevel', 'error']));
  args.push('-i', filePath);
  const child = spawn(ffplayPath, args, { windowsHide: true });

  let stderr = '';
  let clockStart = null; // { time: number, m: number }
  let clockBuf = ''; // 跨 chunk 残留缓冲（-stats 用 \r 覆盖输出，行可能被 data 事件拆开）
  child.stderr.on('data', (d) => {
    const s = d.toString();
    stderr += s;
    if (observeClock && !clockStart) {
      clockBuf += s;
      const lines = clockBuf.split(/[\r\n]+/);
      clockBuf = lines.pop(); // 保留最后一行未完成部分
      for (const line of lines) {
        // -stats 音频时钟行形如 `  -0.04 M-A:  0.000 fd=...`，第一列为播放位置(M)
        const m = line.match(/^\s*([-\d.]+)\s+M-A:/);
        if (m) {
          const val = parseFloat(m[1]);
          if (!Number.isNaN(val)) {
            clockStart = { time: performance.now(), m: val };
            break;
          }
        }
      }
    }
  });

  const promise = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffplay 播放失败（退出码 ${code}）: ${stderr.trim()}`));
    });
  });
  // clockStart 用 getter：它在异步回调里填充，返回对象需在 await promise 后能读到最新值
  return {
    promise,
    startTime,
    child,
    get clockStart() {
      return clockStart;
    },
  };
}

/**
 * 用 ffmpeg 将任意音频文件（wav/mp3/flac/…）解码为 16-bit 单声道 PCM，
 * 返回归一化到 [-1,1] 的 Float32Array。输出 raw s16le 到 stdout，避免临时文件。
 *
 * @param {string} ffmpegPath
 * @param {string} filePath 音频文件路径
 * @param {{ sampleRate?: number, duration?: number }} [opts] duration 秒，截取文件开头
 * @returns {Float32Array}
 */
export function decodeAudio(ffmpegPath, filePath, { sampleRate = 48000, duration } = {}) {
  const args = ['-hide_banner', '-loglevel', 'error', '-i', filePath];
  if (duration != null) args.push('-t', String(duration));
  args.push('-ar', String(sampleRate), '-ac', '1', '-f', 's16le', 'pipe:1');

  let buf;
  try {
    buf = execFileSync(ffmpegPath, args, { maxBuffer: 128 * 1024 * 1024 });
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString().trim() : '';
    throw new Error(`音频解码失败: ${filePath}\n${stderr}`);
  }

  const samples = new Float32Array(Math.floor(buf.length / 2));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = buf.readInt16LE(i * 2) / 32768;
  }
  return samples;
}

/**
 * 查找 loopback-recorder.ps1 辅助脚本。
 * 依次尝试：可执行文件同目录（打包分发场景）、当前工作目录（源码运行场景）。
 * @returns {string|null}
 */
export function findLoopbackHelper() {
  const candidates = [
    path.join(path.dirname(process.execPath), 'loopback-recorder.ps1'),
    path.join(process.cwd(), 'loopback-recorder.ps1'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * 启动 WASAPI loopback 双路录音（channel 0 = 系统输出，channel 1 = 麦克风）。
 * 返回 { child, promise, waitReady }：
 *   waitReady = 等待 helper 输出 READY（采集已开始，可触发播放）
 *   promise   = 录音完成时 resolve
 *
 * @param {object} opts
 * @param {string} opts.helperPath  loopback-recorder.ps1 路径
 * @param {string} opts.outPath     输出 stereo WAV 路径
 * @param {number} opts.duration    录音时长（秒）
 * @param {string} [opts.captureName] 麦克风设备名（子串匹配，空则用系统默认）
 */
export function startLoopbackRecording({ helperPath, outPath, duration, captureName }) {
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helperPath,
      '-Out', outPath, '-Duration', String(duration), '-CaptureName', captureName || ''],
    { windowsHide: true }
  );
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d.toString()));

  const waitReady = (timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`等待 loopback 录音就绪超时（${timeoutMs}ms）: ${stderr.trim()}`)),
        timeoutMs
      );
      child.stdout.on('data', (d) => {
        if (d.toString().includes('READY')) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        reject(new Error(`loopback 录音进程提前退出（${code}）: ${stderr.trim()}`));
      });
    });

  const promise = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`loopback 录音失败（退出码 ${code}）: ${stderr.trim()}`));
    });
  });

  return { child, promise, waitReady };
}
