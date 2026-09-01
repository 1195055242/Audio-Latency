// test/correlate.test.js —— 用合成信号验证互相关定位精度
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateChirp, writeWav, readWav } from '../src/signal.js';
import {
  crossCorrelate,
  findPeak,
  nextPow2,
  fft,
  crossCorrelatePhat,
  demeanNcc,
  peakSignificance,
  matchChirp,
  resampleSegment,
  compensateRateOffsetNcc,
  bandpassFilter,
} from '../src/correlate.js';

test('fft: 逆变换能还原输入（round-trip）', () => {
  const n = 8;
  const re = new Float64Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const im = new Float64Array(n);
  fft(re, im, 1);
  fft(re, im, -1);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(re[i] - (i + 1)) < 1e-9, `re[${i}] = ${re[i]}`);
    assert.ok(Math.abs(im[i]) < 1e-9);
  }
});

test('nextPow2 返回不小于输入的最小 2 的幂', () => {
  assert.equal(nextPow2(1), 1);
  assert.equal(nextPow2(5), 8);
  assert.equal(nextPow2(1000), 1024);
});

test('互相关能在已知偏移处定位 chirp', () => {
  const rate = 48000;
  const chirp = generateChirp({ sampleRate: rate, duration: 0.1 });
  // 构造录音：5000 样本静音 + chirp + 静音
  const offset = 5000;
  const signal = new Float32Array(offset + chirp.length + 1000);
  signal.set(chirp, offset);

  const corr = crossCorrelate(signal, chirp);
  const peak = findPeak(corr);
  assert.ok(Math.abs(peak.index - offset) <= 1, `index=${peak.index} 期望 ${offset}`);
});

test('WAV 写入再读取往返一致', () => {
  const rate = 44100;
  const samples = generateChirp({ sampleRate: rate, duration: 0.05 });
  const path = `${process.env.TEMP || '/tmp'}/latency-roundtrip-${Date.now()}.wav`;
  writeWav(path, samples, rate);
  const { samples: back, sampleRate } = readWav(path);
  assert.equal(sampleRate, rate);
  assert.equal(back.length, samples.length);
  for (let i = 0; i < samples.length; i++) {
    // 16-bit 量化误差 < 1/32767
    assert.ok(Math.abs(back[i] - samples[i]) < 2 / 32767, `i=${i}`);
  }
  fs.unlinkSync(path);
});

test('亚样本插值：真实峰值位于整数样本之间也能估算', () => {
  // 构造一个对称三角峰，其真峰在两样本之间
  const corr = new Float64Array([0, 0, 0.5, 1.0, 0.5, 0, 0]);
  const peak = findPeak(corr);
  assert.equal(peak.index, 3);
  assert.ok(Math.abs(peak.offset) < 1e-6, '对称峰 offset 应为 0');
});

// —— 以下是针对"声音质量对比/定位"鲁棒性新增的测试 ——

// 工具函数：对 [offset, offset+len) 区间做一阶 IIR 低通，模拟蓝牙/扬声器的高频滚降
// （alpha 越小截止频率越低：a=0.3≈8kHz、a=0.15≈4kHz、a=0.1≈2.7kHz @48k）
function iirLowpassInPlace(sig, offset, len, alpha) {
  let prev = 0;
  for (let i = offset; i < offset + len; i++) {
    prev = prev + alpha * (sig[i] - prev);
    sig[i] = prev;
  }
}

// 工具函数：确定性伪随机噪声
function addNoiseInPlace(sig, offset, len, amp, seed = 42) {
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5;
  for (let i = offset; i < offset + len; i++) sig[i] += rnd() * amp;
}

test('GCC-PHAT 在高频衰减下定位精度不低于普通互相关', () => {
  const rate = 48000;
  const chirp = generateChirp({ sampleRate: rate, duration: 0.2, f0: 500, f1: 8000 });
  const offset = 8000;
  const signal = new Float32Array(offset + chirp.length + 4000);
  signal.set(chirp, offset);
  iirLowpassInPlace(signal, offset, chirp.length, 0.1); // 约 2.7kHz 截止，较狠

  const corr = crossCorrelate(signal, chirp);
  const corrPeak = findPeak(corr);
  const phat = crossCorrelatePhat(signal, chirp);
  const phatPeak = findPeak(phat);

  const corrErr = Math.abs(corrPeak.index + corrPeak.offset - offset);
  const phatErr = Math.abs(phatPeak.index + phatPeak.offset - offset);
  assert.ok(phatErr <= 3, `PHAT 定位误差过大: ${phatErr} 样本`);
  assert.ok(phatErr <= corrErr + 1e-9, `PHAT 应不差于普通相关（PHAT ${phatErr} vs 普通 ${corrErr}）`);
});

