// measure.js —— 单次测量编排：生成测试信号 → 启动录音 → 启动播放 → 互相关求延迟

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateChirp, writeWav, readWav, readWavChannels, DEFAULT_SAMPLE_RATE } from './signal.js';
import { matchChirp } from './correlate.js';
import { startRecording, startPlayback, decodeAudio, findLoopbackHelper, startLoopbackRecording } from './ffmpeg.js';

/**
 * loopback 单次测量：helper 同时抓“系统输出(loopback)”与“麦克风”，
 * 两路分别与模板互相关，其位置差即“输出→麦克风”延迟，播放缓冲自动被参考掉。
 */
async function measureLoopbackOnce({
  ffmpegPath,
  ffplayPath,
  inputDevice,
  sampleRate,
  template,
  chirpPath,
  recPath,
  leadSilence,
  tailPad,
}) {
  const helperPath = findLoopbackHelper();
  if (!helperPath) {
    throw new Error('未找到 loopback-recorder.ps1，请将其放在程序同目录或当前工作目录');
  }
  const duration = leadSilence + template.length / sampleRate + tailPad;
  const rec = startLoopbackRecording({
    helperPath,
    outPath: recPath,
    duration,
    captureName: inputDevice,
    sampleRate,
  });

  let readyWall = null;
  try {
    await rec.waitReady();
    readyWall = performance.now();
  } catch (err) {
    rec.promise.catch(() => {}); // 避免未处理的 rejection
    try { rec.child.kill(); } catch { /* ignore */ }
    throw new Error(`LOOPBACK_UNAVAILABLE: ${err.message}`);
  }

  let play = null;
  try {
    play = startPlayback(ffplayPath, chirpPath, { observeClock: true });
    await play.promise;
    await rec.promise;
  } catch (err) {
    if (play) {
      play.promise.catch(() => {});
      try { play.child.kill(); } catch { /* ignore */ }
    }
    rec.promise.catch(() => {});
    try { rec.child.kill(); } catch { /* ignore */ }
    throw err;
  }

  // 录音样本 0 的 Node 墙钟：用 helper 的 READY QPC 与 START_QPC 精确桥接
  let startWall = readyWall;
  const info = rec.info;
  if (info && info.readyTicks != null && info.startTicks != null && info.freq && info.readyPerf != null) {
    const readyQms = (info.readyTicks / info.freq) * 1000;
    const startQms = (info.startTicks / info.freq) * 1000;
    startWall = info.readyPerf + (startQms - readyQms);
  }

  const { samples, sampleRate: recRate } = readWavChannels(recPath);
  if (recRate !== sampleRate) {
    throw new Error(`录音采样率不一致: 期望 ${sampleRate}，实际 ${recRate}`);
  }
  const loopMatch = matchChirp(samples[0], template);
  const micMatch = matchChirp(samples[1], template);
  const loopMs = ((loopMatch.index + loopMatch.offset) / sampleRate) * 1000;
  const micMs = ((micMatch.index + micMatch.offset) / sampleRate) * 1000;
  const roundTripMs = micMs - loopMs; // 延迟：输出→麦克风

  // 含缓冲：播放启动(ffplay 音频时钟)→麦克风，与延迟同一次播放得出
  let chirpPlayWall;
  if (play.clockStart) {
    chirpPlayWall =
      play.clockStart.time + (leadSilence - play.clockStart.m) * 1000;
  } else {
    chirpPlayWall = play.startTime + leadSilence * 1000;
  }
  const bufferedMs = startWall + micMs - chirpPlayWall;

  let peak = 0;
  for (let i = 0; i < samples[1].length; i++) {
    const a = Math.abs(samples[1][i]);
    if (a > peak) peak = a;
  }
  const peakDb = 20 * Math.log10(peak || 1e-12);

  return {
    roundTripMs,
    bufferedMs,
    quality: micMatch.quality,
    significance: micMatch.significance,
    loopQuality: loopMatch.quality,
    loopMs,
    micMs,
    peakDb,
    files: { chirp: chirpPath, rec: recPath },
  };
}

/**
 * 单次测量。
 *
 * @param {object} cfg
 * @param {string} cfg.ffmpegPath
 * @param {string} cfg.ffplayPath
 * @param {string} cfg.inputDevice  录音（麦克风）设备名
 * @param {number} [cfg.sampleRate]
 * @param {number} [cfg.chirpDuration]   chirp 时长（秒），未指定 --audio 时使用
 * @param {string} [cfg.audioFile]       音频文件路径；指定后用它代替 chirp 作为测试信号
 * @param {number} [cfg.audioDuration]   音频模板时长（秒），仅截取文件开头（默认 2.0）
 * @param {number} [cfg.leadSilence]     测试信号前导静音（秒），给播放启动留缓冲
 * @param {number} [cfg.tailPad]         播放结束后多录多久，覆盖链路延迟余量（秒）
 * @param {number} [cfg.playbackLatency]  播放器开销（ms），从往返延迟中扣除（ffplay/SDL 缓冲等）
 * @param {'auto'|'loopback'|'mic'} [cfg.mode]  测量模式：loopback 双路 / mic 单路 / auto 自动回退（默认）
 * @param {string} [cfg.workDir]         临时文件目录
 * @returns {Promise<{ roundTripMs: number, quality: number, significance: number, peakDb: number, files: {chirp:string, rec:string} }>}
 */
