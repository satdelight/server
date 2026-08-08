// VHF ACARS extension: decode VHF ACARS (AM, 2400 bps MSK) via acarsdec by Thierry Leconte
// Copyright (c) 2026 Holger Nyga, https://github.com/satdelight
// Licensed under GPL-2.0

#pragma once

#include "types.h"
#include "kiwi.h"
#include "config.h"
#include "kiwi_assert.h"
#include "mem.h"
#include "coroutines.h"
#include "data_pump.h"
#include "ext.h"	// all calls to the extension interface begin with "ext_", e.g. ext_register()
#include "web.h"

typedef struct {
	u4_t nom_rate;
    double resample_alpha;	// calibrated VHF resample factor (see VHF_ACARS_RESAMPLE_ALPHA)
    bool calibrated;		// calibration confirmed; stop re-measuring
} acars_t;

#define VHF_ACARS_CAL_N 2048	// calibration window in input samples (~166 ms at 12300 Hz)

typedef struct {
	int rx_chan;
	int run;
	bool reset;
	bool closing;		// guard against concurrent/duplicate acars_close() calls
	tid_t tid, acarsdec_tid;
	int rd_pos;
	bool seq_init;
	u4_t seq;

    int pid;

	double freq;
    double tuned_f;

    int input_fd;		// FIFO write end for acarsdec
    int output_pipe;	// pipe read end from acarsdec stdout
    char fifo_path[64];

    int nsamps;
    float *env;		// envelope (AM demod) buffer
    float *out;		// resampled output buffer
    float prev;		// last sample of previous chunk
    double resample_pos;	// read pos in input-sample units relative to chunk start

    // resample-factor auto-calibration state (VHF ACARS clock bug workaround)
    int cal_n;			// number of env samples accumulated in cal_buf
    float *cal_buf;		// calibration window (VHF_ACARS_CAL_N samples)
    int cal_cnt;		// accepted measurements
    double cal_freq_sum;	// sum of measured tone frequencies

    // one-shot debug warnings (avoid log spam on a running session)
    bool dbg_seq, dbg_write;
} acars_chan_t;
