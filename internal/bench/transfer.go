package bench

import "fmt"

// Modelling what a payload costs to receive, because measuring over loopback
// does not.
//
// The problem, from a real comparison of the 14 August baseline against today:
//
//	                 14 Aug bytes   today bytes   14 Aug p50   today p50
//	tour-shai-hills       168,496        12,131      0.17 ms     1.54 ms
//	tour-viphya           455,813        32,471      0.36 ms     3.36 ms
//	tour-munywana         374,228        33,129      0.35 ms     3.02 ms
//
// The suite headlined that as "biggest regression: tour-viphya (+830%)". It is
// arithmetically true and substantively backwards. Those documents are now
// compressed, and on loopback compression is pure cost: the transfer it saves
// takes no measurable time, so all that remains is the CPU spent doing it. Three
// milliseconds bought 423 KB.
//
// This is a systematic bias, not a one-off. Every payload-reducing change —
// compression, vector tiles instead of GeoJSON, a columnar endpoint, dropping a
// duplicated array — looks like a regression when measured against a server on
// the same machine, because the benefit lands entirely in a transfer this
// harness does not have to make. A tool that reports it that way will
// consistently argue against the work most worth doing.
//
// The obvious fix is to model transfer at some declared bandwidth and judge on
// the total. The obvious fix is also a new way to flatter: pick a slow enough
// link and any payload reduction becomes a triumph, and the number rests
// entirely on an assumption the reader cannot check.
//
// So the headline figure here is not a modelled time at a chosen bandwidth. It
// is the **crossover bandwidth**: the link speed at which the trade breaks even.
// That needs no assumption at all — it is bytes saved divided by time added, a
// fact about the two measurements — and it converts the question into one a
// reader can answer for themselves. "Faster to send on any link below 913 Mbps"
// is checkable. "Saves 700 ms at 5 Mbps" is an assertion about somebody's
// broadband.
//
// Modelled times at declared bandwidths are still offered, for illustration,
// and every one of them carries the bandwidth it assumed.

// ReferenceBandwidths are the links a modelled figure may be quoted at.
//
// Three, always reported together, so that no single one can be selected after
// the fact to make a change look good. They bracket the range this application
// is actually used over rather than describing any one user.
var ReferenceBandwidths = []Bandwidth{
	{Name: "3G / rural mobile", Mbps: 5},
	{Name: "typical broadband", Mbps: 25},
	{Name: "loopback", Mbps: 0}, // 0 means "no transfer cost", i.e. what was measured
}

// A Bandwidth is a declared link speed used to model transfer time.
type Bandwidth struct {
	Name string
	Mbps float64
}

// transferMs is how long Bytes take to cross a link of this speed.
// A zero or negative Mbps means loopback: no modelled transfer cost at all.
func (b Bandwidth) transferMs(bytes int64) float64 {
	if b.Mbps <= 0 || bytes <= 0 {
		return 0
	}
	return float64(bytes) * 8 / (b.Mbps * 1e6) * 1000
}

// TimeToReceiveMs is the measured server time plus the modelled transfer of the
// payload at this bandwidth.
//
// "Measured plus modelled" is the honest description: the first term was timed
// and the second was calculated, and they should never be presented as though
// both were observed.
func TimeToReceiveMs(serverMs float64, bytes int64, b Bandwidth) float64 {
	return serverMs + b.transferMs(bytes)
}

// A Trade is a change that costs time to produce and saves time to send, or the
// reverse. It is the shape of nearly every payload optimisation.
type Trade struct {
	// IsTrade is false when both time and size moved the same way, in which
	// case there is nothing to trade off and the ordinary verdict stands.
	IsTrade bool

	// MsAdded is the extra server time, positive when the current run is
	// slower. BytesSaved is positive when the current run is smaller.
	MsAdded    float64
	BytesSaved int64

	// CrossoverMbps is the link speed at which the two cancel: below it the
	// change is a net win for the user, above it a net loss. Zero when it
	// cannot be computed.
	//
	// This is the number to quote. It contains no assumption about anybody's
	// connection — it is derived entirely from the two measurements — and it
	// hands the reader the comparison rather than making it for them.
	CrossoverMbps float64
}

// tradeOff works out whether a delta is a size-for-time trade, and where it
// breaks even.
func tradeOff(msAdded float64, bytesSaved int64) Trade {
	t := Trade{MsAdded: msAdded, BytesSaved: bytesSaved}

	// A trade needs the two to point in opposite directions: slower but
	// smaller, or faster but larger.
	slowerAndSmaller := msAdded > 0 && bytesSaved > 0
	fasterAndLarger := msAdded < 0 && bytesSaved < 0
	if !slowerAndSmaller && !fasterAndLarger {
		return t
	}
	if msAdded == 0 {
		return t
	}

	t.IsTrade = true

	// bytes per second at break-even, converted to megabits.
	seconds := msAdded / 1000
	if seconds < 0 {
		seconds = -seconds
	}
	saved := bytesSaved
	if saved < 0 {
		saved = -saved
	}
	t.CrossoverMbps = float64(saved) / seconds * 8 / 1e6
	return t
}

// Describe states the trade in the terms a reader can check.
func (t Trade) Describe() string {
	if !t.IsTrade {
		return ""
	}
	if t.MsAdded > 0 {
		return fmt.Sprintf(
			"This is a size-for-time trade, not a regression: it costs %.2f ms more on the server and sends "+
				"%s less. The two break even at %s — on any connection slower than that the user waits less "+
				"than before, and this suite measures over loopback, where the saving cannot appear at all.",
			t.MsAdded, humanSize(t.BytesSaved), humanMbps(t.CrossoverMbps))
	}
	return fmt.Sprintf(
		"This is a time-for-size trade: it saves %.2f ms on the server and sends %s more. The two break even "+
			"at %s — on any connection slower than that the user waits longer than before, which is most of them.",
		-t.MsAdded, humanSize(-t.BytesSaved), humanMbps(t.CrossoverMbps))
}

func humanMbps(v float64) string {
	switch {
	case v <= 0:
		return "an unknown speed"
	case v >= 1000:
		return fmt.Sprintf("%.1f Gbps", v/1000)
	case v >= 1:
		return fmt.Sprintf("%.0f Mbps", v)
	default:
		return fmt.Sprintf("%.2f Mbps", v)
	}
}

func humanSize(b int64) string {
	switch {
	case b < 0:
		return humanSize(-b)
	case b < 1024:
		return fmt.Sprintf("%d B", b)
	case b < 1024*1024:
		return fmt.Sprintf("%.1f KB", float64(b)/1024)
	default:
		return fmt.Sprintf("%.2f MB", float64(b)/(1024*1024))
	}
}
