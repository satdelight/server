// Copyright 2026 by Holger Nyga — https://github.com/satdelight
//
// JS8Call decoder extension (browser-side).
//
// All decoding happens in the browser: web/extensions/JS8Call/JS8Call.js runs
// the pure-JS decoder (dist/js8_worker.js) in a Web Worker and feeds it
// from the client audio callback (ext_register_audio_data_cb). This C-side
// stub exists only so the extension appears in the client extension menu
// (extint list is built from server-registered extensions) and so the EXT
// channel is properly set up for the browser client.

#include "ext.h"	// all calls to the extension interface begin with "ext_", e.g. ext_register()

#include "kiwi.h"

#include <stdio.h>
#include <unistd.h>
#include <stdlib.h>
#include <strings.h>

//#define DEBUG_MSG	true
#define DEBUG_MSG	false

// rx_chan is the receiver channel number we've been assigned, 0..rx_chans

typedef struct {
	int rx_chan;
	int run;
} js8call_t;

static js8call_t js8call[MAX_RX_CHANS];

bool js8call_msgs(char *msg, int rx_chan)
{
	js8call_t *e = &js8call[rx_chan];
	int n;

	if (strcmp(msg, "SET ext_server_init") == 0) {
		e->rx_chan = rx_chan;	// remember our receiver channel number
		ext_send_msg(e->rx_chan, DEBUG_MSG, "EXT ready");
		return true;
	}

	n = sscanf(msg, "SET run=%d", &e->run);
	if (n == 1) {
		return true;
	}

	return false;
}

void JS8Call_main();

ext_t JS8Call_ext = {
	"JS8Call",
	JS8Call_main,
	NULL,
	js8call_msgs,
};

void JS8Call_main()
{
	ext_register(&JS8Call_ext);
}
