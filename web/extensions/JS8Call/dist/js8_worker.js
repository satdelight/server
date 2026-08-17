// ============================================================
// js8_worker.js — Self-contained pure-JS JS8Call decoder worker.
// Copyright 2026 by Holger Nyga — https://github.com/satdelight
//
//   1. Costas pattern for Normal mode is [4,2,5,6,1,3,0]
//      (Costas::ORIGINAL), NOT the FT8 pattern [2,5,6,0,4,1,3].
//   2. LDPC is the JS8 (174,87) code with M=87 check nodes
//      (bpdecode174), NOT the FT8 (174,91) code with 83 checks.
//   3. Message is 87 bits = 72 payload (12x6-bit alphabet) + 3
//      frame type + 12 CRC-12; unpacking follows
//      extractmessage174 / chkcrc12a.
//   4. CRC-12 is the boost::augmented_crc<12,0xc06> algorithm as
//      used by JS8Call (crc12.cpp), incl. the ^42.
//   5. LLR extraction is max-based per bit (r4/r2/r1), not a
//      per-8-tone soft/Gray map.
//
// Protocol:
//   In : { type:'start', mode, freqMin, freqMax }
//        { type:'audio', buffer:ArrayBuffer }  // 4-byte LE ts + Int16 PCM
//        { type:'set-mode', mode }
//        { type:'stop' }
//   Out: { type:'ready', wasm:false, msg }
//        { type:'decoded', messages:[], slotTime }
//        { type:'error', msg }
//
// Speed modes: 0=Slow(30s) 1=Normal(15.6s) 2=Fast(10s) 3=Turbo(6s)
// ============================================================

// The Kiwi server appends a version-check footer ("kiwi_check_js_version.push(...)")
// to every .js file it serves (web.cpp). In a Web Worker's isolated global scope
// that variable does not exist, so declare it here to keep the footer from throwing.
var kiwi_check_js_version = kiwi_check_js_version || [];

var SAMPLE_RATE = 12000;

// ---- LDPC tables (parsed from official JS8Call JS8.cpp bpdecode174) ----
// Mn: 174 variable nodes x 3 checks each
// Nm: 87 check nodes (valid_neighbors, neighbors[])
var LDPC_N = 174, LDPC_M = 87, LDPC_K = 87, LDPC_MAX_ITER = 30;
var LDPC_Mn = new Int16Array([
  0,24,68, 1,4,72, 2,31,67, 3,50,60, 5,62,69, 6,32,78,
  7,49,85, 8,36,42, 9,40,64, 10,13,63, 11,74,76, 12,22,80,
  14,15,81, 16,55,65, 17,52,59, 18,30,51, 19,66,83, 20,28,71,
  21,23,43, 25,34,75, 26,35,37, 27,39,41, 29,53,54, 33,48,86,
  38,56,57, 44,73,82, 45,61,79, 46,47,84, 58,70,77, 0,49,52,
  1,46,83, 2,24,78, 3,5,13, 4,6,79, 7,33,54, 8,35,68,
  9,42,82, 10,22,73, 11,16,43, 12,56,75, 14,26,55, 15,27,28,
  17,18,58, 19,39,62, 20,34,51, 21,53,63, 23,61,77, 25,31,76,
  29,71,84, 30,64,86, 32,38,50, 36,47,74, 37,69,70, 40,41,67,
  44,66,85, 45,80,81, 48,65,72, 57,59,65, 60,64,84, 0,13,20,
  1,12,58, 2,66,81, 3,31,72, 4,35,53, 5,42,45, 6,27,74,
  7,32,70, 8,48,75, 9,57,63, 10,47,67, 11,18,44, 14,49,60,
  15,21,25, 16,71,79, 17,39,54, 19,34,50, 22,24,33, 23,62,86,
  26,38,73, 28,77,82, 29,69,76, 30,68,83, 21,36,85, 37,40,80,
  41,43,56, 46,52,61, 51,55,78, 59,74,80, 0,38,76, 1,15,40,
  2,30,53, 3,35,77, 4,44,64, 5,56,84, 6,13,48, 7,20,45,
  8,14,71, 9,19,61, 10,16,70, 11,33,46, 12,67,85, 17,22,42,
  18,63,72, 23,47,78, 24,69,82, 25,79,86, 26,31,39, 27,55,68,
  28,62,65, 29,41,49, 32,36,81, 34,59,73, 37,54,83, 43,51,60,
  50,52,71, 57,58,66, 46,55,75, 0,18,36, 1,60,74, 2,7,65,
  3,59,83, 4,33,38, 5,25,52, 6,31,56, 8,51,66, 9,11,14,
  10,50,68, 12,13,64, 15,30,42, 16,19,35, 17,79,85, 20,47,58,
  21,39,45, 22,32,61, 23,29,73, 24,41,63, 26,48,84, 27,37,72,
  28,43,80, 34,67,69, 40,62,75, 44,48,70, 49,57,86, 47,53,82,
  12,54,78, 76,77,81, 0,1,23, 2,5,74, 3,55,86, 4,43,52,
  6,49,82, 7,9,27, 8,54,61, 10,28,66, 11,32,39, 13,15,19,
  14,34,72, 16,30,38, 17,35,56, 18,45,75, 20,41,83, 21,33,58,
  22,25,60, 24,59,64, 26,63,79, 29,36,65, 31,44,71, 37,50,85,
  40,76,78, 42,55,67, 46,73,81, 39,51,77, 53,60,70, 45,57,68
]);
var LDPC_NmNeigh = new Int16Array([
  0,29,59,88,117,146,0, 1,30,60,89,118,146,0, 2,31,61,90,119,147,0,
  3,32,62,91,120,148,0, 1,33,63,92,121,149,0, 4,32,64,93,122,147,0,
  5,33,65,94,123,150,0, 6,34,66,95,119,151,0, 7,35,67,96,124,152,0,
  8,36,68,97,125,151,0, 9,37,69,98,126,153,0, 10,38,70,99,125,154,0,
  11,39,60,100,127,144,0, 9,32,59,94,127,155,0, 12,40,71,96,125,156,0,
  12,41,72,89,128,155,0, 13,38,73,98,129,157,0, 14,42,74,101,130,158,0,
  15,42,70,102,117,159,0, 16,43,75,97,129,155,0, 17,44,59,95,131,160,0,
  18,45,72,82,132,161,0, 11,37,76,101,133,162,0, 18,46,77,103,134,146,0,
  0,31,76,104,135,163,0, 19,47,72,105,122,162,0, 20,40,78,106,136,164,0,
  21,41,65,107,137,151,0, 17,41,79,108,138,153,0, 22,48,80,109,134,165,0,
  15,49,81,90,128,157,0, 2,47,62,106,123,166,0, 5,50,66,110,133,154,0,
  23,34,76,99,121,161,0, 19,44,75,111,139,156,0, 20,35,63,91,129,158,0,
  7,51,82,110,117,165,0, 20,52,83,112,137,167,0, 24,50,78,88,121,157,0,
  21,43,74,106,132,154,171, 8,53,83,89,140,168,0, 21,53,84,109,135,160,0,
  7,36,64,101,128,169,0, 18,38,84,113,138,149,0, 25,54,70,92,141,166,0,
  26,55,64,95,132,159,173, 27,30,85,99,116,170,0, 27,51,69,103,131,143,0,
  23,56,67,94,136,141,0, 6,29,71,109,142,150,0, 3,50,75,114,126,167,0,
  15,44,86,113,124,171,0, 14,29,85,114,122,149,0, 22,45,63,90,143,172,0,
  22,34,74,112,144,152,0, 13,40,86,107,116,148,169, 24,39,84,93,123,158,0,
  24,57,68,115,142,173,0, 28,42,60,115,131,161,0, 14,57,87,111,120,163,0,
  3,58,71,113,118,162,172, 26,46,85,97,133,152,0, 4,43,77,108,140,0,0,
  9,45,68,102,135,164,0, 8,49,58,92,127,163,0, 13,56,57,108,119,165,0,
  16,54,61,115,124,153,0, 2,53,69,100,139,169,0, 0,35,81,107,126,173,0,
  4,52,80,104,139,0,0, 28,52,66,98,141,172,0, 17,48,73,96,114,166,0,
  1,56,62,102,137,156,0, 25,37,78,111,134,170,0, 10,51,65,87,118,147,0,
  19,39,67,116,140,159,0, 10,47,80,88,145,168,0, 28,46,79,91,145,171,0,
  5,31,86,103,144,168,0, 26,33,73,105,130,164,0, 11,55,83,87,138,0,0,
  12,55,61,110,145,170,0, 25,36,79,104,143,150,0, 16,30,81,112,120,160,0,
  27,48,58,93,136,0,0, 6,54,82,100,130,167,0, 23,49,77,105,142,148,0
]);
var LDPC_NmLen = new Int8Array([
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,
  6,6,6,6,6,6,6,6,6,6,6,6,6,6,6,7,6,6,6,6,6,7,6,6,
  6,6,6,6,6,6,6,7,6,6,6,6,7,6,5,6,6,6,6,6,6,5,6,6,
  6,6,6,6,6,6,6,6,5,6,6,6,5,6,6
]);