export async function measureOnce({
  ffmpegPath,
  ffplayPath,
  inputDevice,
  sampleRate = DEFAULT_SAMPLE_RATE,
  chirpDuration = 0.5,
  audioFile = null,
  audioDuration = 2.0,
  leadSilence = 3.0,      // 覆盖 ffplay 启动 + 输出链路唤醒（蓝牙 A2DP 实测约 1.4s）
  tailPad = 2.5,          // 播放结束后多录多久，覆盖链路延迟余量（秒）
  playbackLatency = 0,    // 播放器开销（ffplay/SDL 音频缓冲），扣除后得纯声学往返
  mode = 'auto',
  workDir = os.tmpdir(),
} = {}) {
  // 测试信号模板：优先用音频文件（自然音乐对蓝牙感知编码更友好），否则用 chirp
  const template = audioFile
    ? decodeAudio(ffmpegPath, audioFile, { sampleRate, duration: audioDuration })
    : generateChirp({ sampleRate, duration: chirpDuration });
  if (template.length === 0) {
    throw new Error(audioFile ? `音频文件解码为空: ${audioFile}` : 'chirp 生成为空');
  }

  const leadSamples = Math.round(leadSilence * sampleRate);
  // 带前导静音的播放文件：静音 + 测试信号
  const playSignal = new Float32Array(leadSamples + template.length);
  playSignal.set(template, leadSamples);

  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const chirpPath = path.join(workDir, `latency-signal-${tag}.wav`);
  const recPath = path.join(workDir, `latency-rec-${tag}.wav`);

  writeWav(chirpPath, playSignal, sampleRate);

  // 录音时长 = 播放文件全长 + 尾部余量（麦克风启动延迟不占此预算，
  // 因为录音进程启动后我们会等到它真正开始采集才触发播放）。
  const duration = leadSilence + template.length / sampleRate + tailPad;

  const wantLoopback = mode === 'loopback' || mode === 'auto';
  if (wantLoopback) {
    try {
      return await measureLoopbackOnce({
        ffmpegPath,
        ffplayPath,
        inputDevice,
        sampleRate,
        template,
        chirpPath,
        recPath,
        leadSilence,
        tailPad,
      });
    } catch (err) {
      if (mode === 'loopback' || !err.message.startsWith('LOOPBACK_UNAVAILABLE')) {
        // 强制 loopback 或 loopback 内部错误：不再走 mic，清理已生成的临时信号
        try { fs.unlinkSync(chirpPath); } catch { /* ignore */ }
        try { fs.unlinkSync(recPath); } catch { /* ignore */ }
        throw err;
      }
      // auto 模式：loopback 不可用时回退到下面的旧模式继续执行
      console.warn('\n⚠ 当前默认播放设备不支持 loopback（常见于蓝牙耳机），已改用含缓冲模式。');
      console.warn('  测蓝牙净延迟请用引导式流程（默认），或 --reference 差分。\n');
    }
  }

  // 1. 先启动录音
  const rec = startRecording(ffmpegPath, {
    device: inputDevice,
    duration,
    outPath: recPath,
    sampleRate,
  });

  let play = null;
  try {
    // 2. 等麦克风真正开始采集（轮询数据区增长），而非固定延时
    const recStarted = await rec.waitUntilStarted();

    // 3. 启动播放。以麦克风开始采集的时刻（recStarted.time）作为录音基准；
    //    用 ffplay 音频时钟（observeClock）在播放结束后精确推算 chirp 开始播放的时刻。
    play = startPlayback(ffplayPath, chirpPath, { observeClock: true });

    // 4. 等待两者结束
    await play.promise;
    await rec.promise;

    // 5. 读录音并互相关
    const { samples: recSamples, sampleRate: recRate } = readWav(recPath);
    if (recRate !== sampleRate) {
      throw new Error(`录音采样率不一致: 期望 ${sampleRate}，实际 ${recRate}`);
    }

    const match = matchChirp(recSamples, template);

    // 录音峰值电平（dBFS），用于诊断音量过低 / 麦克风增益 / 回声消除抑制
    let peak = 0;
    for (let i = 0; i < recSamples.length; i++) {
      const a = Math.abs(recSamples[i]);
      if (a > peak) peak = a;
    }
    const peakDb = 20 * Math.log10(peak || 1e-12);

    // 时间戳对齐：
    //   chirp 到达麦克风的墙钟时刻 = 录音基准（采集开始 recStarted.time）+ 到达偏移 arrivalMs
    //   chirp 开始播放的墙钟时刻：优先用 ffplay 音频时钟（clockStart）推算，消掉进程启动延迟；
    //   否则回退到 spawn 时刻 + 前导静音。
    const arrivalMs = ((match.index + match.offset) / sampleRate) * 1000;
    const arrivalWall = recStarted.time + arrivalMs;
    let chirpPlayWall;
    if (play.clockStart) {
      // 音频时钟第一有效值 m0 在 wall time = clockStart.time；
      // 时钟以实时速率推进，故 M=leadSilence（chirp 开始）在 clockStart.time + (lead - m0)
      chirpPlayWall =
        play.clockStart.time + (leadSilence - play.clockStart.m) * 1000;
    } else {
      chirpPlayWall = play.startTime + leadSilence * 1000;
    }
    const tsOffsetMs = play.startTime - recStarted.time;
    // 端到端往返延迟 = chirp 到达墙钟 - chirp 播放墙钟 - 播放器额外开销
    // 剩余含 WASAPI 播放缓冲、麦克风采集缓冲与声学往返（--reference 差分可抵消系统偏置）。
    const roundTripMs = arrivalWall - chirpPlayWall - (playbackLatency ?? 0);

    return {
      roundTripMs,
      quality: match.quality,
      significance: match.significance,
      peakDb,
      arrivalMs,
      tsOffsetMs,
      files: { chirp: chirpPath, rec: recPath },
    };
  } catch (err) {
    // 任一环节失败都要停掉两边的子进程，并吞掉随后产生的 rejection
    if (play) {
      play.promise.catch(() => {});
      try { play.child.kill(); } catch { /* ignore */ }
    }
    rec.promise.catch(() => {});
    try { rec.child.kill(); } catch { /* ignore */ }
    throw err;
  }
}

