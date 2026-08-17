// Copyright 2026 by Holger Nyga — https://github.com/satdelight
//
// JS8Call decoder — browser-side extension.
//
// All decoding happens in the browser: this script runs the pure-JS decoder
// (js8_worker.js, see dist/) in a Web Worker and feeds it from the client
// audio callback (ext_register_audio_data_cb). No server CPU is used for
// decoding. The worker implements the complete chain in JavaScript
// (Bluestein FFT, sync, LLR, LDPC, message unpack) with no WASM dependency.
//
// Audio: the worker expects 12 kHz mono Int16 PCM frames prefixed with a
// 4-byte LE timestamp, i.e. the exact frame layout of the demo decoder.
// If the client sample rate (audio_input_rate) is 24/36 kHz we decimate to
// 12 kHz before forwarding.

var js8call = {
   ext_name: 'JS8Call',     // must match JS8Call.cpp:JS8Call_ext.name (= directory name)
   first_time: true,

   dataH: 300,
   dataW: 1024,
   ctrlW: 620,
   ctrlH: 80,

   modeId: 1,           // 0=Slow 1=Normal 2=Fast 3=Turbo
   running: false,
   worker: null,
   wasmReady: false,
   pending_start: false,

   sfmt: 'w3-text-red w3-ext-retain-input-focus',
   mode_s: [ 'Slow (30 s)', 'Normal (15.6 s)', 'Fast (10 s)', 'Turbo (6 s)' ],

   freq: 14078,         // current dial frequency (kHz), default 20 m
   pb: { lo: 0, hi: 3000 },   // JS8Call signals occupy 300-3000 Hz above dial
   saved_mode: null,
   freqs: [
      { n: '3.578 MHz (80 m)',  v: 3578 },
      { n: '5.018 MHz (60 m)',  v: 5018 },
      { n: '7.078 MHz (40 m)',  v: 7078 },
      { n: '10.130 MHz (30 m)', v: 10130 },
      { n: '14.078 MHz (20 m)', v: 14078 },
      { n: '18.104 MHz (17 m)', v: 18104 },
      { n: '21.078 MHz (15 m)', v: 21078 },
      { n: '24.920 MHz (12 m)', v: 24920 },
      { n: '28.078 MHz (10 m)', v: 28078 },
      { n: '27.245 MHz (CB)', v: 27245 }
   ],

   log_txt: '',
   status: '',

   console_status_msg_p: {
      no_decode: true, scroll_only_at_bottom: true, process_return_alone: false, remove_returns: true,
      cols: 135, max_lines: 1024
   }
};

function JS8Call_main()
{
	ext_switch_to_client(js8call.ext_name, js8call.first_time, js8call_recv);		// tell server to use us (again)
	// (re)build the panel on every open: on the first open the panel content
	// must be created, and after a close/reopen it must be re-created
	// (extint_panel_show() replaces the controls container HTML each time).
	js8call_controls_setup();
	js8call.first_time = false;

	if (!js8call.worker) {
		js8call.saved_mode = ext_get_mode();
		js8call_tune(js8call.freq);
	}

	// receive the network-rate, post-decompression, real-mode samples
	ext_register_audio_data_cb(js8call_audio_data_cb);

	// NOTE: decoder is NOT auto-started. The user picks a mode and presses
	// the Start button (js8call_start_click). This keeps the browser/audio busy
	// only while JS8Call is actually in use.
}

function js8call_recv(data)
{
	// browser-only extension: no server messages expected
}

function JS8Call_blur()
{
	js8call_worker_stop();
	w3_button_text('id-js8call-start', 'Start');
	if (js8call.saved_mode)
		ext_set_mode(js8call.saved_mode);
	ext_unregister_audio_data_cb(js8call_audio_data_cb);
}

