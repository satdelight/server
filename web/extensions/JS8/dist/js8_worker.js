// ============================================================
// js8_worker.js — Self-contained pure-JS JS8Call decoder worker.
//
// Replaces the (broken) WASM decoder: the shipped llr.rs used
// `tone ^ (tone >> 1)` as the tone->bit Gray map, which disagrees
// with the canonical FT8/JS8Call `kFT8_Gray_map` on tones 5 and 7,
// causing ~30/174 bit errors per clean frame and 0 decodes. This
// worker implements the correct map and the full chain in plain JS.
//
// Protocol (compatible with the previous worker):
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

var SAMPLE_RATE = 12000;

// ---- LDPC tables (generated from kgoba/ft8_lib kFTX_LDPC_Nm) ----
var LDPC_N = 174, LDPC_M = 83, LDPC_MAX_ITER = 50;
var LDPC_checkVars   = new Int16Array([
3,30,58,90,91,95,152,4,31,59,92,114,145,255,5,23,
60,93,121,150,255,6,32,61,94,95,142,255,7,24,62,82,
92,95,147,5,31,63,96,125,137,255,4,33,64,77,97,106,
153,8,34,65,98,138,145,255,9,35,66,99,106,125,255,10,
36,66,86,100,138,157,11,37,67,101,104,154,255,12,38,68,
102,148,161,255,7,39,69,81,103,113,144,13,40,70,87,101,
122,155,14,41,58,105,122,158,255,0,32,71,105,106,156,255,
15,42,72,107,140,159,255,16,36,73,80,108,130,153,10,43,
74,109,120,165,255,44,54,63,110,129,160,172,7,45,70,111,
118,165,255,17,35,75,88,112,113,142,18,37,76,103,115,162,
255,19,46,69,91,137,164,255,1,47,73,112,127,159,255,20,
44,77,82,116,120,150,21,46,57,117,126,163,255,15,38,61,
111,133,157,255,22,42,78,119,130,144,255,18,34,58,72,109,
124,160,19,35,62,93,135,160,255,13,30,78,97,131,163,255,
2,43,79,123,126,168,255,18,45,80,116,134,166,255,6,48,
57,89,99,104,167,11,49,60,117,118,143,255,12,50,63,113,
117,156,255,23,51,75,128,147,148,255,24,52,68,89,100,129,
155,19,45,64,79,119,139,169,20,53,76,99,139,170,255,34,
81,132,141,170,173,255,13,29,82,112,124,169,255,3,28,67,
119,133,172,255,0,3,51,56,85,135,151,25,50,55,90,121,
136,167,51,83,109,114,144,167,255,6,49,80,98,131,172,255,
22,54,66,94,171,173,255,25,40,76,108,140,147,255,1,26,
40,60,61,114,132,26,39,55,123,124,125,255,17,48,54,123,
140,166,255,5,32,84,107,115,155,255,27,47,69,84,104,128,
157,8,53,62,130,146,154,255,21,52,67,108,120,173,255,2,
12,47,77,94,122,255,30,68,132,149,154,168,255,11,42,65,
88,96,134,158,4,38,74,101,135,166,255,1,53,85,100,134,
163,255,14,55,86,107,118,170,255,9,43,81,90,110,143,148,
22,33,70,93,126,152,255,10,48,87,91,141,156,255,28,33,
86,96,146,161,255,29,49,59,85,136,141,161,9,52,65,83,
111,127,164,21,56,84,92,139,158,255,27,31,71,102,131,165,
255,27,28,83,87,116,142,149,0,25,44,79,127,146,255,16,
26,88,102,115,152,255,50,56,97,162,164,171,255,20,36,72,
137,151,168,255,15,46,75,129,136,153,255,2,23,29,71,103,
138,255,8,39,89,105,133,150,255,14,57,59,73,110,149,162,
17,41,78,143,145,151,255,24,37,64,98,121,159,255,16,41,
74,128,169,171,255]);
var LDPC_checkLen    = [7,6,6,6,7,6,7,6,6,7,6,6,7,7,6,6,6,7,6,7,6,7,6,6,6,7,6,6,6,7,6,6,6,6,7,6,6,6,7,7,
6,6,6,6,7,7,6,6,6,6,7,6,6,6,7,6,6,6,6,7,6,6,6,7,6,6,6,7,7,6,6,7,6,6,6,6,6,6,6,7,
6,6,6];
var LDPC_checkV2CIdx = new Int32Array([
9,90,174,270,273,285,456,12,93,177,276,342,435,0,15,69,
180,279,363,450,0,18,96,183,282,286,426,0,21,72,186,246,
277,287,441,16,94,189,288,375,411,0,13,99,192,231,291,318,
459,24,102,195,294,414,436,0,27,105,198,297,319,376,0,30,
108,199,258,300,415,471,33,111,201,303,312,462,0,36,114,204,
306,444,483,0,22,117,207,243,309,339,432,39,120,210,261,304,
366,465,42,123,175,315,367,474,0,0,97,213,316,320,468,0,
45,126,216,321,420,477,0,48,109,219,240,324,390,460,31,129,
222,327,360,495,0,132,162,190,330,387,480,516,23,135,211,333,
354,496,0,51,106,225,264,336,340,427,54,112,228,310,345,486,
0,57,138,208,274,412,492,0,3,141,220,337,381,478,0,60,
133,232,247,348,361,451,63,139,171,351,378,489,0,46,115,184,
334,399,472,0,66,127,234,357,391,433,0,55,103,176,217,328,
372,481,58,107,187,280,405,482,0,40,91,235,292,393,490,0,
6,130,237,369,379,504,0,56,136,241,349,402,498,0,19,144,
172,267,298,313,501,34,147,181,352,355,429,0,37,150,191,341,
353,469,0,70,153,226,384,442,445,0,73,156,205,268,301,388,
466,59,137,193,238,358,417,507,61,159,229,299,418,510,0,104,
244,396,423,511,519,0,41,87,248,338,373,508,0,10,84,202,
359,400,517,0,1,11,154,168,255,406,453,75,151,165,271,364,
408,502,155,249,329,343,434,503,0,20,148,242,295,394,518,0,
67,163,200,283,513,520,0,76,121,230,325,421,443,0,4,78,
122,182,185,344,397,79,118,166,370,374,377,0,52,145,164,371,
422,499,0,17,98,252,322,346,467,0,81,142,209,253,314,385,
473,25,160,188,392,438,463,0,64,157,203,326,362,521,0,7,
38,143,233,284,368,0,92,206,398,447,464,505,0,35,128,196,
265,289,403,475,14,116,223,305,407,500,0,5,161,256,302,404,
491,0,43,167,259,323,356,512,0,28,131,245,272,331,430,446,
68,100,212,281,380,457,0,32,146,262,275,424,470,0,85,101,
260,290,439,484,0,88,149,178,257,409,425,485,29,158,197,250,
335,382,493,65,169,254,278,419,476,0,82,95,214,307,395,497,
0,83,86,251,263,350,428,448,2,77,134,239,383,440,0,49,
80,266,308,347,458,0,152,170,293,487,494,514,0,62,110,218,
413,454,506,0,47,140,227,389,410,461,0,8,71,89,215,311,
416,0,26,119,269,317,401,452,0,44,173,179,221,332,449,488,
53,124,236,431,437,455,0,74,113,194,296,365,479,0,50,125,
224,386,509,515,0]);
var LDPC_varC2VIdx   = new Int32Array([
105,308,504,168,350,427,224,399,539,0,301,309,7,42,420,14,
35,371,21,238,329,28,84,140,49,385,546,56,441,476,63,126,
455,70,245,413,77,252,400,91,217,294,98,434,553,112,189,532,
119,511,574,147,364,560,154,203,231,161,210,273,175,280,525,182,
392,483,196,336,448,15,259,540,29,266,567,315,343,505,351,357,
512,378,490,497,302,462,498,295,469,541,1,218,406,8,36,491,
22,106,372,43,449,463,50,204,287,57,148,211,64,120,526,71,
155,568,78,190,421,85,358,547,92,344,352,99,561,575,113,197,
414,127,225,442,133,176,506,141,232,274,162,183,533,169,379,401,
239,365,456,246,330,470,253,316,518,260,310,322,267,393,477,281,
386,428,134,337,366,317,359,435,311,484,519,184,240,554,2,100,
205,9,471,555,16,247,353,23,191,354,30,212,387,37,135,254,
44,275,569,51,415,478,58,65,338,72,303,394,79,268,407,86,
163,380,93,142,450,107,492,542,114,206,527,121,170,556,128,422,
576,149,261,534,156,282,345,45,177,402,198,219,562,226,276,507,
122,233,331,87,288,443,31,178,296,323,479,499,373,381,485,312,
429,472,66,436,464,94,457,500,150,416,513,241,269,548,3,318,
444,4,164,458,10,32,486,17,213,451,24,339,403,5,25,33,
38,417,465,46,220,520,52,332,570,59,242,283,67,270,430,73,
95,423,80,493,514,88,157,543,74,243,382,101,108,549,47,60,
109,115,374,437,123,346,395,129,207,324,136,445,557,143,192,480,
151,171,297,89,152,255,11,325,355,158,375,515,179,234,501,185,
248,256,144,249,438,199,277,304,130,180,396,18,319,571,96,102,
404,227,360,367,208,298,361,39,61,362,186,228,452,172,481,508,
262,383,577,137,271,535,124,200,388,221,333,494,289,356,408,193,
305,550,235,418,431,214,313,424,320,473,536,40,165,528,53,68,
544,278,284,487,116,347,368,290,459,474,26,153,502,250,446,563,
90,201,326,12,54,564,389,466,509,34,263,348,81,264,447,409,
503,558,19,181,551,314,529,565,6,453,516,48,125,537,75,390,
410,97,272,376,110,257,460,69,194,384,103,419,488,117,173,572,
138,209,215,82,467,475,159,521,559,187,222,432,166,482,522,131,
145,495,236,369,425,244,321,327,229,411,530,279,299,578,285,291,
439,340,523,579,139,306,334,292,341,397]);
// ---- speed modes (fft size in samples per symbol @12 kHz) ----
var MODES = [
  { fft: 3840, slotSamples:  30 * SAMPLE_RATE },  // Slow
  { fft: 1920, slotSamples:  Math.round(15.6 * SAMPLE_RATE) }, // Normal
  { fft:  960, slotSamples:  10 * SAMPLE_RATE },  // Fast
  { fft:  480, slotSamples:   6 * SAMPLE_RATE },  // Turbo
];

