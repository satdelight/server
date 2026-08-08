// VHF ACARS extension: decode VHF ACARS (AM, 2400 bps MSK) via acarsdec by Thierry Leconte
// Copyright (c) 2026 Holger Nyga, https://github.com/satdelight
// Licensed under GPL-2.0

#include "vhf_acars.h"
#include "ext_int.h"
#include "datatypes.h"	// K_PI
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <signal.h>
#include <poll.h>

// Web-888 Airband clock bug (github.com/RaspSDR/server/issues/95): ADC_CLOCK_VHF
// 100.7616 MHz is not an integer multiple of 12000*256, so the real audio rate is
// 12300 Hz instead of the declared 12000 Hz. Resample by 1.025 so tones seen by
// acarsdec (which assumes exactly 12000 Hz) are pitch-corrected.
#define VHF_ACARS_RESAMPLE_ALPHA 1.025

static acars_t acars;
static acars_chan_t acars_chan[MAX_RX_CHANS];

static void acars_close(int rx_chan);

// --- resample-factor auto-calibration -------------------------------------
// The VHF ACARS MSK bit sync preamble (010101...) produces a pure tone at
// 1200 Hz (and its 2nd harmonic at 2400 Hz) in the AM-demodulated audio. With
// the Web-888 airband clock bug (issue #95) the real audio rate is 12300 Hz
// instead of 12000 Hz, so those tones appear at 1170.73 / 2341.46 Hz. By
// measuring the actual preamble tone frequency we can derive the resample
// factor (1200/f_meas) and compensate regardless of whether the bug is present.

// Goertzel DFT single-bin energy, windowed over all samples given
static double goertzel_energy(double *g, const float *x, int n, double f, double srate)
{
    double w = 2.0 * K_PI * f / srate;
    double c = cos(w), s = sin(w);
    double b0 = 0, b1 = 0, b2 = 0;
    double cr = 2.0 * c;
    for (int i = 0; i < n; i++) {
        b0 = cr * b1 - b2 + x[i];
        b2 = b1;
        b1 = b0;
    }
    double re = b1 - b2 * c;
    double im = b2 * s;
    return re * re + im * im;
}

// Scan a frequency band with Goertzel, return the interpolated peak frequency.
// g[] must hold (bins+2) doubles.
static double goertzel_scan_peak(double *g, const float *x, int n, double srate,
                                 double f_lo, double f_hi, int bins, double *peak_energy)
{
    double step = (f_hi - f_lo) / (bins - 1);
    int best_i = -1;
    double best_e = -1;
    for (int i = 0; i < bins; i++) {
        g[i] = goertzel_energy(NULL, x, n, f_lo + i * step, srate);
        if (g[i] > best_e) { best_e = g[i]; best_i = i; }
    }
    if (best_i < 1 || best_i > bins - 2) {	// peak at band edge: can't interpolate
        if (peak_energy) *peak_energy = best_e;
        return f_lo + best_i * step;
    }
    // quadratic interpolation of the 3 bins around the peak for sub-bin precision
    double y0 = g[best_i - 1], y1 = g[best_i], y2 = g[best_i + 1];
    double den = y0 - 2.0 * y1 + y2;
    double offset = (den != 0.0) ? 0.5 * (y0 - y2) / den : 0.0;
    if (peak_energy) *peak_energy = y1;
    return f_lo + (best_i + offset) * step;
}

