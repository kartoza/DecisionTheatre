package main

import (
	"log"
	"os"
	"strings"
)

// ensureUsableDisplayBackend picks a GDK backend the WebView can lay out
// against, before GTK initialises.
//
// # WHY
//
// On a Wayland session with fractional scaling — COSMIC, and GNOME with
// scale-monitor-framebuffer, among others — WebKitGTK 2.5x computes a device
// scale factor that is wrong by orders of magnitude. `dt run --diag` on such a
// session reported, for a 1268-pixel window:
//
//	documentElement.clientWidth: 1268000003
//	body font-size:              9000000px
//	window.innerWidth:           -121728      (32-bit overflow)
//
// Every dimension a factor of 10^6 out. The page renders as an unreadable
// sliver, and laying out a 1.27-billion-pixel canvas takes the machine down
// with it.
//
// Under XWayland the scale factor is an integer and the same page lays out
// correctly, so the desktop window asks for the X11 backend unless told
// otherwise. The cost is that XWayland can look soft on a HiDPI display; that
// is a better failure than an unusable window.
//
// Set DT_GDK_BACKEND to override — DT_GDK_BACKEND=wayland to insist on
// Wayland, or any value GDK_BACKEND accepts. An explicit GDK_BACKEND in the
// environment is always respected and never overridden.
func ensureUsableDisplayBackend() {
	// An explicit choice by the operator wins, whichever variable carries it.
	if override := os.Getenv("DT_GDK_BACKEND"); override != "" {
		log.Printf("Display: using GDK backend %q (DT_GDK_BACKEND)", override)
		setEnv("GDK_BACKEND", override)
		return
	}

	current := os.Getenv("GDK_BACKEND")

	// A backend naming exactly one option is a deliberate choice; leave it.
	if current != "" && !strings.Contains(current, ",") {
		return
	}

	// Only worth doing on a Wayland session, and only when there is an X
	// server to fall back to.
	onWayland := os.Getenv("WAYLAND_DISPLAY") != "" ||
		strings.EqualFold(os.Getenv("XDG_SESSION_TYPE"), "wayland")
	if !onWayland {
		return
	}
	if os.Getenv("DISPLAY") == "" {
		// No XWayland to fall back to; leave the environment alone rather than
		// asking for a backend that cannot start.
		log.Printf("Display: Wayland session with no X display; leaving GDK_BACKEND as %q", current)
		return
	}

	log.Printf("Display: Wayland session detected — using the X11 backend, " +
		"because WebKitGTK miscomputes the scale factor under Wayland fractional scaling. " +
		"Set DT_GDK_BACKEND=wayland to override.")

	setEnv("GDK_BACKEND", "x11")

	// Belt and braces: pin the scale factors so a stray fractional value in the
	// environment cannot reintroduce the same fault through XWayland.
	if os.Getenv("GDK_SCALE") == "" {
		setEnv("GDK_SCALE", "1")
	}
	if os.Getenv("GDK_DPI_SCALE") == "" {
		setEnv("GDK_DPI_SCALE", "1")
	}
}

func setEnv(key, value string) {
	if err := os.Setenv(key, value); err != nil {
		log.Printf("Warning: could not set %s: %v", key, err)
	}
}