var COSTAS_TONES = [2, 5, 6, 0, 4, 1, 3];
var SYNC_POS     = [0,1,2,3,4,5,6, 36,37,38,39,40,41,42, 72,73,74,75,76,77,78];
// inverse of kFT8_Gray_map: tone -> transmitted 3-bit value (canonical FT8/JS8Call)
var INV_GRAY = [0, 1, 3, 2, 6, 4, 5, 7];

// ---- power-of-two radix-2 FFT core ----
function fftPow2(re, im, n) {
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
    var ang = -2 * Math.PI / len;
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
  // size is per-symbol FFT length (480/960/1920/3840)
  var M = 1; while (M < 2*size - 1) M <<= 1;
  var chirp = new Float64Array(size);     // e^{-i pi k^2/N}
  var kernel = new Float64Array(M);       // kernel B (real; imaginary part zero)
  for (var k = 0; k < size; k++) {
    var ang = -Math.PI * k * k / size;
    chirp[k] = ang;                       // store angle, compute cos/sin on use
  }
  for (var j = 0; j < size; j++) {
    kernel[j] = Math.cos(Math.PI * j * j / size);
  }
  for (var j = M - size + 1; j < M; j++) {
    var lag = M - j;
    kernel[j] = Math.cos(Math.PI * lag * lag / size);
  }
  // pre-FFT the kernel once
  var kB = new Float64Array(M), kI = new Float64Array(M);
  for (var j = 0; j < M; j++) kB[j] = kernel[j];
  fftPow2(kB, kI, M);

  var size2 = size >> 1;
  return function power(x, out) {
    // x: Float32Array of `size` samples. out: Float32Array length size/2+1 (squared mags)
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
    fftPow2(a, ai, M);
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
}
Js8Decoder.prototype.set_mode = function(modeId) {
  this.modeId = modeId;
  this.minSamples = 2 * MODES[modeId].fft * 79;
  this.buffer = [];
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
  var nSlots = Math.floor(this.buffer.length / fftSize);
  var spec = new Float64Array(nSlots * (fftSize / 2 + 1));
  var rowOut = new Float32Array(fftSize / 2 + 1);
  var slot = new Float32Array(fftSize);
  for (var s = 0; s < nSlots; s++) {
    var base = s * fftSize;
    for (var i = 0; i < fftSize; i++) slot[i] = this.buffer[base + i] * sp.win[i];
    sp.power(slot, rowOut);
    for (var k = 0; k < rowOut.length; k++) spec[s * rowOut.length + k] = rowOut[k];
  }

  // sync search (mirrors sync.rs)
  var minBin = Math.floor(this.freqMin / binHz);
  var maxBin = Math.ceil(this.freqMax / binHz);
  if (nSlots < 79 || maxBin < minBin + 7) return;
  var hits = [];
  var rowLen = fftSize / 2 + 1;
  for (var t0 = 0; t0 <= nSlots - 79; t0++) {
    for (var f0 = minBin; f0 <= maxBin - 7; f0++) {
      var score = 0;
      for (var k = 0; k < 21; k++) {
        var row = (t0 + SYNC_POS[k]) * rowLen;
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
  var top = hits.slice(0, 20);

  // data symbol positions
  var syncSet = {};
  for (var i = 0; i < 21; i++) syncSet[SYNC_POS[i]] = true;
  var dataPos = [];
  for (var sym = 0; sym < 79; sym++) if (!syncSet[sym]) dataPos.push(sym);

  for (var c = 0; c < top.length; c++) {
    var cand = top[c];
    var llrs = this.extractLlrs(spec, rowLen, cand.f0, cand.t0, dataPos);
    if (!llrs) continue;
    var cw = ldpcDecode(llrs);
    if (!cw) continue;
    var msg = decodeMessage(cw);
    if (msg) {
      var freqHz = cand.f0 * binHz;
      this.results.push({ freq_hz: freqHz, snr_db: 0, message: msg });
    }
  }
};
Js8Decoder.prototype.extractLlrs = function(spec, rowLen, f0, t0, dataPos) {
  var llrs = new Float64Array(174);
  for (var i = 0; i < 58; i++) {
    var row = (t0 + dataPos[i]) * rowLen;
    var total = 0;
    for (var tone = 0; tone < 8; tone++) total += spec[row + f0 + tone];
    if (total <= 0) return null;
    var inv = 1 / total;
    for (var bp = 0; bp < 3; bp++) {
      var p0 = 0, p1 = 0;
      for (var tone = 0; tone < 8; tone++) {
        var bits3 = INV_GRAY[tone];
        var bit = (bits3 >> (2 - bp)) & 1;
        var pw = spec[row + f0 + tone] * inv;
        if (bit === 0) p0 += pw; else p1 += pw;
      }
      llrs[i * 3 + bp] = Math.log(p0 / Math.max(p1, 1e-10));
    }
  }
  return llrs;
};
Js8Decoder.prototype.take_results = function() {
  var r = this.results;
  this.results = [];
  return r;
};

// ---- LDPC sum-product decode (mirrors ldpc.rs) ----
function ldpcDecode(llrs) {
  var v2c = new Float64Array(LDPC_N * 3);
  for (var i = 0; i < LDPC_N; i++) {
    v2c[i*3] = llrs[i]; v2c[i*3+1] = llrs[i]; v2c[i*3+2] = llrs[i];
  }
  var c2v = new Float64Array(LDPC_M * 7);
  var total = new Float64Array(LDPC_N);
  var bits = new Uint8Array(LDPC_N);
  for (var iter = 0; iter < LDPC_MAX_ITER; iter++) {
    // check nodes
    for (var j = 0; j < LDPC_M; j++) {
      var lenj = LDPC_checkLen[j];
      var j7 = j * 7;
      for (var ej = 0; ej < lenj; ej++) {
        var prodSign = 1;
        var prodLog = 0;
        for (var ek = 0; ek < lenj; ek++) {
          if (ek === ej) continue;
          var x = v2c[LDPC_checkV2CIdx[j7 + ek]] * 0.5;
          var t = Math.tanh(x);
          if (t < 0) prodSign = -prodSign;
          prodLog += Math.log(Math.abs(t) + 1e-10);
        }
        var mag = 2 * Math.atanh(Math.min(Math.exp(prodLog), 1 - 1e-7));
        c2v[j7 + ej] = prodSign * mag;
      }
    }
    // variable nodes
    for (var i = 0; i < LDPC_N; i++) {
      var i3 = i * 3;
      total[i] = llrs[i] + c2v[LDPC_varC2VIdx[i3]] + c2v[LDPC_varC2VIdx[i3+1]] + c2v[LDPC_varC2VIdx[i3+2]];
      bits[i] = total[i] < 0 ? 1 : 0;
    }
    for (var i = 0; i < LDPC_N; i++) {
      var i3 = i * 3;
      var t = total[i];
      v2c[i3]   = t - c2v[LDPC_varC2VIdx[i3]];
      v2c[i3+1] = t - c2v[LDPC_varC2VIdx[i3+1]];
      v2c[i3+2] = t - c2v[LDPC_varC2VIdx[i3+2]];
    }
    // syndrome
    var ok = true;
    for (var j = 0; j < LDPC_M; j++) {
      var lenj = LDPC_checkLen[j];
      var s = 0;
      for (var ej = 0; ej < lenj; ej++) {
        s ^= bits[LDPC_checkVars[j*7 + ej]];
      }
      if (s) { ok = false; break; }
    }
    if (ok) {
      // pack into 22 bytes MSB-first
      var cw = new Uint8Array(22);
      for (var i = 0; i < LDPC_N; i++) {
        if (bits[i]) cw[i >> 3] |= 1 << (7 - (i & 7));
      }
      return cw;
    }
  }
  return null;
}

// ---- message unpack (port of message.rs) ----
var CHAR37 = " 0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
function bitsToU32(bits, off, len) {
  var v = 0;
  for (var i = 0; i < len; i++) v = (v << 1) | bits[off + i];
  return v;
}
function crc11(bits) {
  var crc = 0;
  for (var i = 0; i < bits.length; i++) {
    var msb = (crc >> 10) & 1;
    crc = (crc << 1) & 0x7FF;
    if ((msb ^ bits[i]) !== 0) crc ^= 0x6B1;
  }
  return crc & 0x7FF;
}
function decodeCallsign(n) {
  if (n === 0) return "DE";
  if (n === 1) return "QRZ";
  if (n === 2) return "CQ";
  if (n >= 3 && n <= 512) return "CQ " + ("000" + (n - 3)).slice(-3);
  var cs = [" ", " ", " ", " ", " ", " "];
  for (var i = 5; i >= 0; i--) { cs[i] = CHAR37[n % 37]; n = Math.floor(n / 37); }
  var s = cs.join("").trim();
  if (!s || !s[0].match(/[0-9A-Z]/)) return null;
  return s;
}
function decodeMessage(cw) {
  var bits = [];
  for (var i = 0; i < 91; i++) bits.push((cw[i >> 3] >> (7 - (i & 7))) & 1);
  // CRC over bits 0..72, stored at 72..83
  var c = crc11(bits.slice(0, 72));
  var stored = bitsToU32(bits, 72, 11);
  if (c !== stored) return null;
  // standard callsign pair?
  var c1 = decodeCallsign(bitsToU32(bits, 0, 28));
  var c2 = decodeCallsign(bitsToU32(bits, 28, 28));
  var isType = bits[63] === 0;
  if (isType && c1 && c2) {
    return c1 + " " + c2;   // + report (simplified)
  }
  // free text (71 bits); use BigInt: the value spans up to 2^71,
  // beyond Number.MAX_SAFE_INTEGER (2^53), so plain doubles lose low bits
  var val = 0n;
  for (var i = 0; i < 71; i++) val = (val << 1n) | BigInt(bits[i]);
  var chars = [];
  for (var i = 0; i < 13; i++) { chars.push(CHAR37[Number(val % 37n)]); val = val / 37n; }
  chars.reverse();
  var s = chars.join("").trim();
  if (s) return s;
  return "<bits:" + hexBits(bits.slice(0, 72)) + ">";
}
function hexBits(bits) {
  var out = "";
  for (var i = 0; i < bits.length; i += 4) {
    var n = 0;
    for (var k = 0; k < 4; k++) n = (n << 1) | bits[i + k];
    out += n.toString(16).toUpperCase();
  }
  return out;
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