// Called from acars_task with a fresh chunk of envelope samples. Accumulates a
// window and, once full, looks for a strong MSK-sync tone. Two consistent
// measurements update acars.resample_alpha. Calibration runs once per boot:
// the clock bug factor is a hardware constant, so re-measuring can only add
// noise. A tonality gate rejects windows that contain data/noise instead of a
// dominant 1200 Hz (or 2400 Hz) sync tone.
static void acars_calibrate(acars_chan_t *e, const float *env, int n)
{
    if (acars.calibrated) return;

    for (int i = 0; i < n; i++) {
        e->cal_buf[e->cal_n++] = env[i];
        if (e->cal_n < VHF_ACARS_CAL_N) continue;

        // window full: check signal level (reject silence) and measure the tone
        double e_sum = 0, e2_sum = 0;
        for (int j = 0; j < VHF_ACARS_CAL_N; j++) {
            double v = e->cal_buf[j];
            e_sum += v;
            e2_sum += v * v;
        }
        double mean = e_sum / VHF_ACARS_CAL_N;
        double var = e2_sum / VHF_ACARS_CAL_N - mean * mean;
        e->cal_n = 0;

        double rms = sqrt(var);
        if (rms < 0.05) continue;	// too quiet: no signal

        // scan the 1200 Hz tone band and the 2400 Hz harmonic band
        double g1200[128], g2400[128];
        double pe1200, pe2400;
        double f1200 = goertzel_scan_peak(g1200, e->cal_buf, VHF_ACARS_CAL_N, (double) snd_rate, 1100.0, 1300.0, 64, &pe1200);
        double f2400 = goertzel_scan_peak(g2400, e->cal_buf, VHF_ACARS_CAL_N, (double) snd_rate, 2200.0, 2600.0, 64, &pe2400);

        // tonality gate: for a clean tone, peak bin energy is large relative to
        // the AC energy of the window (pure tone ratio ~ N/2 = 1024; noise ~ 2-8).
        // Rejects windows containing data, speech or noise.
        double pe_max = (pe1200 > pe2400) ? pe1200 : pe2400;
        double tonality = pe_max / (var * VHF_ACARS_CAL_N);
        if (tonality < 50.0) continue;	// not a dominant tone

        // the stronger of the two tone bands is the sync tone; the 2400 Hz band
        // is the 2nd harmonic, use the fundamental for the factor
        double f_meas = f1200;
        if (pe2400 > pe1200) f_meas = f2400 / 2.0;

        double factor = 1200.0 / f_meas;
        if (factor < 0.99 || factor > 1.05) continue;	// implausible, ignore

        e->cal_cnt++;
        ext_send_msg(e->rx_chan, false, "EXT DBG cal meas#%d tone=%.2fHz factor=%.5f", e->cal_cnt, f_meas, factor);

        if (e->cal_cnt == 1) {
            e->cal_freq_sum = f_meas;	// remember first measurement
        } else {
            // second measurement: only accept if it confirms the first within
            // ~1 Hz (tone jitter). Otherwise restart the calibration.
            if (fabs(f_meas - e->cal_freq_sum) > 1.5) {
                ext_send_msg(e->rx_chan, false, "EXT DBG cal rejected (%.2f vs %.2f Hz), restarting", f_meas, e->cal_freq_sum);
                e->cal_cnt = 0;
                e->cal_freq_sum = 0.0;
            } else {
                double f_avg = (f_meas + e->cal_freq_sum) / 2.0;
                double alpha = 1200.0 / f_avg;
                acars.resample_alpha = alpha;
                acars.calibrated = true;
                ext_send_msg(e->rx_chan, false, "EXT DBG cal SET Calibrating: resample factor alpha=%.5f\n", alpha);
                e->cal_cnt = 0;
                e->cal_freq_sum = 0.0;
            }
        }
    }
}