var COSTAS_TONES = [4, 2, 5, 6, 1, 3, 0];
var SYNC_POS     = [0,1,2,3,4,5,6, 36,37,38,39,40,41,42, 72,73,74,75,76,77,78];

var ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-+";

// ---- speed modes (fft size in samples per symbol @12 kHz) ----
var MODES = [
  { fft: 3840, slotSamples:  30 * SAMPLE_RATE },  // Slow
  { fft: 1920, slotSamples:  Math.round(15.6 * SAMPLE_RATE) }, // Normal
  { fft:  960, slotSamples:  10 * SAMPLE_RATE },  // Fast
  { fft:  480, slotSamples:   6 * SAMPLE_RATE },  // Turbo
];

// ---- power-of-two radix-2 FFT core (inverse = negative twiddle angle) ----
function fftPow2(re, im, n, inverse) {
  for (var i = 1, j = 0; i < n; i++) {
    var bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      var t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (var len = 2; len <= n; len <<= 1) {
    var ang = (inverse ? 2 : -2) * Math.PI / len;
    var wr = Math.cos(ang), wi = Math.sin(ang);
    for (var i = 0; i < n; i += len) {
      var cr = 1, ci = 0;
      var half = len >> 1;
      for (var k = 0; k < half; k++) {
        var tr = re[i+k+half]*cr - im[i+k+half]*ci;
        var ti = re[i+k+half]*ci + im[i+k+half]*cr;
        var u = re[i+k];
        var v = im[i+k];
        re[i+k] = u + tr;  im[i+k] = v + ti;
        re[i+k+half] = u - tr;  im[i+k+half] = v - ti;
        var ncr = cr*wr - ci*wi, nci = cr*wi + ci*wr;
        cr = ncr; ci = nci;
      }
    }
  }
}

// ---- Bluestein DFT for arbitrary N (exact) ----
function makeFFT(size) {
  var M = 1; while (M < 2*size - 1) M <<= 1;
  var chirp = new Float64Array(size);     // e^{-i pi k^2/N}
  var kB = new Float64Array(M), kI = new Float64Array(M);
  for (var k = 0; k < size; k++) {
    var ang = -Math.PI * k * k / size;
    chirp[k] = ang;                       // store angle, compute cos/sin on use
  }
  // kernel B[m] = e^{+i pi m^2/N} (complex!) for m in [-(size-1), size-1]
  for (var j = 0; j < size; j++) {
    var ang = Math.PI * j * j / size;
    kB[j] = Math.cos(ang); kI[j] = Math.sin(ang);
  }
  for (var j = M - size + 1; j < M; j++) {
    var lag = M - j;
    var ang = Math.PI * lag * lag / size;
    kB[j] = Math.cos(ang); kI[j] = Math.sin(ang);
  }
  fftPow2(kB, kI, M);

  var size2 = size >> 1;
  return function power(x, out) {
    var a = new Float64Array(M), ai = new Float64Array(M);
    for (var n = 0; n < size; n++) {
      var a0 = chirp[n];
      a[n] = x[n] * Math.cos(a0);
      ai[n] = x[n] * Math.sin(a0);
    }
    fftPow2(a, ai, M);
    for (var n = 0; n < M; n++) {
      var r = a[n]*kB[n] - ai[n]*kI[n];
      var im = a[n]*kI[n] + ai[n]*kB[n];
      a[n] = r; ai[n] = im;
    }
    fftPow2(a, ai, M, true);
    var invM = 1 / M;
    for (var k = 0; k <= size2; k++) {
      var a0 = chirp[k];
      var cr = Math.cos(a0), ci = -Math.sin(a0);
      var r = a[k]*invM;
      var im = ai[k]*invM;
      var rv = r*cr - im*ci, iv = r*ci + im*cr;
      out[k] = rv*rv + iv*iv;
    }
    return out;
  };
}

// ---- spectrum objects per FFT size ----
var specCache = {};
function getSpectrum(fftSize) {
  var s = specCache[fftSize];
  if (s) return s;
  s = specCache[fftSize] = {
    fftSize: fftSize,
    win: new Float32Array(fftSize),
    power: makeFFT(fftSize),
  };
  for (var i = 0; i < fftSize; i++) {
    s.win[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (fftSize - 1)));
  }
  return s;
}

