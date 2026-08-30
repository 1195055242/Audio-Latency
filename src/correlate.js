// correlate.js —— 基于 FFT 的互相关，用于在录音中定位 chirp 的到达时刻
//
// 互相关峰值的位置 = chirp 在录音中的起点偏移（样本数）。
// 频域互相关把 O(N*M) 降到 O(N log N)，对长录音也足够快。

/**
 * 原地 radix-2 复数 FFT（Cooley-Tukey，按位反转 + 蝶形）。
 * 输入长度必须是 2 的幂。
 *
 * @param {Float64Array} re 实部
 * @param {Float64Array} im 虚部
 * @param {number} [inverse] 1 = 正变换，-1 = 逆变换
 */
export function fft(re, im, inverse = 1) {
  const n = re.length;
  // 按位反转
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angle = (-2 * Math.PI * inverse) / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + half] * curRe - im[i + k + half] * curIm;
        const bIm = re[i + k + half] * curIm + im[i + k + half] * curRe;
        re[i + k] = aRe + bRe;
        im[i + k] = aIm + bIm;
        re[i + k + half] = aRe - bRe;
        im[i + k + half] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }

  if (inverse === -1) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/** 返回不小于 x 的最小 2 的幂 */
export function nextPow2(x) {
  let p = 1;
  while (p < x) p <<= 1;
  return p;
}

/**
 * 互相关：corr[k] = Σ signal[i] * template[i - k]
 * 当 template 在 signal 中从第 k 个样本开始出现时，corr[k] 达到峰值。
 *
 * @param {Float32Array|Array} signal 较长的信号（录音）
 * @param {Float32Array|Array} template 较短的模板（chirp）
 * @returns {Float64Array} 长度 = signal.length + template.length - 1 的相关系数
 */
export function crossCorrelate(signal, template) {
  const N = nextPow2(signal.length + template.length - 1);
  const sRe = new Float64Array(N);
  const sIm = new Float64Array(N);
  const tRe = new Float64Array(N);
  const tIm = new Float64Array(N);

  for (let i = 0; i < signal.length; i++) sRe[i] = signal[i];
  for (let i = 0; i < template.length; i++) tRe[i] = template[i];

  fft(sRe, sIm, 1);
  fft(tRe, tIm, 1);

  // 频域相乘：S * conj(T)
  for (let i = 0; i < N; i++) {
    const a = sRe[i];
    const b = sIm[i];
    const c = tRe[i];
    const d = tIm[i];
    sRe[i] = a * c + b * d;
    sIm[i] = b * c - a * d;
  }

  fft(sRe, sIm, -1);

  const len = signal.length + template.length - 1;
  const out = new Float64Array(len);
  for (let i = 0; i < len; i++) out[i] = sRe[i];
  return out;
}

/**
 * 在相关序列中定位峰值，并用抛物线插值得到亚样本精度的峰值位置。
 *
 * @param {Float64Array|Float32Array} corr 相关序列
 * @returns {{ index: number, offset: number, value: number }}
 *          offset = 亚样本精度的峰值位置（相对 index），value = 峰值处的相关值
 */
export function findPeak(corr) {
  let best = 0;
  let bestVal = -Infinity;
  for (let i = 0; i < corr.length; i++) {
    if (corr[i] > bestVal) {
      bestVal = corr[i];
      best = i;
    }
  }

  // 抛物线插值：用左右邻点拟合二次曲线求更精确的峰位
  let offset = 0;
  if (best > 0 && best < corr.length - 1) {
    const y0 = corr[best - 1];
    const y1 = corr[best];
    const y2 = corr[best + 1];
    const denom = y0 - 2 * y1 + y2;
    if (denom !== 0) {
      offset = 0.5 * (y0 - y2) / denom;
      if (offset < -1) offset = -1;
      if (offset > 1) offset = 1;
    }
  }

  return { index: best, offset, value: bestVal };
}

/**
 * 归一化互相关峰值（0..1），用于判断检测质量。
 * 1.0 = 完全匹配；数值越低表示匹配越差（噪声大、没录到等）。
 *
 * 分母使用"峰值位置对应的局部窗口能量"，而非整段信号能量，
 * 避免录音中的静音段稀释相关值。
 *
 * @param {Float32Array|Array} signal
 * @param {Float32Array|Array} template
 */
