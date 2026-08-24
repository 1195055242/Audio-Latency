param(
  [string]$Out,
  [double]$Duration = 5,
  [string]$CaptureName = ""
)
# WASAPI dual capture: channel 0 = system render loopback, channel 1 = microphone.
# Prints READY once both capture clients have started; writes a 48k stereo 16-bit WAV.

$ErrorActionPreference = 'Stop'
$src = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class LoopbackRec {
  enum EDataFlow { eRender = 0, eCapture = 1, eAll = 2 }
  enum ERole { eConsole = 0, eMultimedia = 1, eCommunications = 2 }

  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
  class MMDeviceEnumeratorComObject { }

  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(EDataFlow dataFlow, uint stateMask, out IMMDeviceCollection devices);
    [PreserveSig] int GetDefaultAudioEndpoint(EDataFlow dataFlow, ERole role, out IMMDevice endpoint);
  }

  [Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceCollection {
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint index, out IMMDevice device);
  }

  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, uint dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    [PreserveSig] int OpenPropertyStore(uint stgmAccess, out IPropertyStore properties);
  }

  [Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IPropertyStore {
    [PreserveSig] int GetCount(out uint c);
    [PreserveSig] int GetAt(uint i, out PROPERTYKEY k);
    [PreserveSig] int GetValue(ref PROPERTYKEY k, out PROPVARIANT v);
    [PreserveSig] int SetValue(ref PROPERTYKEY k, ref PROPVARIANT v);
    [PreserveSig] int Commit();
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROPERTYKEY { public Guid fmtid; public uint pid; }

  [StructLayout(LayoutKind.Sequential, Size = 24)]
  struct PROPVARIANT {
    public ushort vt;
    public ushort wReserved1, wReserved2, wReserved3;
    public IntPtr pwszVal;
    public IntPtr pad;
  }

  [DllImport("ole32.dll")] static extern int PropVariantClear(ref PROPVARIANT pvar);

  [Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioClient {
    [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr audioSessionGuid);
    [PreserveSig] int GetBufferSize(out uint numBufferFrames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint numPaddingFrames);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
    [PreserveSig] int GetMixFormat(out IntPtr deviceFormat);
    [PreserveSig] int GetDevicePeriod(out long defaultDevicePeriod, out long minimumDevicePeriod);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr eventHandle);
    [PreserveSig] int GetService(ref Guid riid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
  }

  [Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioCaptureClient {
    [PreserveSig] int GetBuffer(out IntPtr data, out uint numFramesToRead, out uint bufferFlags, out long devicePosition, out long qpcPosition);
    [PreserveSig] int ReleaseBuffer(uint numFramesRead);
    [PreserveSig] int GetNextPacketSize(out uint numFramesInNextPacket);
  }

  [StructLayout(LayoutKind.Sequential)]
  struct WAVEFORMATEX {
    public ushort wFormatTag;
    public ushort nChannels;
    public uint nSamplesPerSec;
    public uint nAvgBytesPerSec;
    public ushort nBlockAlign;
    public ushort wBitsPerSample;
    public ushort cbSize;
  }

  [DllImport("kernel32.dll")] static extern bool QueryPerformanceFrequency(out long freq);
  [DllImport("kernel32.dll")] static extern bool QueryPerformanceCounter(out long count);

  class Packet {
    public double t0;
    public float[] mono;
    public int rate;
    public double End { get { return t0 + (double)mono.Length / rate; } }
  }

  static void Check(int hr) { if (hr != 0) throw new Exception("HRESULT 0x" + hr.ToString("X8")); }

  static void Log(string s) { Console.Error.WriteLine(s); Console.Error.Flush(); }

  static string FriendlyName(IMMDevice dev) {
    IPropertyStore store;
    dev.OpenPropertyStore(0, out store);
    var key = new PROPERTYKEY { fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"), pid = 14 };
    PROPVARIANT pv;
    store.GetValue(ref key, out pv);
    string name = null;
    if (pv.pwszVal != IntPtr.Zero) name = Marshal.PtrToStringUni(pv.pwszVal);
    PropVariantClear(ref pv);
    return name;
  }

  static IMMDevice FindCaptureDevice(IMMDeviceEnumerator e, string sub) {
    IMMDeviceCollection coll;
    e.EnumAudioEndpoints(EDataFlow.eCapture, 1, out coll);
    uint n;
    coll.GetCount(out n);
    for (uint i = 0; i < n; i++) {
      IMMDevice dev;
      coll.Item(i, out dev);
      string name = FriendlyName(dev);
      if (name != null && (name.IndexOf(sub, StringComparison.OrdinalIgnoreCase) >= 0
          || sub.IndexOf(name, StringComparison.OrdinalIgnoreCase) >= 0)) return dev;
    }
    return null;
  }

  static float[] ToMono(IntPtr data, uint frames, WAVEFORMATEX fmt) {
    int ch = fmt.nChannels;
    var o = new float[frames];
    if (fmt.wBitsPerSample == 32) {
      var buf = new float[frames * ch];
      Marshal.Copy(data, buf, 0, buf.Length);
      for (int i = 0; i < frames; i++) {
        float s = 0; for (int c = 0; c < ch; c++) s += buf[i * ch + c];
        o[i] = s / ch;
      }
    } else if (fmt.wBitsPerSample == 16) {
      var buf = new short[frames * ch];
      Marshal.Copy(data, buf, 0, buf.Length);
      for (int i = 0; i < frames; i++) {
        float s = 0; for (int c = 0; c < ch; c++) s += buf[i * ch + c] / 32768f;
        o[i] = s / ch;
      }
    } else {
      throw new Exception("Unsupported bits per sample: " + fmt.wBitsPerSample);
    }
    return o;
  }

  static void Drain(IAudioCaptureClient cap, WAVEFORMATEX fmt, double qpcPerSec, List<Packet> list, ref long firstQpc, ref bool haveFirst) {
    while (true) {
      uint n;
      int hr = cap.GetNextPacketSize(out n);
      if (hr != 0 || n == 0) return;
      IntPtr data;
      uint frames;
      uint flags;
      long devPos;
      long qpc;
      hr = cap.GetBuffer(out data, out frames, out flags, out devPos, out qpc);
      if (hr != 0) return;
      if (!haveFirst) { firstQpc = qpc; haveFirst = true; }
      float[] mono = ToMono(data, frames, fmt);
      list.Add(new Packet { t0 = qpc / qpcPerSec, mono = mono, rate = (int)fmt.nSamplesPerSec });
      cap.ReleaseBuffer(frames);
    }
  }

  static float[] Resample(List<Packet> pkts, double t0, int outLen) {
    var o = new float[outLen];
    int p = 0;
    for (int i = 0; i < outLen; i++) {
      double t = t0 + (double)i / 48000.0;
      while (p < pkts.Count - 1 && t > pkts[p].End) p++;
      if (p >= pkts.Count) break;
      if (t < pkts[p].t0) continue;
      double local = (t - pkts[p].t0) * pkts[p].rate;
      int idx = (int)local;
      if (idx < 0) idx = 0;
      if (idx >= pkts[p].mono.Length) idx = pkts[p].mono.Length - 1;
      if (idx + 1 < pkts[p].mono.Length) {
        float f = (float)(local - idx);
        o[i] = pkts[p].mono[idx] * (1f - f) + pkts[p].mono[idx + 1] * f;
      } else {
        o[i] = pkts[p].mono[idx];
      }
    }
    return o;
  }

  static void WriteWavStereo(string path, float[] l, float[] r, int rate) {
    int n = Math.Min(l.Length, r.Length);
    int dataSize = n * 4;
    using (var fs = File.Create(path)) {
      var bw = new BinaryWriter(fs);
      bw.Write(System.Text.Encoding.ASCII.GetBytes("RIFF"));
      bw.Write(36 + dataSize);
      bw.Write(System.Text.Encoding.ASCII.GetBytes("WAVE"));
      bw.Write(System.Text.Encoding.ASCII.GetBytes("fmt "));
      bw.Write(16);
      bw.Write((short)1);
      bw.Write((short)2);
      bw.Write(rate);
      bw.Write(rate * 4);
      bw.Write((short)4);
      bw.Write((short)16);
      bw.Write(System.Text.Encoding.ASCII.GetBytes("data"));
      bw.Write(dataSize);
      for (int i = 0; i < n; i++) {
        bw.Write((short)(Math.Max(-1f, Math.Min(1f, l[i])) * 32767));
        bw.Write((short)(Math.Max(-1f, Math.Min(1f, r[i])) * 32767));
      }
    }
  }

  public static int Run(string outPath, double duration, string captureName) {
    var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
    var iidAudioClient = new Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2");
    var iidCaptureClient = new Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317");

    IMMDevice renderDev;
    Check(enumerator.GetDefaultAudioEndpoint(EDataFlow.eRender, ERole.eConsole, out renderDev));
    Log("render: " + FriendlyName(renderDev));
    object oRender;
    Check(renderDev.Activate(ref iidAudioClient, 23, IntPtr.Zero, out oRender));
    var renderClient = (IAudioClient)oRender;
    IntPtr renderFmtPtr;
    Check(renderClient.GetMixFormat(out renderFmtPtr));
    var renderFmt = (WAVEFORMATEX)Marshal.PtrToStructure(renderFmtPtr, typeof(WAVEFORMATEX));
    Log("render mix: rate=" + renderFmt.nSamplesPerSec + " ch=" + renderFmt.nChannels + " bits=" + renderFmt.wBitsPerSample + " tag=" + renderFmt.wFormatTag);
    Log("render Initialize(loopback)...");
    try {
      Check(renderClient.Initialize(0, 0x00020000, 10000000, 0, renderFmtPtr, IntPtr.Zero));
    } catch (Exception ex) {
      throw new Exception("loopback 不可用（默认播放设备可能是不支持 WASAPI loopback 的端点，如蓝牙耳机）: " + ex.Message);
    }
    Log("render Initialize ok");
    object oRenderCap;
    Check(renderClient.GetService(ref iidCaptureClient, out oRenderCap));
    var renderCap = (IAudioCaptureClient)oRenderCap;

    IMMDevice capDev = null;
    if (!string.IsNullOrEmpty(captureName)) capDev = FindCaptureDevice(enumerator, captureName);
    if (capDev == null) {
      Check(enumerator.GetDefaultAudioEndpoint(EDataFlow.eCapture, ERole.eConsole, out capDev));
    }
    Log("capture: " + FriendlyName(capDev));
    object oCap;
    Check(capDev.Activate(ref iidAudioClient, 23, IntPtr.Zero, out oCap));
    var capClient = (IAudioClient)oCap;
    IntPtr capFmtPtr;
    Check(capClient.GetMixFormat(out capFmtPtr));
    var capFmt = (WAVEFORMATEX)Marshal.PtrToStructure(capFmtPtr, typeof(WAVEFORMATEX));
    Log("capture mix: rate=" + capFmt.nSamplesPerSec + " ch=" + capFmt.nChannels + " bits=" + capFmt.wBitsPerSample + " tag=" + capFmt.wFormatTag);
    Log("capture Initialize...");
    Check(capClient.Initialize(0, 0, 10000000, 0, capFmtPtr, IntPtr.Zero));
    Log("capture Initialize ok");
    object oCapCap;
    Check(capClient.GetService(ref iidCaptureClient, out oCapCap));
    var capCap = (IAudioCaptureClient)oCapCap;

    long qpcFreq;
    QueryPerformanceFrequency(out qpcFreq);

    Check(renderClient.Start());
    Check(capClient.Start());

    var lp = new List<Packet>();
    var mp = new List<Packet>();
    long renderFirstQpc = 0; bool haveRenderFirst = false;
    long micFirstQpc = 0; bool haveMicFirst = false;

    // 等麦克风首帧，把录音起点锚定在麦克风首帧 QPC，再发 READY
    var swReady = Stopwatch.StartNew();
    while (!haveMicFirst) {
      Drain(renderCap, renderFmt, qpcFreq, lp, ref renderFirstQpc, ref haveRenderFirst);
      Drain(capCap, capFmt, qpcFreq, mp, ref micFirstQpc, ref haveMicFirst);
      Thread.Sleep(5);
      if (swReady.Elapsed.TotalSeconds > 10) break;
    }
    Console.WriteLine("READY " + Stopwatch.GetTimestamp() + " " + Stopwatch.Frequency);
    Console.Out.Flush();

    var sw = Stopwatch.StartNew();
    while (true) {
      Drain(renderCap, renderFmt, qpcFreq, lp, ref renderFirstQpc, ref haveRenderFirst);
      Drain(capCap, capFmt, qpcFreq, mp, ref micFirstQpc, ref haveMicFirst);
      Thread.Sleep(5);
      if (sw.Elapsed.TotalSeconds >= duration) break;
      if (sw.Elapsed.TotalSeconds > duration + 15) break;
    }
    Check(renderClient.Stop());
    Check(capClient.Stop());

    Console.WriteLine("START_QPC " + micFirstQpc + " FREQ " + Stopwatch.Frequency);
    Console.Out.Flush();

    double t0 = haveMicFirst ? (micFirstQpc / (double)qpcFreq) : 0.0;

    int outLen = (int)(duration * 48000);
    var left = Resample(lp, t0, outLen);
    var right = Resample(mp, t0, outLen);
    WriteWavStereo(outPath, left, right, 48000);
    return 0;
  }
}
'@

Add-Type -TypeDefinition $src
[LoopbackRec]::Run($Out, $Duration, $CaptureName)