// ---- the decoder ----
function Js8Decoder(modeId, freqMin, freqMax) {
  this.modeId = modeId;
  this.freqMin = freqMin;
  this.freqMax = freqMax;
  this.buffer = [];               // accumulated f32 samples
  this.minSamples = 2 * MODES[modeId].fft * 79;
  this.results = [];
  this.seen = {};                 // dedup across decode cycles: key -> true
}
Js8Decoder.prototype.set_mode = function(modeId) {
  this.modeId = modeId;
  this.minSamples = 2 * MODES[modeId].fft * 79;
  this.buffer = [];
  this.seen = {};
};
Js8Decoder.prototype.push_samples = function(samples) {
  for (var i = 0; i < samples.length; i++) this.buffer.push(samples[i]);
  var keep = MODES[this.modeId].fft * 79 * 1.5;
  var cap = this.minSamples + keep;
  if (this.buffer.length > cap) this.buffer.splice(0, this.buffer.length - cap);
};
Js8Decoder.prototype.run_decode = function() {
  if (this.buffer.length < this.minSamples) return;
  var mode = MODES[this.modeId];
  var fftSize = mode.fft;
  var sp = getSpectrum(fftSize);
  var binHz = SAMPLE_RATE / fftSize;
  var TIME_OSR = 4;                 // overlapping windows: quarter-symbol time grid (ref: NSTEP=NSPS/NSSY)
  var hop = fftSize / TIME_OSR;
  var nW = Math.max(0, Math.floor((this.buffer.length - fftSize) / hop) + 1);
  var spec = new Float64Array(nW * (fftSize / 2 + 1));
  var rowOut = new Float32Array(fftSize / 2 + 1);
  var slot = new Float32Array(fftSize);
  for (var w = 0; w < nW; w++) {
    var base = w * hop;
    for (var i = 0; i < fftSize; i++) slot[i] = this.buffer[base + i] * sp.win[i];
    sp.power(slot, rowOut);
    for (var k = 0; k < rowOut.length; k++) spec[w * rowOut.length + k] = rowOut[k];
  }
  var MAX_CANDS = 20;

  // sync search over the oversampled time grid (mirrors sync.rs + time_osr)
  var minBin = Math.floor(this.freqMin / binHz);
  var maxBin = Math.ceil(this.freqMax / binHz);
  if (nW < 79 * TIME_OSR || maxBin < minBin + 7) return;
  var hits = [];
  var rowLen = fftSize / 2 + 1;
  var span = 79 * TIME_OSR;
  for (var t0 = 0; t0 <= nW - span; t0++) {
    for (var f0 = minBin; f0 <= maxBin - 7; f0++) {
      var score = 0;
      for (var k = 0; k < 21; k++) {
        var row = (t0 + SYNC_POS[k] * TIME_OSR) * rowLen;
        var eb = f0 + COSTAS_TONES[k % 7];
        var expPow = spec[row + eb];
        var noiseSum = 0;
        for (var tone = 0; tone < 8; tone++) {
          if (tone === COSTAS_TONES[k % 7]) continue;
          noiseSum += spec[row + f0 + tone];
        }
        score += expPow - noiseSum / 7;
      }
      hits.push({ f0: f0, t0: t0, score: score });
    }
  }
  hits.sort(function(a, b) { return b.score - a.score; });
  // keep distinct candidates: merge near-duplicates (same freq bin AND
  // t0 within +/-2 grid steps, i.e. the same physical signal appearing at
  // several oversampled time positions). Unlike JS8Call we keep ALL
  // different freq candidates in a slot (they share the slot's time phase,
  // so a per-phase dedup would drop every station but the strongest one).
  var top = [];
  for (var i = 0; i < hits.length && top.length < MAX_CANDS; i++) {
    var h = hits[i];
    var dup = false;
    for (var j = 0; j < top.length; j++) {
      var a = top[j];
      if (Math.abs(a.f0 - h.f0) <= 1 && Math.abs(a.t0 - h.t0) <= 2) { dup = true; break; }
    }
    if (!dup) top.push(h);
  }

  // data symbol positions
  var syncSet = {};
  for (var i = 0; i < 21; i++) syncSet[SYNC_POS[i]] = true;
  var dataPos = [];
  for (var sym = 0; sym < 79; sym++) if (!syncSet[sym]) dataPos.push(sym);

  for (var c = 0; c < top.length; c++) {
    var cand = top[c];
    // fine time search around the coarse slot start (ref: js8dec.f90
    // "Search over +/- one quarter symbol"): refine in 1/16-symbol steps
    var start = cand.t0 * hop;
    var best = start, bestSc = -Infinity;
    for (var d = -hop / 2; d <= hop / 2; d += hop / 8) {
      var sc = this.syncScoreAt(start + d, cand.f0);
      if (sc > bestSc) { bestSc = sc; best = start + d; }
    }
    var llrs = this.extractLlrsAt(best, cand.f0, dataPos, false);
    if (!llrs) continue;
    var msgBits = bpdecode174(llrs);
    if (!msgBits) {
      // second pass with log-metric LLRs (ref: 4-pass strategy)
      var llrs2 = this.extractLlrsAt(best, cand.f0, dataPos, true);
      msgBits = bpdecode174(llrs2);
    }
    if (!msgBits) continue;
    var msg = decodeMessage(msgBits);
    if (!msg) continue;
    var freqHz = cand.f0 * binHz;
    // emit the same (message, freq) only once per slot
    var key = freqHz + '|' + msg;
    var dup = false;
    for (var r = 0; r < this.results.length; r++) {
      if (this.results[r].key === key) { dup = true; break; }
    }
    if (dup) continue;
    var snr = this.estimateSnr(best, cand.f0, dataPos);
    this.results.push({ key: key, freq_hz: freqHz, snr_db: snr, message: msg });
  }
};
// 8-tone power for a symbol window starting at absolute sample offset `start`
// (Goertzel single-bin DFT per tone, matched to the Hann-windowed coarse grid)
Js8Decoder.prototype.tonePowerAt = function(start, f0) {
  var fftSize = MODES[this.modeId].fft;
  var win = getSpectrum(fftSize).win;
  var out = new Float64Array(8);
  for (var tone = 0; tone < 8; tone++) {
    var k = f0 + tone;
    var w = 2 * Math.cos(2 * Math.PI * k / fftSize);
    var s1 = 0, s2 = 0;
    for (var i = 0; i < fftSize; i++) {
      var s0 = this.buffer[start + i] * win[i] + w * s1 - s2;
      s2 = s1; s1 = s0;
    }
    out[tone] = s1 * s1 + s2 * s2 - w * s1 * s2;
  }
  return out;
};
// sync score at absolute sample offset `start` (21 costas symbols)
Js8Decoder.prototype.syncScoreAt = function(start, f0) {
  var score = 0;
  for (var k = 0; k < 21; k++) {
    var p = this.tonePowerAt(start + SYNC_POS[k] * MODES[this.modeId].fft, f0);
    var eb = COSTAS_TONES[k % 7];
    var noiseSum = 0;
    for (var tone = 0; tone < 8; tone++) if (tone !== eb) noiseSum += p[tone];
    score += p[eb] - noiseSum / 7;
  }
  return score;
};
Js8Decoder.prototype.extractLlrsAt = function(start, f0, dataPos, logm) {
  // max-based LLRs (r4/r2/r1) as in the JS8Call reference mirror; with
  // logm=true the tone powers are log-transformed first (second decode pass)
  var llrs = new Float64Array(174);
  for (var i = 0; i < 58; i++) {
    var p = this.tonePowerAt(start + dataPos[i] * MODES[this.modeId].fft, f0);
    if (logm) {
      for (var t = 0; t < 8; t++) p[t] = Math.log(p[t] + 1e-12);
    }
    var p0 = p[0], p1 = p[1], p2 = p[2], p3 = p[3];
    var p4 = p[4], p5 = p[5], p6 = p[6], p7 = p[7];
    var r4 = Math.max(p4, p5, p6, p7) - Math.max(p0, p1, p2, p3);
    var r2 = Math.max(p2, p3, p6, p7) - Math.max(p0, p1, p4, p5);
    var r1 = Math.max(p1, p3, p5, p7) - Math.max(p0, p2, p4, p6);
    llrs[i * 3 + 0] = r4;
    llrs[i * 3 + 1] = r2;
    llrs[i * 3 + 2] = r1;
  }
  // normalize like normalizeLLR
  var n = 174, s = 0, s2 = 0;
  for (var i = 0; i < n; i++) { s += llrs[i]; s2 += llrs[i] * llrs[i]; }
  var av = s / n, var_ = s2 / n - av * av;
  var sig = Math.sqrt(var_ > 0 ? var_ : s2 / n);
  var scale = 2.83 / sig;
  for (var i = 0; i < n; i++) llrs[i] *= scale;
  return llrs;
};
// SNR estimate using the JS8Call reference formula (js8dec.f90:334-352):
// xsig = summed power on the detected (max) tone per data symbol,
// xnoi = summed power on the opposite tone (itone+4 mod 7),
// xsnr = 10*log10(xsig/xnoi - 1) - 27.0 dB, clamped at -28 dB.
Js8Decoder.prototype.estimateSnr = function(start, f0, dataPos) {
  var xsig = 0, xnoi = 0;
  for (var i = 0; i < dataPos.length; i++) {
    var p = this.tonePowerAt(start + dataPos[i] * MODES[this.modeId].fft, f0);
    var det = 0;
    for (var t = 1; t < 8; t++) if (p[t] > p[det]) det = t;
    xsig += p[det];
    xnoi += p[(det + 4) % 7];
  }
  var ratio = xsig / xnoi - 1.0;
  var snr = 10 * Math.log10(Math.max(ratio, 0.001)) - 27.0;
  if (snr < -28.0) snr = -28.0;
  return Math.round(snr * 10) / 10;
};
Js8Decoder.prototype.take_results = function() {
  var out = [];
  for (var i = 0; i < this.results.length; i++) {
    var r = this.results[i];
    if (!this.seen[r.key]) {
      this.seen[r.key] = true;
      out.push(r);
    }
  }
  this.results = [];
  // prevent unbounded growth: clear seen set when it gets large
  // (buffer is capped at ~44 s, so frames slide out quickly)
  var seenCount = 0;
  for (var k in this.seen) seenCount++;
  if (seenCount > 2048) this.seen = {};
  return out;
};

