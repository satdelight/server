// VHF ACARS decoder extension
// Decodes VHF ACARS via acarsdec by Thierry Leconte
// Copyright (c) 2026 Holger Nyga, https://github.com/satdelight
// Licensed under GPL-2.0

var acars = {
   ext_name: 'vhf_acars',    // NB: must match vhf_acars.cpp:acars_ext.name
   first_time: true,
   dataH: 445,
   dataW: 1024,
   ctrlW: 600,
   ctrlH: 120,
   freq: 0,
   sfmt: 'w3-text-red w3-ext-retain-input-focus',
   pb: { lo: -5000, hi: 5000 },

   freqs: [
      { n: '131.550 MHz (ARINC worldwide)', v: 131550 },
      { n: '129.125 MHz (US/CA)', v: 129125 },
      { n: '130.025 MHz (US/CA)', v: 130025 },
      { n: '130.425 MHz (US)',   v: 130425 },
      { n: '130.450 MHz (US/CA)', v: 130450 },
      { n: '131.125 MHz (US)',   v: 131125 },
      { n: '131.450 MHz (Japan)', v: 131450 },
      { n: '131.475 MHz (Air Canada)', v: 131475 },
      { n: '131.525 MHz (SITA secondary EU)', v: 131525 },
      { n: '131.725 MHz (SITA primary EU)',   v: 131725 },
      { n: '131.825 MHz (EU)',  v: 131825 }
   ],

   console_status_msg_p: { scroll_only_at_bottom: true, process_return_alone: false, remove_returns: true, cols: 135 },
   log_txt: '',
   pending: ''
};

function vhf_acars_main()
{
	ext_switch_to_client(acars.ext_name, acars.first_time, acars_recv);		// tell server to use us (again)
	if (!acars.first_time)
		acars_controls_setup();
	acars.first_time = false;
}

function acars_recv(data)
{
	var firstChars = arrayBufferToStringLen(data, 3);

	// process data sent from server/C by ext_send_msg_data()
	if (firstChars == "DAT") {
		console.log('acars_recv: DATA UNKNOWN');
		return;
	}

	// process command sent from server/C by ext_send_msg() or ext_send_msg_encoded()
	// Only the first token is the command; the rest are arguments (may contain
	// spaces, e.g. the DBG calibration messages), so do NOT loop over all tokens.
	var stringData = arrayBufferToString(data);
	var params = stringData.substring(4).split(" ");
	var param = params[0].split("=");

	switch (param[0]) {

		case "ready":
			acars.airband = false;
			for (var j=1; j < params.length; j++) {
				var pj = params[j].split("=");
				if (pj[0] == "airband")
					acars.airband = (pj[1] == "1");
			}
			acars_controls_setup();
			break;

		case "chars":
			var s = kiwi_decodeURIComponent('', param[1]);
			acars_decoder_output_chars(s);
			break;

		case "WARN":
			if (params[1] == "airband_off")
				acars_warn(
					'<b>Warning:</b> The Web-888 is in HF (shortwave) mode, not Airband mode. ' +
					'VHF ACARS cannot be received. Enable <b>Airband</b> in the admin ' +
					'configuration and reboot the receiver.');
			break;

		case "DBG":
			// calibration result: show it in the decoder output window (like the
			// acarsdec "Starting..." message)
			if (params[1] == "cal" && params[2] == "SET") {
				acars.console_status_msg_p.s =
					encodeURIComponent(stringData.substring(4).replace(/^DBG cal SET /, ''));
				kiwi_output_msg('id-acars-console-msgs', 'id-acars-console-msg', acars.console_status_msg_p);
			}
			break;

		default:
			console.log('acars_recv: UNKNOWN CMD '+ param[0]);
			break;
	}
}