export function normalizedCorrelation(signal, template) {
  const corr = crossCorrelate(signal, template);
  const peak = findPeak(corr);
  const k = Math.round(peak.index + peak.offset);

  let num = 0;
  let sEnergy = 0;
  let tEnergy = 0;
  for (let i = 0; i < template.length; i++) {
    const s = signal[k + i] ?? 0;
    num += s * template[i];
    sEnergy += s * s;
    tEnergy += template[i] * template[i];
  }

  const denom = Math.sqrt(sEnergy * tEnergy);
  if (denom === 0) return 0;
  return num / denom;
}

/**
 * 相位变换加权互相关（GCC-PHAT）。
 *
 * 在频域把 S(f)·conj(T(f)) 除以自身幅度（白化），只保留相位信息，
 * 再逆变换回时域。这样对"频率响应整形"（蓝牙编解码/扬声器的高频衰减、
 * 均衡差异）不敏感——即使录音里 chirp 的高频被削掉，低频部分的相位结构
 * 仍能给出尖锐且位置准确的峰值，避免普通互相关在衰减下的峰值偏移。
 * 代价是低信噪比时噪声会被白化放大，因此质量判定需配合峰值显著性。
 *
 * @param {Float32Array|Array} signal 较长的信号（录音）
 * @param {Float32Array|Array} template 较短的模板（chirp）
 * @returns {Float64Array} 长度 = signal.length + template.length - 1
 */
export function crossCorrelatePhat(signal, template) {
  const N = nextPow2(signal.length + template.length - 1);
  const sRe = new Float64Array(N);
  const sIm = new Float64Array(N);
  const tRe = new Float64Array(N);
  const tIm = new Float64Array(N);

  for (let i = 0; i < signal.length; i++) sRe[i] = signal[i];
  for (let i = 0; i < template.length; i++) tRe[i] = template[i];

  fft(sRe, sIm, 1);
  fft(tRe, tIm, 1);

  for (let i = 0; i < N; i++) {
    const a = sRe[i];
    const b = sIm[i];
    const c = tRe[i];
    const d = tIm[i];
    const re = a * c + b * d;
    const im = b * c - a * d;
    const mag = Math.hypot(re, im) + 1e-12;
    sRe[i] = re / mag;
    sIm[i] = im / mag;
  }

  fft(sRe, sIm, -1);

  const len = signal.length + template.length - 1;
  const out = new Float64Array(len);
  for (let i = 0; i < len; i++) out[i] = sRe[i];
  return out;
}

/**
 * 在位置 k 处计算去均值的归一化互相关（demean NCC，0..1）。
 *
 * 相比 normalizedCorrelation，额外去除了窗口内均值（DC 偏置），
 * 对麦克风/ADC 的直流漂移与整体增益差异更鲁棒。用于衡量"录到的波形
 * 与模板的相似程度"，是检测质量的主判据。
 *
 * @param {Float32Array|Array} signal
 * @param {Float32Array|Array} template
 * @param {number} k 模板在 signal 中的起点（样本）
 * @returns {number} -1..1 的相关系数（质量场景通常取 0..1）
 */
export function demeanNcc(signal, template, k) {
  const n = template.length;
  let sumS = 0;
  let sumT = 0;
  for (let i = 0; i < n; i++) {
    sumS += signal[k + i] ?? 0;
    sumT += template[i];
  }
  const meanS = sumS / n;
  const meanT = sumT / n;

  let num = 0;
  let sE = 0;
  let tE = 0;
  for (let i = 0; i < n; i++) {
    const s = (signal[k + i] ?? 0) - meanS;
    const t = template[i] - meanT;
    num += s * t;
    sE += s * s;
    tE += t * t;
  }
  const denom = Math.sqrt(sE * tE);
  return denom === 0 ? 0 : num / denom;
}

/**
 * 按 ratio 对 signal 从 k 开始的片段做线性重采样，输出长度 = templateLength。
 *
 * ratio = 1 表示原样采样；ratio > 1 会把片段在时间轴上拉伸（降低离散频率），
 * ratio < 1 则压缩（升高离散频率）。用于补偿录音端与模板端采样时钟不一致
 * 造成的频偏，使波形相关（NCC）在存在 ±几十~几百 ppm 时钟偏移时仍能算准。
 *
 * @param {Float32Array|Array} signal
 * @param {number} templateLength 输出样本数
 * @param {number} k 片段在 signal 中的起点（样本）
 * @param {number} ratio 重采样比（目标时间轴 / 原始时间轴）
 * @returns {Float32Array}
 */