// ---- BP decode (faithful port of bpdecode174 in JS8.cpp) ----
function bpdecode174(llr) {
  var tov = new Float64Array(LDPC_N * 3);   // messages to variable nodes
  var toc = new Float64Array(LDPC_M * 7);   // messages to check nodes
  var tanhtoc = new Float64Array(LDPC_M * 7);
  var zn = new Float64Array(LDPC_N);
  var synd = new Int32Array(LDPC_M);
  var cw = new Int32Array(LDPC_N);
  var ncnt = 0, nclast = 0;

  // initialize toc (messages from bits to checks)
  for (var i = 0; i < LDPC_M; i++) {
    var v = LDPC_NmLen[i];
    for (var j = 0; j < v; j++) {
      toc[i * 7 + j] = llr[LDPC_NmNeigh[i * 7 + j]];
    }
  }

  for (var iter = 0; iter <= LDPC_MAX_ITER; iter++) {
    // update bit log likelihood ratios
    for (var i = 0; i < LDPC_N; i++) {
      zn[i] = llr[i] + tov[i * 3] + tov[i * 3 + 1] + tov[i * 3 + 2];
    }
    for (var i = 0; i < LDPC_N; i++) cw[i] = zn[i] > 0 ? 1 : 0;

    var ncheck = 0;
    for (var i = 0; i < LDPC_M; i++) {
      var v = LDPC_NmLen[i];
      var s = 0;
      for (var j = 0; j < v; j++) s += cw[LDPC_NmNeigh[i * 7 + j]];
      synd[i] = s;
      if (s % 2 !== 0) ncheck++;
    }

    if (ncheck === 0) {
      // extract decoded bits (last N-M bits of codeword)
      var decoded = new Uint8Array(LDPC_K);
      for (var i = 0; i < LDPC_K; i++) decoded[i] = cw[LDPC_M + i];
      return decoded;
    }

    // early stopping criterion
    if (iter > 0) {
      var nd = ncheck - nclast;
      ncnt = (nd < 0) ? 0 : ncnt + 1;
      if (ncnt >= 5 && iter >= 10 && ncheck > 15) return null;
    }
    nclast = ncheck;

    // messages bits -> checks
    for (var i = 0; i < LDPC_M; i++) {
      var v = LDPC_NmLen[i];
      for (var j = 0; j < v; j++) {
        var ibj = LDPC_NmNeigh[i * 7 + j];
        var val = zn[ibj];
        for (var k = 0; k < 3; k++) {
          if (LDPC_Mn[ibj * 3 + k] === i) val -= tov[ibj * 3 + k];
        }
        toc[i * 7 + j] = val;
      }
    }

    for (var i = 0; i < LDPC_M; i++) {
      for (var j = 0; j < 7; j++) {
        tanhtoc[i * 7 + j] = Math.tanh(-toc[i * 7 + j] / 2.0);
      }
    }

    for (var i = 0; i < LDPC_N; i++) {
      for (var j = 0; j < 3; j++) {
        var ichk = LDPC_Mn[i * 3 + j];
        if (ichk >= 0) {
          var Tmn = 1.0;
          var v = LDPC_NmLen[ichk];
          for (var k = 0; k < v; k++) {
            if (LDPC_NmNeigh[ichk * 7 + k] !== i) {
              Tmn *= tanhtoc[ichk * 7 + k];
            }
          }
          tov[i * 3 + j] = 2.0 * Math.atanh(-Tmn);
        }
      }
    }
  }
  return null;
}