function acars_utc_ts()
{
   var d = new Date();
   return sprintf('%04d-%02d-%02d %02d:%02d:%02d UTC',
      d.getUTCFullYear(), d.getUTCMonth()+1, d.getUTCDate(),
      d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
}

function acars_decoder_output_chars(c)
{
   if (c == '\f') {
      acars.log_txt = '';
      acars.pending = '';
      acars.console_status_msg_p.s = c;     // NB: already encoded on C-side
      kiwi_output_msg('id-acars-console-msgs', 'id-acars-console-msg', acars.console_status_msg_p);
      return;
   }

   // acarsdec output arrives in chunks that can split messages mid-line.
   // Accumulate complete lines; reformat the message header and body.
   acars.pending += c;
   var nl = acars.pending.lastIndexOf('\n');
   if (nl == -1) return;   // wait for the rest of the line

   var s = '';
   var complete = acars.pending.substring(0, nl + 1);
   acars.pending = acars.pending.substring(nl + 1);

   var lines = complete.split('\n');
   for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.indexOf('[#') == 0) {
         // acarsdec opens '[' without closing it. Close it after the UTC timestamp:
         // '[#1 (L:...E:0) ... ----' -> '[#1 (L:...E:0) 2026-... UTC] ----'
         var close = line.indexOf(')');
         if (close != -1)
            line = line.substring(0, close + 1) + ' ' + acars_utc_ts() + ']' +
                   line.substring(close + 1).replace(/^\s*/, ' ').replace(/-+/, '----------');
      }
      line = line.replace(/ : /g, ': ');   // 'Mode : 2' -> 'Mode: 2'
      s += line + '\n';
   }

   acars.log_txt += kiwi_remove_escape_sequences(s);

   acars.console_status_msg_p.s = s;     // NB: already encoded on C-side

   // kiwi_output_msg() does decodeURIComponent()
   kiwi_output_msg('id-acars-console-msgs', 'id-acars-console-msg', acars.console_status_msg_p);
}

function acars_controls_setup()
{
   var wh = sprintf('width:%dpx; height:%dpx;', acars.dataW, acars.dataH);

   // The decoder window is only meaningful in VHF airband mode (131 MHz).
   // In HF/shortwave mode the frontend can't receive it and the 1.025
   // resampler pitch would be wrong, so show controls + warning only.
   var data_html = '';
   if (acars.airband) {
      data_html =
         time_display_html('acars') +
         w3_div('id-acars-data w3-display-container|left:0px; '+ wh,
            w3_div('id-acars-msgs|'+ wh +'; z-index:1; overflow:hidden; position:absolute;',
               w3_div(sprintf('id-acars-console-msg w3-text-output w3-scroll-down w3-small w3-text-black|width:%dpx; position:absolute; overflow-x:hidden;', acars.dataW),
                  '<pre><code id="id-acars-console-msgs"></code></pre>'
               )
            )
         );
   }

 	var controls_html =
 		w3_div('id-acars-controls w3-text-white',
         w3_col_percent('w3-tspace-8 w3-valign/',
            w3_div('w3-medium w3-text-aqua w3-nowrap', '<b>VHF ACARS decoder</b>'), 35,
            w3_div('w3-nowrap', 'From <b><a href="https://github.com/f00b4r0/acarsdec" target="_blank">acarsdec</a></b> by Thierry Leconte')
         ),

         w3_div('id-acars-warn w3-margin-T-8|width:100%')

         + (acars.airband ?
         w3_inline('w3-margin-T-8 w3-valign/w3-margin-between-12',
            w3_inline('w3-valign-end w3-round-large w3-padding-small w3-text-white w3-grey/',
               w3_select(acars.sfmt, 'Frequency', '', 'acars.freq', 1,
                  acars.freqs.map(function(f) { return f.n; }), 'acars_freq_cb')
            ),
            w3_button('w3-padding-smaller w3-css-yellow', 'Clear', 'acars_clear_cb'),
            w3_button('w3-padding-smaller w3-purple', 'Download', 'acars_log_cb')
         )
         : '')
      );

	ext_panel_show(controls_html, data_html, null);
	ext_set_controls_width_height(acars.ctrlW, acars.ctrlH);

	acars.saved_mode = ext_get_mode();

	if (!acars.airband) {
		acars_warn(
			'<b>Warning:</b> The Web-888 is in HF (shortwave) mode, not Airband mode. ' +
			'VHF ACARS cannot be received. Enable <b>Airband</b> in the admin ' +
			'configuration and reboot the receiver.');
		return;
	}

	time_display_setup('acars');
	ext_set_data_height(acars.dataH);

	vhf_acars_environment_changed( {resize:1, freq:1} );

	ext_send('SET start');
	ext_set_mode('iq');
	ext_set_passband(acars.pb.lo, acars.pb.hi);

	// dx.json labels may specify a frequency to tune to (e.g. {"p":"vhf_acars,*"})
	// via the label click path which replaces '*' with the label frequency.
	// If a label supplied a frequency, use it instead of the hardcoded default.
	var p = ext_param();
	var start_f_kHz = 131725;
	if (p) {
		var pe = p.split(',');
		var f = parseFloat(pe[0]);
		if (isNumber(f) && f > 0) {
			start_f_kHz = f;
		}
	}
	acars_tune(start_f_kHz);
}