/**
 * 多次测量，返回统计结果。
 *
 * 有效性判据（以"峰值显著性"为主，而非逐点波形相关）：
 *   - significance >= minSignificance（默认 20）：证明录音里确实有测试信号，
 *     即使波形被回声消除/降噪/蓝牙编码扭曲，其时频结构仍保留，PHAT 峰依然尖锐。
 *   - quality >= minQuality（默认 0.05）：辅助防线，排除"显著性虚高但波形完全无关"
 *     的窄带/谐波干扰（这类干扰的波形相关值接近 0）。
 * 两者都满足才判定为有效，不参与统计的测量标记为无效。
 *
 * @param {object} cfg
 * @param {number} [cfg.minQuality] 波形相关质量阈值（0..1，默认 0.05）
 * @param {number} [cfg.minSignificance] 峰值显著性阈值（默认 20）
 * @param {function} [cfg.onProgress] (i, result) => void
 * @returns {Promise<{ results: Array, valid: Array, medianMs, meanMs, stdMs, minMs, maxMs, validCount, total }>}
 */
export async function measureRepeated(cfg, times = 5, onProgress) {
  const minQuality = cfg.minQuality ?? 0.05;
  const minSignificance = cfg.minSignificance ?? 20;
  const results = [];
  for (let i = 0; i < times; i++) {
    let r;
    try {
      r = await measureOnce(cfg);
    } catch (err) {
      // 强制 loopback 模式下不可用/失败应直接暴露错误，而不是被统计成“无效”
      if (cfg.mode === 'loopback') throw err;
      // 其他模式：单次失败（ffmpeg/ffplay 抖动、设备暂时不可用）不中断整批测量
      r = {
        roundTripMs: null,
        quality: null,
        significance: null,
        peakDb: null,
        files: {},
        valid: false,
        error: err.message,
      };
    }
    const isLoopback = r.loopQuality != null;
    r.valid =
      r.quality != null &&
      r.significance != null &&
      r.roundTripMs != null &&
      r.quality >= minQuality &&
      r.significance >= minSignificance &&
      (!isLoopback ||
        ((r.loopQuality ?? 0) >= 0.5 && r.roundTripMs >= 5 && r.roundTripMs <= 500));
    results.push(r);
    if (onProgress) onProgress(i + 1, r);
  }

  const valid = results.filter((r) => r.valid);
  const ms = valid.map((r) => r.roundTripMs).sort((a, b) => a - b);

  if (ms.length === 0) {
    return {
      results,
      valid,
      medianMs: null,
      meanMs: null,
      stdMs: null,
      minMs: null,
      maxMs: null,
      validCount: 0,
      total: results.length,
    };
  }

  const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
  const variance = ms.length > 1
    ? ms.reduce((a, b) => a + (b - mean) ** 2, 0) / (ms.length - 1)
    : 0;
  const median = ms.length % 2 === 1
    ? ms[(ms.length - 1) / 2]
    : (ms[ms.length / 2 - 1] + ms[ms.length / 2]) / 2;

  return {
    results,
    valid,
    medianMs: median,
    meanMs: mean,
    stdMs: Math.sqrt(variance),
    minMs: ms[0],
    maxMs: ms[ms.length - 1],
    validCount: valid.length,
    total: results.length,
  };
}