// ---- CRC-12 (augmented, poly 0xC06): boost::augmented_crc<12,0xc06> ----
function makeCrc12Table() {
  var table = new Int32Array(256);
  var hbm = 1 << 11;               // 1 << (12-1) = 0x800
  var maxreg = 0xFFFF;             // uint_least16_t register
  for (var d = 0; d < 256; d++) {
    var rem = 0;
    var ndb = 0;                   // reflect_unsigned(d, 8)
    for (var i = 0; i < 8; i++) ndb = (ndb << 1) | ((d >> i) & 1);
    for (var i = 0; i < 8; i++) {
      if (ndb & 1) rem ^= hbm;
      var q = (rem & hbm) !== 0;
      rem = (rem << 1) & maxreg;
      if (q) rem ^= 0xC06;
      ndb >>= 1;
    }
    table[d] = rem & 0xFFF;
  }
  return table;
}
var CRC12_TABLE = makeCrc12Table();

function crc12(data) {
  // data: 11 bytes.  Returns boost::augmented_crc<12,0xc06>(data).
  var rem = 0;
  for (var i = 0; i < data.length; i++) {
    var idx = (rem >> 4) & 0xFF;
    rem = ((rem << 8) | data[i]) & 0xFFFF;
    rem ^= CRC12_TABLE[idx];
  }
  return rem & 0xFFF;
}

function checkCrc12(decoded) {
  // decoded: Uint8Array(87) of message bits (post-LDPC)
  var bits = new Uint8Array(11);
  for (var i = 0; i < 87; i++) {
    if (decoded[i]) bits[i >> 3] |= 1 << (7 - (i & 7));
  }
  var received = ((bits[9] & 0x1F) << 7) | (bits[10] >> 1);
  bits[9] &= 0xE0;
  bits[10] = 0;
  var computed = crc12(bits) ^ 42;
  return received === computed;
}

function extractMessage(decoded) {
  var out = "";
  for (var i = 0; i < 12; i++) {
    var w = 0;
    for (var b = 0; b < 6; b++) w = (w << 1) | decoded[i * 6 + b];
    out += ALPHABET[w];
  }
  return out;
}

// ---- JS8Call message unpacking (port of varicode.cpp / decodedtext.cpp) ----
// The raw 12-char frame is turned back into 72 message bits (12x6bit, MSB first).
// Type bits (i3bit) live at msgBits[72..74] of the 87-bit decoded codeword.
var ALPHABET72 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-+/?.";
var ALPHANUM = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ /@";

var NBASECALL = 37 * 36 * 10 * 27 * 27 * 27;
var NBASEGRID = 180 * 180;
var NUSERGRID = NBASEGRID + 10;
var NMAXGRID = (1 << 15) - 1;

var FrameHeartbeat = 0, FrameCompound = 1, FrameCompoundDirected = 2, FrameDirected = 3, FrameData = 4;
var JS8CallData = 4;

var BASE_BY_VAL = {};
(function() {
  var names = [];
  names.push(["<....>", NBASECALL + 1], ["@ALLCALL", NBASECALL + 2], ["@JS8NET", NBASECALL + 3]);
  var dx = ["@DX/NA", "@DX/SA", "@DX/EU", "@DX/AS", "@DX/AF", "@DX/OC", "@DX/AN"];
  for (var i = 0; i < dx.length; i++) names.push([dx[i], NBASECALL + 4 + i]);
  for (var i = 0; i < 10; i++) names.push(["@GROUP/" + i, NBASECALL + 14 + i]);
  var ops = ["@COMMAND", "@CONTROL", "@NET", "@NTS"];
  for (var i = 0; i < ops.length; i++) names.push([ops[i], NBASECALL + 24 + i]);
  for (var i = 0; i < 5; i++) names.push(["@RESERVE/" + i, NBASECALL + 28 + i]);
  var grp = ["@APRSIS", "@RAGCHEW", "@JS8", "@EMCOMM", "@ARES", "@MARS", "@AMRRON",
    "@RACES", "@RAYNET", "@RADAR", "@SKYWARN", "@CQ", "@HB", "@QSO", "@QSOPARTY",
    "@CONTEST", "@FIELDDAY", "@SOTA", "@IOTA", "@POTA", "@QRP", "@QRO"];
  for (var i = 0; i < grp.length; i++) names.push([grp[i], NBASECALL + 35 + i]);
  for (var i = 0; i < names.length; i++) BASE_BY_VAL[names[i][1]] = names[i][0];
})();

// (cmd-string, value) pairs, first entry wins per value (mirrors setdefault in Python)
var DIRECTED_CMDS = [
  " HEARTBEAT", " HB", " CQ", " SNR?", "?", " DIT DIT", " NACK",
  " HEARING?", " GRID?", ">", " STATUS?", " STATUS", " HEARING", " MSG",
  " MSG TO:", " QUERY", " QUERY MSGS", " QUERY MSGS?", " QUERY CALL",
  " ACK", " GRID", " INFO?", " INFO", " FB", " HW CPY?", " SK",
  " RR", " QSL?", " QSL", " CMD", " SNR", " NO", " YES", " 73",
  " HEARTBEAT SNR", " AGN?", "  ", " "
];
var DIRECTED_VALS = [-1, -1, -1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 13,
  14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 31];
