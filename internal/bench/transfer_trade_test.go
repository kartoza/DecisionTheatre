package bench

import (
	"math"
	"testing"
)

// The measurement that prompted this file. Tour documents, 14 August against
// today, same machine and datapack:
//
//	                 14 Aug bytes   today bytes   14 Aug p50   today p50
//	tour-shai-hills       168,496        12,131      0.17 ms     1.54 ms
//	tour-viphya           455,813        32,471      0.36 ms     3.36 ms
//	tour-munywana         374,228        33,129      0.35 ms     3.02 ms
//
// The old method headlined this as "biggest regression: tour-viphya (+830%)" —
// the single best change of the week, reported as the worst.

func TestCompressionIsNotARegression(t *testing.T) {
	cases := []struct {
		name                    string
		beforeMs, afterMs       float64
		beforeBytes, afterBytes int64
	}{
		{"tour-shai-hills", 0.17, 1.54, 168496, 12131},
		{"tour-viphya", 0.36, 3.36, 455813, 32471},
		{"tour-munywana", 0.35, 3.02, 374228, 33129},
	}

	for _, c := range cases {
		base := runWith(result(c.name, c.beforeMs, scatter(c.beforeMs, 0.03, 20), c.beforeBytes))
		cur := runWith(result(c.name, c.afterMs, scatter(c.afterMs, 0.3, 20), c.afterBytes))

		d := findDelta(t, Compare(base, cur), c.name)
		if d.Verdict == Slower {
			t.Errorf("%s: a %s payload saving was reported as a regression",
				c.name, humanSize(c.beforeBytes-c.afterBytes))
		}
		if d.Verdict != Traded {
			t.Errorf("%s: expected a size-for-time trade, got %q", c.name, d.Verdict)
		}
		if !d.Trade.IsTrade || d.Trade.CrossoverMbps <= 0 {
			t.Errorf("%s: no crossover bandwidth computed", c.name)
		}
		// Every one of these breaks even far above any real connection, so on
		// any link a user actually has, the change is a win.
		if d.Trade.CrossoverMbps < 100 {
			t.Errorf("%s: crossover computed at %.0f Mbps, expected well above typical broadband",
				c.name, d.Trade.CrossoverMbps)
		}
		if d.Caveat == "" {
			t.Errorf("%s: a trade must explain itself", c.name)
		}
	}
}

func TestCrossoverBandwidthArithmetic(t *testing.T) {
	// 156,365 bytes saved for 1.37 ms added is 913 Mbps, worked by hand:
	// 156365 / 0.00137 = 114,135,036 B/s; x8 / 1e6 = 913 Mbps.
	tr := tradeOff(1.37, 168496-12131)
	if !tr.IsTrade {
		t.Fatal("slower but smaller should be a trade")
	}
	if math.Abs(tr.CrossoverMbps-913) > 5 {
		t.Fatalf("crossover %.1f Mbps, expected about 913", tr.CrossoverMbps)
	}
}

func TestATradeIsNeverTheHeadlineRegression(t *testing.T) {
	// The one number that gets quoted must not be a payload win.
	trade := runWith(result("tour-viphya", 0.36, scatter(0.36, 0.03, 20), 455813))
	tradeNow := runWith(result("tour-viphya", 3.36, scatter(3.36, 0.3, 20), 32471))

	h := Compare(trade, tradeNow).Summarise()
	if h.BiggestRegression != nil && h.BiggestRegression.Name == "tour-viphya" {
		t.Fatal("a 423 KB saving was named the biggest regression in the comparison")
	}
	if h.Traded != 1 {
		t.Fatalf("expected the change to be counted as a trade, got %d", h.Traded)
	}
}

func TestBothMovingTheSameWayIsNotATrade(t *testing.T) {
	// Smaller AND faster is simply better; there is nothing to trade off.
	if tradeOff(-2, 5000).IsTrade {
		t.Fatal("faster and smaller was reported as a trade")
	}
	// Slower AND larger is simply worse.
	if tradeOff(2, -5000).IsTrade {
		t.Fatal("slower and larger was reported as a trade")
	}
}

func TestTimeToReceiveModelsTransfer(t *testing.T) {
	// 1 MB at 8 Mbps is about 1049 ms of transfer on top of the server time.
	got := TimeToReceiveMs(10, 1024*1024, Bandwidth{Name: "x", Mbps: 8})
	if math.Abs(got-(10+1048.576)) > 1 {
		t.Fatalf("got %.1f ms", got)
	}
	// Loopback adds nothing: what was measured is what is reported.
	if got := TimeToReceiveMs(10, 1024*1024, Bandwidth{Name: "loopback", Mbps: 0}); got != 10 {
		t.Fatalf("loopback added modelled transfer: %v", got)
	}
}

func TestReferenceBandwidthsAreReportedTogether(t *testing.T) {
	// Three, always all three, so no single one can be chosen after the fact to
	// make a change look good.
	if len(ReferenceBandwidths) < 3 {
		t.Fatal("fewer than three reference bandwidths invites cherry-picking")
	}
	var hasLoopback bool
	for _, b := range ReferenceBandwidths {
		if b.Mbps == 0 {
			hasLoopback = true
		}
	}
	if !hasLoopback {
		t.Fatal("the measured, unmodelled case must remain among the reference points")
	}
}
