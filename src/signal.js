// signal.js —— 测试信号生成与 WAV 读写
//
// 测量原理：播放一段已知的线性调频信号（chirp），用麦克风录下输出设备（耳机/扬声器）
// 发出的声音，再对录制信号与原始 chirp 做互相关，找到 chirp 在录音中出现的位置，
// 从而得到从"发出播放命令"到"麦克风拾取到声音"的声学往返延迟。

import fs from 'node:fs';

/** 默认采样率（Hz） */
export const DEFAULT_SAMPLE_RATE = 48000;

/**
 * 生成线性调频信号（chirp）。
 *
 * 默认扫频范围取 500~8000 Hz：蓝牙/小扬声器对 8kHz 以上的高频衰减明显，
 * 若扫到 20kHz，录音里的高频成分会被削掉，导致与模板的波形相关质量骤降、
 * 峰值定位出现系统性偏移。限制在可靠重放频段可显著提升检测鲁棒性。
 *
 * @param {object} opts
 * @param {number} [opts.sampleRate] 采样率
 * @param {number} [opts.duration]   chirp 时长（秒）
 * @param {number} [opts.f0]         起始频率（Hz）
 * @param {number} [opts.f1]         结束频率（Hz）
 * @param {number} [opts.amplitude]  幅度（0..1）
 * @returns {Float32Array} 归一化到 [-1, 1] 的样本
 */
export function generateChirp({
  sampleRate = DEFAULT_SAMPLE_RATE,
  duration = 0.3,
  f0 = 500,
  f1 = 8000,
  amplitude = 0.9,
} = {}) {
  const n = Math.round(duration * sampleRate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    // 瞬时频率线性扫频：f(t) = f0 + (f1 - f0) * t / duration
    // 相位为频率的积分，保证波形连续、无相位跳变。
    const phase =
      2 * Math.PI * (f0 * t + ((f1 - f0) / (2 * duration)) * t * t);
    // Hann 窗平滑起止，避免播放时出现爆音（click）
    const window = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
    out[i] = amplitude * Math.sin(phase) * window;
  }
  return out;
}

/**
 * 把样本写入 16-bit 单声道 PCM WAV 文件。
 *
 * @param {string} path 输出路径
 * @param {Float32Array} samples 样本（归一化 [-1,1]）
 * @param {number} sampleRate 采样率
 */
export function writeWav(path, samples, sampleRate = DEFAULT_SAMPLE_RATE) {
  const dataSize = samples.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write('RIFF', 0, 'ascii');
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8, 'ascii');
  buffer.write('fmt ', 12, 'ascii');
  buffer.writeUInt32LE(16, 16); // fmt 块大小
  buffer.writeUInt16LE(1, 20); // PCM 格式
  buffer.writeUInt16LE(1, 22); // 单声道
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // 字节率 = rate * 通道 * 2 字节
  buffer.writeUInt16LE(2, 32); // 块对齐
  buffer.writeUInt16LE(16, 34); // 位深
  buffer.write('data', 36, 'ascii');
  buffer.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < samples.length; i++) {
    // 裁剪到 [-1, 1]，转为 16-bit 有符号整数
    const v = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }

  fs.writeFileSync(path, buffer);
}

/**
 * 读取 16-bit 单声道 PCM WAV 文件，返回归一化样本。
 *
 * @param {string} path
 * @returns {{ samples: Float32Array, sampleRate: number }}
 */
export function readWav(path) {
  const { samples, sampleRate, channels } = readWavChannels(path);
  if (channels !== 1) {
    throw new Error(`仅支持 16-bit 单声道 WAV（当前: ${channels} 声道）`);
  }
  return { samples: samples[0], sampleRate };
}

/**
 * 读取 16-bit PCM WAV 文件，返回每个声道的归一化样本。
 *
 * @param {string} path
 * @returns {{ sampleRate: number, channels: number, samples: Float32Array[] }}
 */
export function readWavChannels(path) {
  const buf = fs.readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`不是有效的 WAV 文件: ${path}`);
  }

  let sampleRate = 0;
  let channels = 1;
  let bitsPerSample = 16;
  let blockAlign = 2;
  let dataOffset = -1;
  let dataSize = 0;

  // 遍历 RIFF 子块，定位 fmt 与 data
  let p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(p + 10);
      sampleRate = buf.readUInt32LE(p + 12);
      bitsPerSample = buf.readUInt16LE(p + 22);
      blockAlign = buf.readUInt16LE(p + 20);
    } else if (id === 'data') {
      dataOffset = p + 8;
      dataSize = size;
    }
    p += 8 + size + (size % 2); // 块按 2 字节对齐
  }

  if (dataOffset < 0 || sampleRate <= 0) {
    throw new Error(`WAV 文件缺少 data 或 fmt 块: ${path}`);
  }
  if (bitsPerSample !== 16) {
    throw new Error(`仅支持 16-bit PCM WAV（当前: ${bitsPerSample} bit）`);
  }

  const bytesPerSample = bitsPerSample / 8;
  const frameBytes = blockAlign || channels * bytesPerSample;
  const count = Math.floor(dataSize / frameBytes);
  const samples = [];
  for (let c = 0; c < channels; c++) {
    samples.push(new Float32Array(count));
  }
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < channels; c++) {
      samples[c][i] = buf.readInt16LE(dataOffset + i * frameBytes + c * bytesPerSample) / 32768;
    }
  }
  return { samples, sampleRate, channels };
}