var CMDS_BY_NUM = {};
for (var i = 0; i < DIRECTED_CMDS.length; i++) {
  if (!(DIRECTED_VALS[i] in CMDS_BY_NUM)) CMDS_BY_NUM[DIRECTED_VALS[i]] = DIRECTED_CMDS[i];
}
var SNR_CMDS = { 25: true, 29: true };

var HUFFTABLE = [
  [" ", "01"], ["E", "100"], ["T", "1101"], ["A", "0011"], ["O", "11111"], ["I", "11100"],
  ["N", "10111"], ["S", "10100"], ["H", "00011"], ["R", "00000"], ["D", "111011"],
  ["L", "110011"], ["C", "110001"], ["U", "101101"], ["M", "101011"], ["W", "001011"],
  ["F", "001001"], ["G", "000101"], ["Y", "000011"], ["P", "1111011"], ["B", "1111001"],
  [".", "1110100"], ["V", "1100101"], ["K", "1100100"], ["-", "1100001"], ["+", "1100000"],
  ["?", "1011001"], ["!", "1011000"], ["\"", "1010101"], ["X", "1010100"], ["0", "0010101"],
  ["J", "0010100"], ["1", "0010001"], ["Q", "0010000"], ["2", "0001001"], ["Z", "0001000"],
  ["3", "0000101"], ["5", "0000100"], ["4", "11110101"], ["9", "11110100"], ["8", "11110001"],
  ["6", "11110000"], ["7", "11101011"], ["/", "11101010"]
];
var CQS = { 0: "CQ CQ CQ", 1: "CQ DX", 2: "CQ QRP", 3: "CQ CONTEST", 4: "CQ FIELD", 5: "CQ FD", 6: "CQ CQ", 7: "CQ" };
var HBS = {};
for (var i = 0; i < 8; i++) HBS[i] = "HB";

function intToBits(value, expected) {
  var bits = [];
  while (value > 0) { bits.unshift(value & 1); value = Math.floor(value / 2); }
  while (bits.length < expected) bits.unshift(0);
  return bits;
}
function bitsToInt(bits) {
  var v = 0;
  for (var i = 0; i < bits.length; i++) v = v * 2 + bits[i];
  return v;
}

// Equivalent to intToBits(unpack72bits(text)[0],64) + intToBits(rem,8): 72 bits.
// Verified bit-identical to the Python reference for valid 6-bit indices.
function unpackBits72(text) {
  var bits = [];
  for (var i = 0; i < 12; i++) {
    var idx = ALPHABET72.indexOf(text.charAt(i));
    bits.push((idx >> 5) & 1, (idx >> 4) & 1, (idx >> 3) & 1, (idx >> 2) & 1, (idx >> 1) & 1, idx & 1);
  }
  return bits;
}

function unpackAlphaNumeric50(packed) {
  var word = [];
  var tmp = packed % 38; word.unshift(ALPHANUM[tmp]); packed = Math.floor(packed / 38);
  tmp = packed % 38; word.unshift(ALPHANUM[tmp]); packed = Math.floor(packed / 38);
  tmp = packed % 38; word.unshift(ALPHANUM[tmp]); packed = Math.floor(packed / 38);
  tmp = packed % 2; word.unshift(tmp ? "/" : " "); packed = Math.floor(packed / 2);
  tmp = packed % 38; word.unshift(ALPHANUM[tmp]); packed = Math.floor(packed / 38);
  tmp = packed % 38; word.unshift(ALPHANUM[tmp]); packed = Math.floor(packed / 38);
  tmp = packed % 38; word.unshift(ALPHANUM[tmp]); packed = Math.floor(packed / 38);
  tmp = packed % 2; word.unshift(tmp ? "/" : " "); packed = Math.floor(packed / 2);
  tmp = packed % 38; word.unshift(ALPHANUM[tmp]); packed = Math.floor(packed / 38);
  tmp = packed % 38; word.unshift(ALPHANUM[tmp]); packed = Math.floor(packed / 38);
  tmp = packed % 39; word.unshift(ALPHANUM[tmp]);
  return word.join("").replace(/ /g, "");
}

function unpackCallsign(value, portable) {
  if (value in BASE_BY_VAL) return BASE_BY_VAL[value];
  var word = [];
  var tmp = value % 27 + 10; word.unshift(ALPHANUM[tmp]); value = Math.floor(value / 27);
  tmp = value % 27 + 10; word.unshift(ALPHANUM[tmp]); value = Math.floor(value / 27);
  tmp = value % 27 + 10; word.unshift(ALPHANUM[tmp]); value = Math.floor(value / 27);
  tmp = value % 10; word.unshift(ALPHANUM[tmp]); value = Math.floor(value / 10);
  tmp = value % 36; word.unshift(ALPHANUM[tmp]); value = Math.floor(value / 36);
  word.unshift(ALPHANUM[value]);
  var callsign = word.join("");
  if (callsign.substr(0, 3) === "3D0") callsign = "3DA0" + callsign.substr(3);
  if (callsign.charAt(0) === "Q" && callsign.charAt(1) >= "A" && callsign.charAt(1) <= "Z") {
    callsign = "3X" + callsign.substr(1);
  }
  if (portable) callsign = callsign.replace(/\s+$/, "") + "/P";
  return callsign.replace(/^\s+|\s+$/g, "");
}

function deg2grid(dlong, dlat) {
  if (dlong < -180) dlong += 360;
  if (dlong > 180) dlong -= 360;
  var nlong = Math.floor(60.0 * (180.0 - dlong) / 5);
  var n1 = Math.floor(nlong / 240), rem = nlong - 240 * n1;
  var n2 = Math.floor(rem / 24), n3 = rem - 24 * n2;
  var nlat = Math.floor(60.0 * (dlat + 90) / 2.5);
  var m1 = Math.floor(nlat / 240); rem = nlat - 240 * m1;
  var m2 = Math.floor(rem / 24); var m3 = rem - 24 * m2;
  return String.fromCharCode(65 + n1, 65 + m1, 48 + n2, 48 + m2, 97 + n3, 97 + m3);
}

function unpackGrid(value) {
  if (value > NBASEGRID) return "";
  var dlat = value % 180 - 90;
  var dlong = Math.floor(value / 180) * 2 - 180 + 2;
  return deg2grid(dlong, dlat).substr(0, 4);
}

function formatSNR(snr) {
  if (snr < -60 || snr > 60) return "";
  return (snr >= 0 ? "+" : "-") + (Math.abs(snr) < 10 ? "0" + Math.abs(snr) : "" + Math.abs(snr));
}

function unpackCmd(value) {
  if (value & (1 << 7)) {
    return [value & (1 << 6) ? 29 : 25, value & ((1 << 6) - 1)];
  }
  return [value & ((1 << 7) - 1), 0];
}
function isSNRCommand(cmd) {
  return (cmd in SNR_CMDS);
}

