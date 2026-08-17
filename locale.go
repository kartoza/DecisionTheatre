package main

import (
	"log"
	"os"
)

// ensureNumericLocale pins LC_NUMERIC to "C" before GTK initialises.
//
// # WHY
//
// GTK calls setlocale(LC_ALL, "") during initialisation, taking the locale from
// the environment. If the named locale is not installed — which is easy to
// arrange on NixOS, where LANG is commonly set to a locale that was never built
// into the system — GTK reports
//
//	Gtk-WARNING: Locale not supported by C library. Using the fallback 'C' locale.
//
// and falls back. WebKit's own numeric parsing does not necessarily follow it,
// and the two disagree about what a decimal point means. A scale factor
// formatted as "1.000000" is then read with the dot taken as a thousands
// separator, giving 1000000.
//
// That is not a hypothetical. It is what this application did: `--diag`
// reported a layout viewport of 1268000000 CSS pixels for a 1268-pixel window,
// a root font size of 9000000px, and a window.innerWidth that had overflowed to
// -121728 — every dimension a factor of a million out. The page rendered as an
// unreadable sliver, and laying out a 1.27-billion-pixel canvas made the whole
// machine unresponsive.
//
// LC_NUMERIC governs exactly one thing: how numbers are formatted and parsed.
// Forcing it to "C" guarantees the dot is a decimal point for every library in
// the process, and leaves LC_CTYPE, LC_TIME and the rest alone so text and
// dates still honour the user's locale.
//
// The setting is inherited by the GTK and WebKit code that follows, so it must
// happen before webview.New.
func ensureNumericLocale() {
	// An explicit LC_ALL outranks LC_NUMERIC, so it has to be narrowed too, or
	// the setting below has no effect.
	if lcAll := os.Getenv("LC_ALL"); lcAll != "" && lcAll != "C" && lcAll != "C.UTF-8" {
		log.Printf("Locale: LC_ALL=%s overrides numeric formatting; unsetting it for this process", lcAll)
		if err := os.Unsetenv("LC_ALL"); err != nil {
			log.Printf("Warning: could not unset LC_ALL: %v", err)
		}
		// Preserve the character encoding the user asked for.
		if os.Getenv("LC_CTYPE") == "" {
			if err := os.Setenv("LC_CTYPE", lcAll); err != nil {
				log.Printf("Warning: could not set LC_CTYPE: %v", err)
			}
		}
	}

	if err := os.Setenv("LC_NUMERIC", "C"); err != nil {
		log.Printf("Warning: could not pin LC_NUMERIC: %v", err)
	}
}