function acars_warn(s)
{
   var el = w3_el('id-acars-warn');
   if (el) w3_innerHTML(el, '<div class="w3-text-css-yellow">'+ s +'</div>');
}

function acars_warn_clear()
{
   var el = w3_el('id-acars-warn');
   if (el) w3_innerHTML(el, '');
}

function acars_clear_cb(path, idx, first)
{
   if (first) return;
   acars_decoder_output_chars('\f');
}

function acars_log_cb(path, idx, first)
{
   if (first) return;
   var txt = new Blob([acars.log_txt], { type: 'text/plain' });
   var a = document.createElement('a');
   a.style = 'display: none';
   a.href = window.URL.createObjectURL(txt);
   a.download = kiwi_timestamp_filename('vhf_acars.', '.log.txt');
   document.body.appendChild(a);
   a.click();
   window.URL.revokeObjectURL(a.href);
   document.body.removeChild(a);

   // the log was downloaded; clear it so the next download only contains new messages.
   // the on-screen message window is intentionally left untouched.
   acars.log_txt = '';
}

function acars_freq_cb(path, idx, first)
{
	if (first) return;
	idx = +idx;
	acars_tune(acars.freqs[idx].v);
}

function acars_tune(f_kHz)
{
   if (!acars.airband) return;   // never tune 131 MHz in HF/shortwave mode
   if (dbgUs) console.log('acars_tune tx f='+ f_kHz.toFixed(2));
   f_kHz -= (kiwi.freq_offset_kHz || 0);   // DSP freq = RF - freq_offset (Web-888 VHF)
   acars.freq = f_kHz;
   ext_tune(f_kHz, 'iq', ext_zoom.CUR);
   ext_set_passband(acars.pb.lo, acars.pb.hi);
}

// automatically called on changes in the environment
function vhf_acars_environment_changed(changed)
{
   if (changed.resize) {
      var el = w3_el('id-acars-data');
      if (!el) return;
      var left = Math.max(0, (window.innerWidth - acars.dataW - time_display_width()) / 2);
      el.style.left = px(left);
   }
}

function vhf_acars_focus()
{
}

function vhf_acars_blur()
{
	ext_set_mode(acars.saved_mode);
	ext_send('SET stop');
}

// called by the admin interface to display configuration parameters
function vhf_acars_config_html()
{
   ext_config_html(acars, 'vhf_acars', 'VHF ACARS', 'VHF ACARS configuration');
}

function vhf_acars_help(show)
{
   if (show) {
      var s =
         w3_text('w3-medium w3-bold w3-text-aqua', 'VHF ACARS decoder help') +
         w3_div('w3-margin-T-8 w3-scroll-y|height:90%',
            w3_div('w3-margin-R-8',
               'This extension decodes VHF airband ACARS (MSK, 2400 bps) using the ' +
               '<a href="https://github.com/f00b4r0/acarsdec" target="_blank">acarsdec</a> ' +
               'decoder by Thierry Leconte. ' +
               'It is optimized for the VHF airband of the Web-888 (audio rate 12300 Hz, ' +
               'resampled by 1.025 for the decoder).' +

               '<br><br>Select a frequency from the <i>Frequency</i> dropdown. ' +
               'The extension switches the receiver to IQ mode and sets the passband ' +
               'to +/-5 kHz automatically. Decoded messages appear in the message window; ' +
               'the <i>Clear</i> button empties the message window and the collected log. ' +
               'The <i>Download</i> button saves the collected log to a file and then ' +
               'clears the log (but not the on-screen window), so each download only ' +
               'contains messages collected since the last one.' +

               '<br><br><b>Message format</b> — each message starts with a header line ' +
               'like<br>' +
               '<tt>[#1 (L:+74.3/64.6 E:0) 2026-08-07 09:05:18 UTC]</tt><br>' +
               'where the timestamp is the UTC time when the message was received.' +
               '<br><table>' +
               '<tr><td><tt>#1</tt></td><td>&nbsp;receiver channel number</td></tr>' +
               '<tr><td><tt>L:+74.3</tt></td><td>&nbsp;signal level of the message in dB</td></tr>' +
               '<tr><td><tt>/64.6</tt></td><td>&nbsp;noise floor (background) level in dB</td></tr>' +
                '<tr><td><tt>E:0</tt></td><td>&nbsp;number of bit errors corrected; 0 = decoded without errors</td></tr>' +
                '</table>'
            )
         );

      confirmation_show_content(s, 610, 430);
   }
   return true;
}