static void acars_task(void *param)
{
    while (1) {
        int rx_chan = (int)FROM_VOID_PARAM(TaskSleepReason("wait for wakeup"));

        acars_chan_t *e = &acars_chan[rx_chan];
        iq_buf_t *rx = &RX_SHMEM->iq_buf[rx_chan];

        // blocks via TaskSleep() / wakeup due to ext_register_receive_iq_samps_task()
        while (e->rd_pos != rx->iq_wr_pos) {
            if (rx->iq_seqnum[e->rd_pos] != e->seq) {
                if (!e->seq_init) {
                    e->seq_init = true;
                } else {
                    u4_t got = rx->iq_seqnum[e->rd_pos], expecting = e->seq;
                    // one-shot warning only (avoid flooding the admin log)
                    if (!e->dbg_seq && (int)(got - expecting) != -1) {
                        e->dbg_seq = true;
                        rcprintf(rx_chan, "vhf_acars SEQ: @%d got %d expecting %d (%d)\n", e->rd_pos, got, expecting, got - expecting);
                    }
                }
                e->seq = rx->iq_seqnum[e->rd_pos];
            }
            e->seq++;

            if (e->reset) {
                e->reset = false;
            }

            int rd_pos = e->rd_pos;
            if (e->input_fd) {
                // AM demod: envelope of complex baseband -> real float, then
                // resample by the calibrated factor (see VHF_ACARS_RESAMPLE_ALPHA)
                // before writing to the acarsdec stdin FIFO
                TYPECPX *samps = &rx->iq_samples[rd_pos][0];
                for (int i = 0; i < FASTFIR_OUTBUF_SIZE; i++) {
                    e->env[i] = sqrtf(samps[i].re * samps[i].re + samps[i].im * samps[i].im);
                }

                // feed the calibration (tone-frequency measurement) window
                acars_calibrate(e, e->env, FASTFIR_OUTBUF_SIZE);

                double alpha = acars.resample_alpha;
                int out_n = 0;
                double pos = e->resample_pos;
                while (pos + 1.0 < FASTFIR_OUTBUF_SIZE) {
                    int i = (int)pos;
                    float x0, x1;
                    if (i == -1) { x0 = e->prev; x1 = e->env[0]; }
                    else { x0 = e->env[i]; x1 = e->env[i + 1]; }
                    float frac = (float)(pos - i);
                    e->out[out_n++] = x0 * (1.0f - frac) + x1 * frac;
                    pos += alpha;
                }
                e->resample_pos = pos - FASTFIR_OUTBUF_SIZE;
                e->prev = e->env[FASTFIR_OUTBUF_SIZE - 1];

                size_t total_written = 0;
                size_t to_write = sizeof(float) * out_n;
                char *data_ptr = (char *)e->out;

                while (total_written < to_write) {
                    ssize_t n = write(e->input_fd, data_ptr + total_written, to_write - total_written);
                    if (n <= 0) {
                        // perror("vhf_acars: write() failed");
                        acars_close(rx_chan);
                        break;
                    }
                    total_written += n;
                }

                if (total_written != to_write) {
                    // one-shot warning only (avoid flooding the admin log)
                    if (!e->dbg_write) {
                        e->dbg_write = true;
                        printf("vhf_acars: write() incomplete\n");
                    }
                    break;
                }

                static int acars_dbg_written = 0;
                if (to_write > 0 && !acars_dbg_written) {
                    acars_dbg_written = 1;
                    ext_send_msg(rx_chan, false, "EXT DBG first_write bytes=%d", (int)to_write);
                }
            }

            e->rd_pos = (rd_pos+1) & (N_DPBUF-1);
        }
    }
}

