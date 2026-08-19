package bench

import (
	"context"
	"os/exec"
	"strings"
	"testing"
)

// repoWith builds a throwaway git repository with a known history, so the tests
// assert against real `git log` output rather than a mock of it. The parsing is
// the whole point of the file; mocking git would test the mock.
func repoWith(t *testing.T) (dir, base string) {
	t.Helper()
	dir = t.TempDir()

	run := func(args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
		cmd.Env = append(cmd.Environ(),
			"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.org",
			"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.org",
			"GIT_AUTHOR_DATE=2026-08-01T00:00:00Z", "GIT_COMMITTER_DATE=2026-08-01T00:00:00Z")
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
		}
		return strings.TrimSpace(string(out))
	}

	run("init", "-q", "-b", "main")
	run("commit", "-q", "--allow-empty", "-m", "base")
	base = run("rev-parse", "HEAD")

	// A pull request whose commits reference two issues.
	run("checkout", "-q", "-b", "feat/one")
	run("commit", "-q", "--allow-empty", "-m", "feat: the first thing\n\nFixes #11\nRefs #12")
	run("checkout", "-q", "main")
	run("merge", "-q", "--no-ff", "-m",
		"Merge pull request #101 from kartoza/feat/one\n\nfeat: the first thing", "feat/one")

	// An integration merge, which is not a pull request and must not be counted.
	run("checkout", "-q", "-b", "feat/two")
	run("commit", "-q", "--allow-empty", "-m", "fix: the second thing\n\nCloses #13")
	run("checkout", "-q", "main")
	run("commit", "-q", "--allow-empty", "-m", "unrelated work on main")
	run("checkout", "-q", "feat/two")
	run("merge", "-q", "--no-ff", "-m", "Merge remote-tracking branch 'main' into feat/two", "main")
	run("checkout", "-q", "main")
	run("merge", "-q", "--no-ff", "-m",
		"Merge pull request #102 from kartoza/feat/two\n\nfix: the second thing", "feat/two")

	return dir, base
}

func changesOf(t *testing.T, dir, from, to string) Changes {
	t.Helper()
	return ChangesBetween(context.Background(), dir, from, to)
}

func TestChangesListsMergedPullRequests(t *testing.T) {
	dir, base := repoWith(t)
	c := changesOf(t, dir, base, "main")

	if len(c.PRs) != 2 {
		t.Fatalf("found %d pull requests, want 2: %+v", len(c.PRs), c.PRs)
	}
	numbers := map[int]bool{}
	for _, pr := range c.PRs {
		numbers[pr.Number] = true
	}
	if !numbers[101] || !numbers[102] {
		t.Errorf("pull request numbers = %v, want 101 and 102", numbers)
	}
}

// The merged work's own subject is what tells a reader what changed. "Merge pull
// request #101 from kartoza/feat/one" does not.
func TestChangesPrefersTheWorksOwnTitle(t *testing.T) {
	dir, base := repoWith(t)
	c := changesOf(t, dir, base, "main")

	for _, pr := range c.PRs {
		if strings.HasPrefix(pr.Title, "Merge pull request") {
			t.Errorf("PR #%d title is the merge subject, not the work: %q", pr.Number, pr.Title)
		}
		if pr.Title == "" {
			t.Errorf("PR #%d has no title", pr.Number)
		}
	}
}

// An integration merge brings the same work in twice. Counting it would inflate
// the list and attribute a change to a merge that did not introduce it.
func TestChangesIgnoresIntegrationMerges(t *testing.T) {
	dir, base := repoWith(t)
	c := changesOf(t, dir, base, "main")

	for _, pr := range c.PRs {
		if strings.Contains(pr.Title, "remote-tracking") || strings.Contains(pr.Branch, "main") {
			t.Errorf("an integration merge was counted as a pull request: %+v", pr)
		}
	}
	if len(c.PRs) != 2 {
		t.Errorf("counted %d pull requests, want 2 — an integration merge was included", len(c.PRs))
	}
}