export function resampleSegment(signal, templateLength, k, ratio) {
  const out = new Float32Array(templateLength);
  for (let i = 0; i < templateLength; i++) {
    const src = k + i * ratio;
    const i0 = Math.floor(src);
    const frac = src - i0;
    const a = signal[i0] ?? 0;
    const b = signal[i0 + 1] ?? 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/**
 * 在 k 附近搜索最佳重采样比（±ppm），使重采样后的片段与模板的 demeanNcc 最大。
 *
 * 播放端与录音端的采样时钟通常有几十~上百 ppm 的偏差，chirp 越长，末端相位
 * 漂移越大，直接算 NCC 会偏低。这里在 ±ppm 范围内做一维搜索，返回补偿后的
 * 最佳 ratio 与 quality，用于替代未补偿的 demeanNcc 作为质量判据。
 *
 * @param {Float32Array|Array} signal
 * @param {Float32Array|Array} template
 * @param {number} k 模板在 signal 中的起点（样本）
 * @param {number} [ppm] 搜索范围（百万分之一，默认 200）
 * @param {number} [steps] 搜索步数（默认 41，约 10ppm 分辨率）
 * @returns {{ ratio: number, quality: number }}
 */
export function compensateRateOffsetNcc(signal, template, k, ppm = 200, steps = 41) {
  // PHAT 定位在有采样率偏移时会向漂移方向偏几个样本，因此除搜索 ratio 外，
  // 还要在 k 附近搜索一个小的整数样本修正量。
  const maxLag = Math.min(16, Math.ceil(template.length * ppm * 1e-6) + 4);
  let best = { ratio: 1, quality: demeanNcc(signal, template, k), kOffset: 0 };
  const start = 1 - ppm * 1e-6;
  const end = 1 + ppm * 1e-6;
  for (let i = 0; i < steps; i++) {
    const ratio = start + ((end - start) * i) / (steps - 1);
    for (let dk = -maxLag; dk <= maxLag; dk++) {
      const kk = k + dk;
      if (kk < 0) continue;
      const seg = resampleSegment(signal, template.length, kk, ratio);
      const q = demeanNcc(seg, template, 0);
      if (q > best.quality) {
        best = { ratio, quality: q, kOffset: dk };
      }
    }
  }
  return best;
}

/**
 * 峰值显著性：峰值与本底（远离峰值区域的均方根）之比。
 *
 * 真实 chirp 匹配时峰值远高于相关序列本底；而纯噪声/静音/窄带干扰下
 * 峰值只是随机起伏。用该指标作第二重 gate，排除"波形相关偶然偏高"的假阳性。
 *
 * @param {Float64Array|Float32Array} corr 相关序列
 * @param {{ index: number, value: number }} peak findPeak 的结果
 * @param {number} [guard] 峰值两侧视为主瓣、不参与本底统计的样本数
 * @returns {number}
 */
export function peakSignificance(corr, peak, guard = 3000) {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < corr.length; i++) {
    if (Math.abs(i - peak.index) > guard) {
      sum += corr[i] * corr[i];
      n++;
    }
  }
  const rms = n > 0 ? Math.sqrt(sum / n) : 0;
  return peak.value / (rms || 1e-12);
}

/**
 * 一站式鲁棒匹配：PHAT 互相关定位 chirp 到达位置，并给出质量与显著性。
 *
 * @param {Float32Array|Array} signal 录音样本
 * @param {Float32Array|Array} template chirp 模板
 * @returns {{ index: number, offset: number, quality: number, significance: number }}
 *          index/offset = 亚样本精度的到达样本位置（同 findPeak 约定），
 *          quality = 去均值 NCC（0..1），significance = 峰值显著性。
 */
export function matchChirp(signal, template) {
  const corr = crossCorrelatePhat(signal, template);
  const peak = findPeak(corr);
  const k = Math.round(peak.index + peak.offset);
  const quality = demeanNcc(signal, template, k);
  const significance = peakSignificance(corr, peak);
  return { index: peak.index, offset: peak.offset, quality, significance };
}