static void acarsdec_task(void *param)
{
    int rx_chan = (int) FROM_VOID_PARAM(param);
    acars_chan_t *e = &acars_chan[rx_chan];

    sprintf(e->fifo_path, "/tmp/acarsV2_rx%d.raw", rx_chan);
    unlink(e->fifo_path);
    if (mkfifo(e->fifo_path, 0600) == -1) {
        printf("vhf_acars: mkfifo(%s) failed\n", e->fifo_path);
        e->acarsdec_tid = 0;
        return;
    }

    int out_pipe[2];
    if (pipe(out_pipe) == -1) {
        printf("vhf_acars: pipe() failed\n");
        e->acarsdec_tid = 0;
        return;
    }

    pid_t pid = fork();
    if (pid == -1) {
        printf("vhf_acars: fork() failed\n");
        close(out_pipe[0]);
        close(out_pipe[1]);
        e->acarsdec_tid = 0;
        return;
    }

    if (pid == 0) { // Child process
        close(out_pipe[0]);  // Close unused read end

        dup2(out_pipe[1], STDOUT_FILENO);
        dup2(out_pipe[1], STDERR_FILENO);

        close(out_pipe[1]);

        char rate_mult_str[8];
        int rate_mult = snd_rate / 12000;
        if (rate_mult < 1) rate_mult = 1;
        sprintf(rate_mult_str, "%d", rate_mult);

        char sndfile_arg[96];
        sprintf(sndfile_arg, "file=%s,subtype=0x6,channels=1", e->fifo_path);

        char freq_str[16];
        sprintf(freq_str, "%.3f", e->freq / 1000.0);

        execlp("/media/mmcblk0p1/acarsdec",
            "/media/mmcblk0p1/acarsdec",
            "--sndfile", sndfile_arg,
            "--output", "full:file",
            "-m", rate_mult_str,
            freq_str, NULL
        );
        perror("execlp");
        exit(EXIT_FAILURE);
    } else {
        close(out_pipe[1]);  // Close unused write end

        e->pid = pid;
        e->output_pipe = out_pipe[0];

        // open FIFO read+write end; O_RDWR never blocks, so no deadlock if acarsdec is slow to open
        e->input_fd = open(e->fifo_path, O_RDWR);
        if (e->input_fd == -1) {
            perror("vhf_acars: open() fifo failed");
            acars_close(rx_chan);
            return;
        }
        ext_send_msg(e->rx_chan, false, "EXT DBG fifo_open pid=%d fifo=%s", pid, e->fifo_path);

        // forward acarsdec stdout to the browser. The server does not always
        // call close_conn() on client disconnect, which would leave the
        // acarsdec process + FIFO behind on a locked rx channel. So poll with a
        // 1s timeout and self-terminate when the extension client is gone.
        while (1) {
            // check the extension client connection is still alive
            ext_users_t *eusr = &ext_users[rx_chan];
            if (!eusr->valid || eusr->conn_ext == NULL || !eusr->conn_ext->valid) {
                ext_send_msg(e->rx_chan, false, "EXT DBG client_gone");
                break;
            }
            if (e->output_pipe <= 0)
                break;

            struct pollfd pfd;
            pfd.fd = e->output_pipe;
            pfd.events = POLLIN;
            int pr = poll(&pfd, 1, 1000);

            if (pr > 0 && (pfd.revents & POLLIN)) {
                char buffer[1024];
                ssize_t n = read(e->output_pipe, buffer, sizeof(buffer) - 1);
                if (n > 0) {
                    ext_send_msg_encoded(e->rx_chan, false, "EXT", "chars", "%.*s", (int)n, buffer);
                }
                else if (n <= 0) {
                    ext_send_msg(e->rx_chan, false, "EXT DBG pipe_closed n=%d", (int)n);
                    break;
                }
            }
            else if (pr == 0) {
                // timeout: loop around and re-check the client connection
            }
            else {
                break;	// poll error (e.g. pipe closed by acars_close)
            }
        }

        e->acarsdec_tid = 0;
        acars_close(rx_chan);
    }

    e->acarsdec_tid = 0;
}

void acars_close(int rx_chan)
{
    acars_chan_t *e = &acars_chan[rx_chan];
    if (e->closing) return;	// already closing (called from server thread and/or acarsdec task)
    e->closing = true;
    printf("vhf_acars: close rx=%d tid=%d acarsdec_tid=%d\n", rx_chan, e->tid, e->acarsdec_tid);

    if (e->pid) {
        kill(e->pid, SIGTERM);
        close(e->input_fd);
        close(e->output_pipe);
        waitpid(e->pid, NULL, 0);
        e->input_fd = 0;
        e->output_pipe = 0;
        e->pid = 0;
    }

    if (e->tid) {
        TaskRemove(e->tid);
        e->tid = 0;
    }

    if (e->fifo_path[0]) {
        unlink(e->fifo_path);
        e->fifo_path[0] = 0;
    }

    ext_unregister_receive_iq_samps_task(e->rx_chan);
    ext_unregister_receive_cmds(e->rx_chan);
}

bool acars_receive_cmds(u2_t key, char *cmd, int rx_chan)
{
    if (key == CMD_TUNE) {
        char *mode_m;
        double locut, hicut, freq;
        int mparam;
        int n = sscanf(cmd, "SET mod=%16ms low_cut=%lf high_cut=%lf freq=%lf param=%d", &mode_m, &locut, &hicut, &freq, &mparam);
        if (n == 4 || n == 5) {
            acars_chan_t *e = &acars_chan[rx_chan];
            e->tuned_f = freq;
            // Kiwi SDR retunes the RF frontend itself; acarsdec (sndfile input) decodes
            // whatever audio it gets, so no decoder restart is needed here.
            printf("vhf_acars: CMD_TUNE freq=%.2f mode=%s\n", freq, mode_m);
            kiwi_asfree(mode_m);
            return true;
        }
    }

    return false;
}