function unpackCompoundFrame(text) {
  if (text.length < 12 || text.indexOf(" ") >= 0) return [];
  var bits = unpackBits72(text);
  var packed_8 = bitsToInt(bits.slice(64, 72));
  var packed_5 = packed_8 >> 3;
  var packed_3 = packed_8 & 7;
  var packed_flag = bitsToInt(bits.slice(0, 3));
  if (packed_flag === FrameData || packed_flag === FrameDirected) return [];
  var packed_callsign = bitsToInt(bits.slice(3, 53));
  var packed_11 = bitsToInt(bits.slice(53, 64));
  var callsign = unpackAlphaNumeric50(packed_callsign);
  var num = (packed_11 << 5) | packed_5;
  return [callsign, "", num, packed_flag, packed_3];
}

function unpackHeartbeatMessage(text) {
  var r = unpackCompoundFrame(text);
  if (!r.length) return [];
  var callsign = r[0], num = r[2], type_ = r[3], bits3 = r[4];
  if (type_ !== FrameHeartbeat) return [];
  var out = [callsign, ""];
  out.push(unpackGrid(num & ((1 << 15) - 1)));
  var isAlt = (num & (1 << 15)) !== 0;
  return [out, type_, isAlt, bits3];
}

function unpackCompoundMessage(text) {
  var r = unpackCompoundFrame(text);
  if (!r.length) return [];
  var callsign = r[0], extra = r[2], type_ = r[3], bits3 = r[4];
  if (type_ !== FrameCompound && type_ !== FrameCompoundDirected) return [];
  var out = [callsign, ""];
  if (extra <= NBASEGRID) {
    out.push(" " + unpackGrid(extra));
  } else if (extra >= NUSERGRID && extra < NMAXGRID) {
    var cu = unpackCmd(extra - NUSERGRID);
    var cmdStr = CMDS_BY_NUM[cu[0]];
    out.push(cmdStr || "");
    if (isSNRCommand(cu[0])) out.push(formatSNR(cu[1] - 31));
  }
  return [out, type_, bits3];
}

function unpackDirectedMessage(text) {
  if (text.length < 12 || text.indexOf(" ") >= 0) return [];
  var bits = unpackBits72(text);
  var packed_flag = bitsToInt(bits.slice(0, 3));
  if (packed_flag !== FrameDirected) return [];
  var packed_from = bitsToInt(bits.slice(3, 31));
  var packed_to = bitsToInt(bits.slice(31, 59));
  var packed_cmd = bitsToInt(bits.slice(59, 64));
  var extra = bitsToInt(bits.slice(64, 72));
  var portable_from = ((extra >> 7) & 1) === 1;
  var portable_to = ((extra >> 6) & 1) === 1;
  extra = extra % 64;
  var from_ = unpackCallsign(packed_from, portable_from);
  var to = unpackCallsign(packed_to, portable_to);
  var cmd = CMDS_BY_NUM[packed_cmd % 32];
  var out = [from_, to, cmd];
  if (extra !== 0) {
    if (isSNRCommand(packed_cmd % 32)) out.push(formatSNR(extra - 31));
    else out.push("" + (extra - 31));
  }
  return [out, packed_flag];
}

function huffDecode(bitvec) {
  var text = "";
  var bits = "";
  for (var i = 0; i < bitvec.length; i++) bits += bitvec[i] ? "1" : "0";
  while (bits.length > 0) {
    var found = false;
    for (var i = 0; i < HUFFTABLE.length; i++) {
      var key = HUFFTABLE[i][0], code = HUFFTABLE[i][1];
      if (bits.indexOf(code) === 0) {
        text += key;
        bits = bits.substr(code.length);
        found = true;
      }
    }
    if (!found) break;
  }
  return text;
}

var JSC_READY = false;
var JSC_LEN = null, JSC_OFF = null, JSC_STR = null;

function jscWord(j) {
  var o = JSC_OFF[j];
  return JSC_STR.substr(o, JSC_LEN[j]);
}

function loadJscMap() {
  // fetch once from the extension dir (relative to this worker script)
  try {
    var url = new URL("jsc_map.dat", self.location.href).href;
    fetch(url).then(function(r) { return r.arrayBuffer(); }).then(function(buf) {
      var bytes = new Uint8Array(buf);
      var n = 262144;
      if (bytes.length < n) throw new Error("jsc_map.dat too small: " + bytes.length);
      JSC_LEN = new Uint8Array(bytes.buffer, 0, n);
      JSC_OFF = new Uint32Array(n);
      var data = new Uint8Array(bytes.buffer, n);
      var off = 0;
      for (var i = 0; i < n; i++) {
        JSC_OFF[i] = off;
        off += JSC_LEN[i];
      }
      var dec = new TextDecoder("latin1");
      JSC_STR = dec.decode(data);
      JSC_READY = true;
      console.log("jsc_map loaded:", n);
    }).catch(function(e) {
      console.log("jsc_map fetch failed:", e.message);
    });
  } catch (e) {
    console.log("jsc_map load error:", e.message);
  }
}

// JSC decompress: (s,c)-dense coding with code tables (jsc.cpp decompress)
function jscDecompress(bitvec) {
  var b = 4, s = 7, c = Math.pow(2, b) - s;
  var base = [0, s, 0, 0, 0, 0, 0, 0];
  for (var k = 2; k < 8; k++) base[k] = base[k - 1] + s * Math.pow(c, k - 1);
  var out = [], bytes = [], separators = [];
  var i = 0, count = bitvec.length;
  while (i < count) {
    var bv = bitvec.slice(i, i + 4);
    if (bv.length !== 4) break;
    bytes.push(bitsToInt(bv));
    i += 4;
    if (bytes[bytes.length - 1] < s) {
      if (count - i > 0 && bitvec[i]) separators.push(bytes.length - 1);
      i += 1;
    }
  }
  var start = 0;
  while (start < bytes.length) {
    var k = 0, j = 0;
    while (start + k < bytes.length && bytes[start + k] >= s) {
      j = j * c + (bytes[start + k] - s);
      k++;
    }
    if (j >= 262144) break;
    if (start + k >= bytes.length) break;
    j = j * s + bytes[start + k] + base[k];
    if (j >= 262144) break;
    out.push(jscWord(j));
    if (separators.length && separators[0] === start + k) {
      out.push(" ");
      separators.shift();
    }
    start = start + (k + 1);
  }
  return out.join("");
}

