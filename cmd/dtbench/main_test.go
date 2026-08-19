package main

import (
	"strings"
	"testing"
)

// checkTarget exists because of one specific silent failure: a target string
// that parses but points nowhere produced a full suite of failures, a saved
// results file and exit status 0.
func TestCheckTargetRejectsWhatCannotBeMeasured(t *testing.T) {
	cases := []struct {
		name, given, wantSuggestion string
	}{
		{"missing colon in the scheme", "http//127.0.0.1:8080", "http://127.0.0.1:8080"},
		{"no scheme at all", "127.0.0.1:8080", "http://127.0.0.1:8080"},
		{"bare hostname", "localhost", "http://localhost"},
		{"empty", "   ", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := checkTarget(tc.given)
			if err == nil {
				t.Fatalf("checkTarget(%q) accepted it as %q", tc.given, got)
			}
			if !isUsageError(err) {
				t.Errorf("a mistyped target is a usage error, so it exits 2; got %T", err)
			}
			if tc.wantSuggestion != "" && !strings.Contains(err.Error(), tc.wantSuggestion) {
				t.Errorf("the message must suggest %q; got: %v", tc.wantSuggestion, err)
			}
		})
	}
}

func TestCheckTargetAcceptsAndNormalises(t *testing.T) {
	got, err := checkTarget("http://127.0.0.1:8080/")
	if err != nil {
		t.Fatalf("checkTarget: %v", err)
	}
	if got != "http://127.0.0.1:8080" {
		t.Errorf("checkTarget = %q, want the trailing slash removed", got)
	}
	if _, err := checkTarget("ftp://example.org"); err == nil {
		t.Error("a non-HTTP scheme should be refused; this tool measures HTTP")
	}
}

// Copying two long filenames out of `list` to answer "is it faster than last
// time" is a chore the tool can do itself.
func TestPositionSpec(t *testing.T) {
	const stored = 5
	cases := []struct {
		spec string
		want int
		ok   bool
	}{
		{"last", 4, true},
		{"latest", 4, true},
		{"first", 0, true},
		{"previous", 3, true},
		{"last-1", 3, true},
		{"last-4", 0, true},
		{"before", 0, false},     // A label, not a position.
		{"20260819-x", 0, false}, // A filename.
	}
	for _, tc := range cases {
		got, ok := positionSpec(tc.spec, stored)
		if ok != tc.ok {
			t.Errorf("positionSpec(%q) recognised = %v, want %v", tc.spec, ok, tc.ok)
			continue
		}
		if ok && got != tc.want {
			t.Errorf("positionSpec(%q) = %d, want %d", tc.spec, got, tc.want)
		}
	}
}

// Being told an option does not exist, without being told what does, leaves
// somebody guessing at a vocabulary they cannot see.
func TestNearestFlagPointsAtTheRealOption(t *testing.T) {
	cases := map[string]string{
		"flag provided but not defined: -iterations": "-n",
		"flag provided but not defined: -url":        "--target",
		"flag provided but not defined: -output":     "--out",
		"flag provided but not defined: -zzz":        "",
		"some other error":                           "",
	}
	for message, want := range cases {
		if got := nearestFlag(errString(message)); got != want {
			t.Errorf("nearestFlag(%q) = %q, want %q", message, got, want)
		}
	}
}

func TestNearestCommandCatchesTheObviousGuesses(t *testing.T) {
	cases := map[string]string{
		"compare": "report",
		"ls":      "list",
		"ru":      "run",
		"repor":   "report",
		"xyzzy":   "",
	}
	for given, want := range cases {
		if got := nearestCommand(given); got != want {
			t.Errorf("nearestCommand(%q) = %q, want %q", given, got, want)
		}
	}
}

func TestPluralDoesNotSayOneRevisionS(t *testing.T) {
	if got := plural(1, "revision", "revisions"); got != "1 revision" {
		t.Errorf("plural(1) = %q", got)
	}
	if got := plural(3, "revision", "revisions"); got != "3 revisions" {
		t.Errorf("plural(3) = %q", got)
	}
}

type errString string

func (e errString) Error() string { return string(e) }