bool acars_msgs(char *msg, int rx_chan)
{
    acars_chan_t *e = &acars_chan[rx_chan];

    //printf("### acars_msgs RX%d <%s>\n", rx_chan, msg);

    if (strcmp(msg, "SET ext_server_init") == 0) {
        e->rx_chan = rx_chan;	// remember our receiver channel number

        ext_send_msg(e->rx_chan, false, "EXT DBG init rx=%d", rx_chan);
        ext_send_msg(e->rx_chan, false, "EXT ready airband=%d", kiwi.airband ? 1 : 0);
        return true;
    }

    if (strcmp(msg, "SET start") == 0) {
        //printf("vhf_acars: start\n");
        e->closing = false;

        // The extension only works on the VHF airband path (ADC clock 100.7616 MHz,
        // 12300 Hz audio rate, 1.025 resampler). In HF/shortwave mode (airband off)
        // the frontend cannot receive 131 MHz and the resampler pitch would be wrong.
        // Warn the browser so the user knows why nothing is decoded, and do NOT start
        // acarsdec (it would error out with the HF frequency as invalid).
        if (!kiwi.airband) {
            ext_send_msg(e->rx_chan, false, "EXT WARN airband_off");
            return true;
        }

        // acars_tune() in vhf_acars.js sends the DSP frequency (RF - freq_offset_kHz).
        // Reconstruct the RF frequency here; acarsdec (VHF ACARS) needs it as its
        // channel label. Fall back to the standard US ACARS channel if untuned.
        e->freq = (e->tuned_f != 0.0) ? (e->tuned_f + freq_offset_kHz) : 131725.0;
        ext_send_msg(e->rx_chan, false, "EXT DBG start rx=%d freq=%.3f", rx_chan, e->freq);

        if (!e->tid) {
            e->seq_init = false;
            e->resample_pos = 0.0;
            e->prev = 0.0f;
            e->tid = CreateTaskF(acars_task, TO_VOID_PARAM(rx_chan), EXT_PRIORITY, CTF_RX_CHANNEL | (rx_chan & CTF_CHANNEL));
        }

        ext_register_receive_iq_samps_task(e->tid, rx_chan, POST_AGC);

        if (!e->acarsdec_tid)
            e->acarsdec_tid = CreateTaskF(acarsdec_task, TO_VOID_PARAM(rx_chan), EXT_PRIORITY, CTF_RX_CHANNEL | (rx_chan & CTF_CHANNEL));

        ext_register_receive_cmds(acars_receive_cmds, rx_chan);
        return true;
    }

    if (strcmp(msg, "SET stop") == 0) {
        //printf("vhf_acars: stop\n");
        acars_close(e->rx_chan);
        return true;
    }

    return false;
}

void vhf_acars_main();

ext_t acars_ext = {
    "vhf_acars",
    vhf_acars_main,
    acars_close,
    acars_msgs,
};

void vhf_acars_main()
{
    acars.nom_rate = snd_rate;
    acars.resample_alpha = VHF_ACARS_RESAMPLE_ALPHA;	// default until calibrated

    ext_register(&acars_ext);

    for (int rx_chan = 0; rx_chan < MAX_RX_CHANS; rx_chan++) {
        acars_chan_t *e = &acars_chan[rx_chan];
        memset(e, 0, sizeof(acars_chan_t));
        e->env = (float *) kiwi_malloc("acars env", sizeof(float) * FASTFIR_OUTBUF_SIZE);
        e->out = (float *) kiwi_malloc("acars out", sizeof(float) * FASTFIR_OUTBUF_SIZE);
        e->cal_buf = (float *) kiwi_malloc("acars cal", sizeof(float) * VHF_ACARS_CAL_N);
    }
}