func TestChangesCollectsIssueReferences(t *testing.T) {
	dir, base := repoWith(t)
	c := changesOf(t, dir, base, "main")

	want := map[int]bool{11: true, 12: true, 13: true}
	got := map[int]bool{}
	for _, n := range c.Issues {
		got[n] = true
	}
	for n := range want {
		if !got[n] {
			t.Errorf("issue #%d was referenced in the range but is not in %v", n, c.Issues)
		}
	}
}

// Issues must attach to the pull request whose own commits referenced them, not
// to whichever merge happened to be nearby.
func TestChangesAttributesIssuesToTheRightPullRequest(t *testing.T) {
	dir, base := repoWith(t)
	c := changesOf(t, dir, base, "main")

	for _, pr := range c.PRs {
		got := map[int]bool{}
		for _, n := range pr.Issues {
			got[n] = true
		}
		switch pr.Number {
		case 101:
			if !got[11] || !got[12] || got[13] {
				t.Errorf("PR #101 issues = %v, want 11 and 12 only", pr.Issues)
			}
		case 102:
			if !got[13] || got[11] {
				t.Errorf("PR #102 issues = %v, want 13 only", pr.Issues)
			}
		}
	}
}

// An empty list must be distinguishable from "we could not look".
func TestChangesSaysWhyItCannotAttribute(t *testing.T) {
	dir, _ := repoWith(t)

	for _, tc := range []struct {
		name, from, to, wantMention string
	}{
		{"no revisions recorded", "", "", "/api/info"},
		{"revision missing from checkout", "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef", "main", "not in this checkout"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := changesOf(t, dir, tc.from, tc.to)
			if c.Unavailable == "" {
				t.Fatal("no explanation given for an empty change list")
			}
			if !strings.Contains(c.Unavailable, tc.wantMention) {
				t.Errorf("explanation = %q, want it to mention %q", c.Unavailable, tc.wantMention)
			}
			if len(c.PRs) != 0 {
				t.Errorf("reported %d pull requests despite being unable to look", len(c.PRs))
			}
		})
	}
}

// A range with nothing in it is a fact, not a failure.
func TestChangesOnAnEmptyRange(t *testing.T) {
	dir, _ := repoWith(t)
	c := changesOf(t, dir, "main", "main")

	if len(c.PRs) != 0 || c.Commits != 0 {
		t.Errorf("main..main reported %d PRs and %d commits, want none", len(c.PRs), c.Commits)
	}
	if c.Any() {
		t.Error("Any() is true for an empty range")
	}
}

func TestChangesCountsCommitsNotMerges(t *testing.T) {
	dir, base := repoWith(t)
	c := changesOf(t, dir, base, "main")

	// Three non-merge commits: the two features and the unrelated one on main.
	if c.Commits != 3 {
		t.Errorf("Commits = %d, want 3 non-merge commits", c.Commits)
	}
}

// A run against a server the tool did not build still knows its revision, because
// the server reports a `git describe` version over /api/info.
func TestCommitOfReadsTheRevisionFromEitherSource(t *testing.T) {
	for _, tc := range []struct {
		name string
		run  Run
		want string
	}{
		{"a sweep records the commit it built",
			Run{Commit: "7fb8f6b1234567", ServerVersion: "0.4.0"}, "7fb8f6b1234567"},
		{"otherwise it comes from the reported version",
			Run{ServerVersion: "0.4.0-211-g7fb8f6b"}, "7fb8f6b"},
		{"a build with no version stamped in cannot be attributed",
			Run{ServerVersion: "dev"}, ""},
		{"nor can one that reported nothing",
			Run{}, ""},
		{"a plain release version carries no commit",
			Run{ServerVersion: "0.4.0"}, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := CommitOf(tc.run); got != tc.want {
				t.Errorf("CommitOf() = %q, want %q", got, tc.want)
			}
		})
	}
}