function js8call_controls_setup()
{
	var data_html =
		time_display_html('js8call') +

		w3_div('id-js8call-data w3-display-container|left:0px; width:'+ px(js8call.dataW) +'; height:'+ px(js8call.dataH) +'; overflow:hidden; background-color:black;',
			w3_div('id-js8call-console-msg w3-text-output w3-scroll-down w3-small w3-text-black|width:'+ px(js8call.dataW) +'; position:absolute; overflow-x:hidden;',
				w3_code('id-js8call-console-msgs w3-text-output-striped/')
			)
		);

	var controls_html =
		w3_div('id-js8call-controls w3-text-white',
			w3_div('w3-tspace-8',
				w3_inline('w3-valign/',
					w3_div('w3-show-inline-block w3-medium w3-text-aqua',
						'<b>JS8Call decoder</b>'),
					w3_div('id-js8call-status w3-text-css-yellow w3-margin-L-16', '&nbsp;')
				),

				w3_inline('w3-valign/w3-margin-between-16',
					w3_select(js8call.sfmt +' w3-label-inline', 'Frequency', '', 'js8call.freq', 4, js8call.freqs.map(function(f) { return f.n; }), 'js8call_freq_cb'),
					w3_select(js8call.sfmt, '', 'mode', 'js8call.modeId', W3_SELECT_SHOW_TITLE, js8call.mode_s, 'js8call_mode_cb'),
					w3_button_path('w3-button w3-tiny', 'id-js8call-start', 'Start', 'js8call_start_click')
				)
			)
		);

	ext_panel_show(controls_html, data_html, null);

	time_display_setup('js8call');
	ext_set_data_height(js8call.dataH);
	ext_set_controls_width_height(js8call.ctrlW, js8call.ctrlH);
	JS8Call_environment_changed({resize:true});
}

function js8call_freq_cb(path, idx, first)
{
	if (first) return;
	js8call_tune(js8call.freqs[idx].v);
}

function js8call_tune(f_kHz)
{
	js8call.freq = f_kHz;
	ext_set_mode('usb');
	ext_tune(f_kHz, 'usb', ext_zoom.CUR, null, js8call.pb.lo, js8call.pb.hi);
}

function js8call_mode_cb(path, idx, first)
{
	if (first) return;
	js8call.modeId = +idx;
	w3_set_value(path, +idx);     // for benefit of direct callers
	if (js8call.worker && js8call.running)
		js8call.worker.postMessage({ type: 'set-mode', mode: js8call.modeId });
}

function js8call_start_click()
{
	if (js8call.running) {
		js8call_worker_stop();
		w3_button_text('id-js8call-start', 'Start');
		js8call_status('Stopped.');
	} else {
		js8call.pending_start = true;
		js8call_worker_start();
		js8call_output('— JS8Call decoding '+ js8call.mode_s[js8call.modeId] +' —\n');
		js8call_status('Starting…');
	}
}

function js8call_worker_start()
{
	if (js8call.worker) return;
	js8call.running = true;
	js8call.wasmReady = false;

	js8call.worker = new Worker(kiwi_url_origin() +'/extensions/JS8Call/dist/js8_worker.js');
	js8call.worker.onerror = function(e) {
		console.error('[JS8Call] worker error:', e);
		js8call_status('Worker error: '+ e.message);
	};
	js8call.worker.onmessage = function(e) {
		var data = e.data;
		switch (data.type) {
		case 'ready':
			js8call.wasmReady = data.wasm;
			js8call_status(data.msg);
			if (js8call.pending_start) {
				js8call.pending_start = false;
				js8call.worker.postMessage({ type: 'start', mode: js8call.modeId, freqMin: 200, freqMax: 3000 });
				w3_button_text('id-js8call-start', 'Stop');
				js8call_status('Buffering — '+ js8call.mode_s[js8call.modeId] +' mode…');
			}
			break;
		case 'decoded':
			js8call_decoded(data.messages, data.slotTime);
			break;
		case 'error':
			console.error('[JS8Call] decode error:', data.msg);
			js8call_status('Error: '+ data.msg);
			break;
		}
	};
}