function unpackDataMessage(text) {
  if (text.length < 12 || text.indexOf(" ") >= 0) return "";
  var bits = unpackBits72(text);
  if (!bits[0]) return "";
  bits = bits.slice(1);
  var compressed = bits[0];
  var n = 0;
  for (var idx = bits.length - 1; idx >= 0; idx--) { if (bits[idx] === 0) { n = idx; break; } }
  bits = bits.slice(1, n);
  if (!JSC_READY) return "";
  if (compressed) return jscDecompress(bits);
  return huffDecode(bits);
}

function unpackFastDataMessage(text) {
  if (text.length < 12 || text.indexOf(" ") >= 0) return "";
  var bits = unpackBits72(text);
  var n = 0;
  for (var idx = bits.length - 1; idx >= 0; idx--) { if (bits[idx] === 0) { n = idx; break; } }
  bits = bits.slice(0, n);
  if (!JSC_READY) return "";
  return jscDecompress(bits);
}

function decodedText(frame, bits_) {
  var m = frame.replace(/^\s+|\s+$/g, "");
  var result = m;
  var frame_type = 255;
  if (m.length < 12 || m.indexOf(" ") >= 0) return result;
  if ((bits_ & JS8CallData) === JS8CallData) {
    var d = unpackFastDataMessage(m);
    if (d) return d;
  }
  if ((bits_ & JS8CallData) !== JS8CallData) {
    var d = unpackDataMessage(m);
    if (d) return d;
  }
  if ((bits_ & JS8CallData) !== JS8CallData) {
    var r = unpackHeartbeatMessage(m);
    if (r.length) {
      var out = r[0], type_ = r[1], isAlt = r[2], bits3 = r[3];
      if (out.length >= 2) {
        var cp = [];
        for (var i = 0; i < 2; i++) if (out[i]) cp.push(out[i]);
        var compound = cp.join("/");
        var extra_ = out.length > 2 ? out[2] : "";
        var msg;
        if (isAlt) msg = compound + ": @ALLCALL " + (CQS[bits3] || "");
        else msg = compound + ": @HB " + ((HBS[bits3] || "HB") === "HB" ? "HEARTBEAT" : (HBS[bits3] || "HB"));
        return msg + " " + extra_ + " ";
      }
    }
  }
  if ((bits_ & JS8CallData) !== JS8CallData) {
    var r = unpackCompoundMessage(m);
    if (r.length) {
      var out = r[0], type_ = r[1];
      if (out.length >= 2) {
        var extra_ = out.slice(2).join(" ");
        var cp = [];
        for (var i = 0; i < 2; i++) if (out[i]) cp.push(out[i]);
        var compound = cp.join("/");
        if (type_ === FrameCompound) return compound + ": ";
        return compound + extra_ + " ";
      }
    }
  }
  if ((bits_ & JS8CallData) !== JS8CallData) {
    var r = unpackDirectedMessage(m);
    if (r.length) {
      var parts = r[0], type_ = r[1];
      if (parts.length) {
        var msg;
        if (parts.length === 3 || parts.length === 4) {
          msg = parts[0] + ": " + parts[1] + parts.slice(2).join(" ") + " ";
        } else {
          msg = parts.join("");
        }
        return msg;
      }
    }
  }
  return result;
}

function decodeMessage(msgBits) {
  if (!checkCrc12(msgBits)) return null;
  var frame = extractMessage(msgBits);
  var i3bit = 4 * msgBits[72] + 2 * msgBits[73] + msgBits[74];
  return decodedText(frame, i3bit);
}

// ---- worker plumbing (mirrors the previous worker) ----
var SLOT_SAMPLES = MODES.map(function(m) { return m.slotSamples; });
var decoder = null;
var modeId = 1;
var slotSamples = SLOT_SAMPLES[modeId];
var samplesInSlot = 0;
var freqMin = 200, freqMax = 3000;

var BUF_CAP = SAMPLE_RATE * 60;
var buf = new Float32Array(BUF_CAP);
var wPtr = 0, rPtr = 0, bufCount = 0;

postMessage({ type: 'ready', wasm: false, msg: 'JS8 pure-JS decoder ready — Slow / Normal / Fast / Turbo' });

loadJscMap();

onmessage = function(e) {
  var msg = e.data;
  switch (msg.type) {
    case 'start':
      modeId      = msg.mode ?? 1;
      freqMin     = msg.freqMin ?? 200;
      freqMax     = msg.freqMax ?? 3000;
      slotSamples = SLOT_SAMPLES[modeId] ?? SLOT_SAMPLES[1];
      samplesInSlot = 0;
      wPtr = rPtr = bufCount = 0;
      decoder = new Js8Decoder(modeId, freqMin, freqMax);
      break;
    case 'audio':
      handleFrame(msg.buffer);
      break;
    case 'set-mode':
      modeId      = msg.mode;
      slotSamples = SLOT_SAMPLES[modeId] ?? SLOT_SAMPLES[1];
      if (decoder) { decoder.set_mode(modeId); samplesInSlot = 0; }
      break;
    case 'stop':
      decoder = null;
      samplesInSlot = 0;
      wPtr = rPtr = bufCount = 0;
      break;
  }
};

function handleFrame(arrayBuffer) {
  var pcm16 = new Int16Array(arrayBuffer, 4);
  for (var i = 0; i < pcm16.length; i++) {
    if (bufCount < BUF_CAP) {
      buf[wPtr] = pcm16[i] / 32768;
      wPtr = (wPtr + 1) % BUF_CAP;
      bufCount++;
    }
  }
  samplesInSlot += pcm16.length;
  if (samplesInSlot >= slotSamples) {
    samplesInSlot = 0;
    runDecode();
  }
}

function runDecode() {
  var slotTime = new Date().toISOString().slice(11, 19);
  if (!decoder) return;
  var count = bufCount;
  var chunk = new Float32Array(count);
  for (var i = 0; i < count; i++) chunk[i] = buf[(rPtr + i) % BUF_CAP];
  rPtr = (rPtr + count) % BUF_CAP;
  bufCount = 0;
  try {
    decoder.push_samples(chunk);
    decoder.run_decode();
    var raw = decoder.take_results();
    var messages = [];
    for (var i = 0; i < raw.length; i++) {
      messages.push({
        snr: raw[i].snr_db,
        dt: 0,
        freq: raw[i].freq_hz,
        msg: raw[i].message,
        time: slotTime,
      });
    }
    postMessage({ type: 'decoded', messages: messages, slotTime: slotTime });
  } catch (err) {
    postMessage({ type: 'error', msg: err.message });
  }
}