test('matchChirp 在衰减+噪声下质量与显著性均通过阈值', () => {
  const rate = 48000;
  const chirp = generateChirp({ sampleRate: rate, duration: 0.2, f0: 500, f1: 8000 });
  const offset = 8000;
  const signal = new Float32Array(offset + chirp.length + 4000);
  signal.set(chirp, offset);
  iirLowpassInPlace(signal, offset, chirp.length, 0.1); // 约 2.7kHz 截止
  addNoiseInPlace(signal, offset, chirp.length, 0.2);

  const m = matchChirp(signal, chirp);
  assert.ok(Math.abs(m.index + m.offset - offset) <= 3, `定位误差: ${m.index - offset}`);
  assert.ok(m.quality >= 0.05, `相关过低: ${m.quality}`);
  assert.ok(m.significance >= 35, `显著性过低: ${m.significance}`);
});

test('无信号（静音/纯噪声/窄带谐波）不会被误判为有效', () => {
  const rate = 48000;
  const chirp = generateChirp({ sampleRate: rate, duration: 0.2, f0: 500, f1: 8000 });
  const n = 8000 + chirp.length + 4000;

  const silence = new Float32Array(n);
  const mSil = matchChirp(silence, chirp);
  assert.ok(mSil.quality < 0.05 && mSil.significance < 35, `静音误判: q=${mSil.quality} s=${mSil.significance}`);

  const noise = new Float32Array(n);
  addNoiseInPlace(noise, 0, n, 0.3, 7);
  const mNoise = matchChirp(noise, chirp);
  assert.ok(
    mNoise.quality < 0.05 || mNoise.significance < 35,
    `纯噪声误判: q=${mNoise.quality} s=${mNoise.significance}`
  );

  // 窄带谐波干扰：显著性低于 35、相关接近 0，双重判据均应拒绝
  const hum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = 0;
    for (let h = 1; h <= 6; h++) v += Math.sin((2 * Math.PI * 200 * h * i) / rate) / h;
    hum[i] = 0.8 * v;
  }
  const mHum = matchChirp(hum, chirp);
  assert.ok(
    mHum.quality < 0.05 || mHum.significance < 35,
    `谐波干扰误判: q=${mHum.quality} s=${mHum.significance}`
  );
});

// 按 ratio 对模板做线性伸缩，模拟录音端采样时钟与模板不一致（ratio>1 表示录音端时钟更快）
function stretchArray(src, ratio) {
  const len = Math.round(src.length * ratio);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = src[i0] ?? 0;
    const b = src[i0 + 1] ?? 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

test('compensateRateOffsetNcc 能补偿采样时钟偏移并提高相关', () => {
  const rate = 48000;
  const chirp = generateChirp({ sampleRate: rate, duration: 0.5, f0: 500, f1: 8000 });
  const r = 1 + 150e-6; // 录音端采样时钟快 150ppm
  const recChirp = stretchArray(chirp, r);
  const offset = 8000;
  const signal = new Float32Array(offset + recChirp.length + 4000);
  signal.set(recChirp, offset);

  const m = matchChirp(signal, chirp);
  const k = Math.round(m.index + m.offset);
  const plain = demeanNcc(signal, chirp, k);
  const comp = compensateRateOffsetNcc(signal, chirp, k, 300, 61);

  assert.ok(comp.quality > plain, `补偿后相关应更高: comp=${comp.quality.toFixed(3)} plain=${plain.toFixed(3)}`);
  assert.ok(comp.quality > 0.9, `补偿后相关应接近 1: ${comp.quality.toFixed(3)}`);
  assert.ok(Math.abs(comp.ratio - r) < 3e-5, `估计重采样比应接近 ${r}: ${comp.ratio}`);
});

test('bandpassFilter 能抑制低频噪声和高频衰减，提高 NCC', () => {
  const rate = 48000;
  const chirp = generateChirp({ sampleRate: rate, duration: 0.5, f0: 500, f1: 8000 });

  // 模拟蓝牙/扬声器：强低通 + 噪声 + 120Hz 低频嗡嗡声
  const rec = new Float32Array(chirp.length);
  rec.set(chirp);
  iirLowpassInPlace(rec, 0, rec.length, 0.07); // 很狠的低通
  addNoiseInPlace(rec, 0, rec.length, 0.25, 7);
  for (let i = 0; i < rec.length; i++) rec[i] += 0.4 * Math.sin((2 * Math.PI * 120 * i) / rate);

  const plain = demeanNcc(rec, chirp, 0);
  const bpRec = bandpassFilter(rec, rate, 400, 4000);
  const bpChirp = bandpassFilter(chirp, rate, 400, 4000);
  const band = demeanNcc(bpRec, bpChirp, 0);

  assert.ok(band > plain, `带通后 NCC 应更高: band=${band.toFixed(3)} plain=${plain.toFixed(3)}`);
  assert.ok(band > 0.15, `带通后 NCC 应过 0.15: ${band.toFixed(3)}`);
});