function js8call_worker_stop()
{
	js8call.running = false;
	if (js8call.worker) {
		js8call.worker.postMessage({ type: 'stop' });
		js8call.worker.terminate();
		js8call.worker = null;
	}
}

function js8call_audio_data_cb(samps, nsamps)
{
	if (!js8call.running || !js8call.worker) return;

	// Decimate to the 12 kHz the decoder expects (audio_input_rate is the
	// client sample rate: 12/24/36 kHz).
	var rate = (window.audio_input_rate || 12000);
	var decim = Math.round(rate / 12000);
	if (decim < 1) decim = 1;
	var nout = Math.floor(nsamps / decim);
	if (nout <= 0) return;

	var buf = new ArrayBuffer(4 + nout * 2);
	var v32 = new DataView(buf);
	v32.setUint32(0, Date.now() & 0xffffffff, true);
	var i16 = new Int16Array(buf, 4);

	if (decim == 1) {
		for (var i = 0; i < nout; i++) i16[i] = samps[i];
	} else {
		// simple boxcar decimation (good enough for a prototype)
		var o = 0;
		for (var i = 0; i + decim <= nsamps; i += decim) {
			var sum = 0;
			for (var d = 0; d < decim; d++) sum += samps[i + d];
			i16[o++] = sum / decim;
		}
	}

	js8call.worker.postMessage({ type: 'audio', buffer: buf }, [ buf ]);
}

function js8call_output(s)
{
	var a = s.split('');
	a.forEach(function(ch, i) {
		if (ch == '<') a[i] = kiwi.esc_lt;
		else
		if (ch == '>') a[i] = kiwi.esc_gt;
	});
	js8call.console_status_msg_p.s = a.join('');
	kiwi_output_msg('id-js8call-console-msgs', 'id-js8call-console-msg', js8call.console_status_msg_p);
	if (s.endsWith('\n')) s = s.slice(0, -1);
	js8call.log_txt += s +'\n';
}

function js8call_decoded(messages, slotTime)
{
	for (var i = 0; i < messages.length; i++) {
		var m = messages[i];
		var line = slotTime +'  '+
			(m.snr != null? m.snr.toFixed(1)+' dB' : '---') +'  '+
			(			m.freq ? m.freq.toFixed(0)+' Hz' : '---') +'  '+
			m.msg + '\n';
		js8call_output(line);
	}
	js8call_status(messages.length > 0
		? messages.length +' message(s) @ '+ slotTime
		: 'No signals @ '+ slotTime);
}

function js8call_status(s)
{
	if (s) js8call.status = s;
	var el = w3_el('id-js8call-status');
	if (el) el.innerHTML = s;
}

function JS8Call_help(show)
{
	if (show) {
		var s = '<h2>JS8Call Decoder</h2>' +
			'<p>Browser-side JS8Call decoder extension. All decoding happens in the browser ' +
			'using a pure-JS implementation of the JS8Call protocol.</p>' +
			'<p><b>Usage:</b> Select a frequency band and mode, then press Start. ' +
			'Decoded messages appear in the output window.</p>' +
			'<p><b>Modes:</b> Slow (30 s), Normal (15.6 s), Fast (10 s), Turbo (6 s)</p>' +
			'<p><b>Bands:</b> 80 m through 10 m + CB (27.245 MHz)</p>' +
			'<p><a href="https://en.wikipedia.org/wiki/JS8Call" target="_blank">More about JS8Call on Wikipedia</a></p>';
		confirmation_show_content(s, 610, 430);
	}
	return true;
}

function JS8Call_environment_changed(changed)
{
	if (changed.resize) {
		var el = w3_el('id-js8call-data');
		if (!el) return;
		var left = Math.max(0, (window.innerWidth - js8call.dataW - time_display_width()) / 2);
		el.style.left = px(left);
	}
}

// called by the admin interface to display configuration parameters
function JS8Call_config_html()
{
	ext_config_html(js8call, 'JS8Call', 'JS8Call', 'JS8Call configuration');
}
