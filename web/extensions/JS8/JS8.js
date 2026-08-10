// Copyright (c) 2026
//
// JS8Call decoder — browser-side extension prototype.
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

var js8 = {
   ext_name: 'JS8',     // NB: must match JS8.cpp:JS8_ext.name
   first_time: true,

   dataH: 300,
   ctrlW: 525,
   ctrlH: 120,

   modeId: 1,           // 0=Slow 1=Normal 2=Fast 3=Turbo
   running: false,
   worker: null,
   wasmReady: false,
   pending_start: false,

   sfmt: 'w3-text-red w3-ext-retain-input-focus',
   mode_s: [ 'Slow (30 s)', 'Normal (15.6 s)', 'Fast (10 s)', 'Turbo (6 s)' ],

   log_txt: '',
   status: '',

   console_status_msg_p: {
      no_decode: true, scroll_only_at_bottom: true, process_return_alone: false, remove_returns: true,
      cols: 135, max_lines: 1024
   }
};

function JS8_main()
{
	ext_switch_to_client(js8.ext_name, js8.first_time, js8_recv);		// tell server to use us (again)
	if (js8.first_time)
		js8_controls_setup();
	js8.first_time = false;

	// receive the network-rate, post-decompression, real-mode samples
	ext_register_audio_data_cb(js8_audio_data_cb);

	if (!js8.worker) {
		js8.pending_start = true;
		js8_worker_start();
	}
}

function js8_recv(data)
{
	// browser-only extension: no server messages expected
}

function JS8_blur()
{
	js8_worker_stop();
	ext_unregister_audio_data_cb(js8_audio_data_cb);
}

function js8_controls_setup()
{
	var data_html =
		time_display_html('js8') +

		w3_div('id-js8-data|left:150px; width:1044px; height:'+ px(js8.dataH) +'; overflow:hidden; position:relative; background-color:black;',
			w3_div('id-js8-console-msg w3-text-output w3-scroll-down w3-small w3-text-black|width:1024px; height:'+ px(js8.dataH) +'; position:absolute; overflow-x:hidden;',
				w3_code('id-js8-console-msgs w3-text-output-striped/')
			)
		);

	var controls_html =
		w3_div('id-js8-controls w3-text-white',
			w3_div('w3-tspace-8',
				w3_col_percent('',
					w3_div('w3-show-inline-block w3-medium w3-text-aqua',
						'<b><a href="https://en.wikipedia.org/wiki/JS8Call" target="_blank">JS8Call</a> decoder</b>'), 50,
					w3_div('id-js8-status w3-text-css-yellow', '&nbsp;'), 50
				),

				w3_inline('/w3-margin-between-16',
					w3_select(js8.sfmt, '', 'mode', 'js8.modeId', W3_SELECT_SHOW_TITLE, js8.mode_s, 'js8_mode_cb'),
					w3_button_path('w3-button w3-tiny', 'id-js8-start', 'Start', 'js8_start_click')
				)
			)
		);

	ext_panel_show(controls_html, data_html, null);

	ext_set_data_height(js8.dataH);
	ext_set_controls_width_height(js8.ctrlW, js8.ctrlH);
}

function js8_mode_cb()
{
	if (js8.worker && js8.running)
		js8.worker.postMessage({ type: 'set-mode', mode: js8.modeId });
}

function js8_start_click()
{
	if (js8.running) {
		js8_worker_stop();
		w3_text('id-js8-start', 'Start');
		js8_status('Stopped.');
	} else {
		js8.pending_start = true;
		js8_worker_start();
		js8_output('— JS8Call decoding '+ js8.mode_s[js8.modeId] +' —');
		js8_status('Starting…');
	}
}

function js8_worker_start()
{
	if (js8.worker) return;
	js8.running = true;
	js8.wasmReady = false;

	js8.worker = new Worker(kiwi_url_origin() +'/extensions/JS8/dist/js8_worker.js');
	js8.worker.onerror = function(e) {
		console.error('[JS8] worker error:', e);
		js8_status('Worker error: '+ e.message);
	};
	js8.worker.onmessage = function(e) {
		var data = e.data;
		switch (data.type) {
		case 'ready':
			js8.wasmReady = data.wasm;
			js8_status(data.msg);
			if (js8.pending_start) {
				js8.pending_start = false;
				js8.worker.postMessage({ type: 'start', mode: js8.modeId, freqMin: 200, freqMax: 3000 });
				w3_text('id-js8-start', 'Stop');
				js8_status('Buffering — '+ js8.mode_s[js8.modeId] +' mode…');
			}
			break;
		case 'decoded':
			js8_decoded(data.messages, data.slotTime);
			break;
		case 'error':
			console.error('[JS8] decode error:', data.msg);
			js8_status('Error: '+ data.msg);
			break;
		}
	};
}

function js8_worker_stop()
{
	js8.running = false;
	if (js8.worker) {
		js8.worker.postMessage({ type: 'stop' });
		js8.worker.terminate();
		js8.worker = null;
	}
}

function js8_audio_data_cb(samps, nsamps)
{
	if (!js8.running || !js8.worker) return;

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

	js8.worker.postMessage({ type: 'audio', buffer: buf }, [ buf ]);
}

function js8_output(s)
{
	var a = s.split('');
	a.forEach(function(ch, i) {
		if (ch == '<') a[i] = kiwi.esc_lt;
		else
		if (ch == '>') a[i] = kiwi.esc_gt;
	});
	js8.console_status_msg_p.s = a.join('');
	kiwi_output_msg('id-js8-console-msgs', 'id-js8-console-msg', js8.console_status_msg_p);
	js8.log_txt += s +'\n';
}

function js8_decoded(messages, slotTime)
{
	for (var i = 0; i < messages.length; i++) {
		var m = messages[i];
		var line = slotTime +'  '+
			(m.snr != null? m.snr.toFixed(1)+' dB' : '---') +'  '+
			(m.freq ? m.freq.toFixed(0)+' Hz' : '---') +'  '+
			m.msg;
		js8_output(line);
	}
	js8_status(messages.length > 0
		? messages.length +' message(s) @ '+ slotTime
		: 'No signals @ '+ slotTime);
}

function js8_status(s)
{
	if (s) js8.status = s;
	var el = w3_el('id-js8-status');
	if (el) el.innerHTML = s;
}
