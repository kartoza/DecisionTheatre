package bench

import (
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

// What landed between two runs.
//
// A comparison says a number moved. It cannot say why, and the reader who most
// needs the report — someone deciding whether a week of work was worth it — is
// asking exactly that. So the report ends with the pull requests merged between
// the two builds, and the issues they claim to close.
//
// This reads git and nothing else. No network, no API token, no `gh`: a report
// generated on a laptop with no credentials must produce the same list as one
// generated in CI, and a benchmark tool that needs GitHub to be reachable in
// order to render is a benchmark tool that stops working at the worst moment.
//
// The attribution is a claim about what merged, not proof that a given pull
// request caused a given number. Two commits in the same range can move the same
// scenario in opposite directions. The list narrows the search; it does not end
// it, and the report says so rather than implying causation.

// A MergedPR is one pull request merged in the range.
type MergedPR struct {
	// Number is the pull request number from the merge commit's subject.
	Number int

	// Title is the merged work's own subject line, which is more informative
	// than "Merge pull request #130 from kartoza/perf/webgl-context-budget".
	Title string

	// Branch is the source branch, which often says what the work was when the
	// title does not.
	Branch string

	// Commit is the merge commit, so a reader can go straight to it.
	Commit string

	// Date is the merge date, ISO 8601.
	Date string

	// Issues are the issue numbers this pull request's own commits reference.
	Issues []int
}

// Changes is everything that landed between two builds.
type Changes struct {
	// From and To are the revisions the range was computed over. They are the
	// builds that answered, not the tool's own checkout.
	From, To string

	PRs []MergedPR

	// Issues is the union across every pull request, sorted.
	Issues []int

	// Commits counts non-merge commits in the range, which is a better measure
	// of how much changed than the pull request count.
	Commits int

	// Unavailable explains why the list is empty, when it is. A report that
	// silently omits this section would read as "nothing merged".
	Unavailable string
}

// Any reports whether there is anything to show.
func (c Changes) Any() bool { return len(c.PRs) > 0 || c.Commits > 0 }

// mergeSubject matches the merge commits GitHub writes. It deliberately does not
// match "Merge remote-tracking branch ..." or "Merge branch ...", which are
// integration merges within a branch and not pull requests — counting those
// would inflate the list with the same work twice.
var mergeSubject = regexp.MustCompile(`^Merge pull request #(\d+) from (\S+)`)

// issueRef matches the closing keywords GitHub honours, plus "Refs", which this
// repository uses for work that relates to an issue without closing it.
var issueRef = regexp.MustCompile(`(?i)\b(?:fixes|closes|resolves|refs)\s+#(\d+)\b`)

// describeCommit pulls the commit out of a `git describe` version string such as
// "0.4.0-211-g7fb8f6b". A server reports its own version over /api/info, so this
// is how a run against a server the tool did not build still knows which
// revision answered.
var describeCommit = regexp.MustCompile(`-g([0-9a-f]{7,40})$`)

// CommitOf is the revision a run measured, or "" when it cannot be established.
//
// A sweep records the commit it built. A run against a server it did not build
// has to take the server's word for it, which is why /api/info reporting a real
// version matters: a server built without one reports "dev", and then no range
// can be computed and the report says so instead of guessing.
func CommitOf(r Run) string {
	if r.Commit != "" {
		return r.Commit
	}
	if m := describeCommit.FindStringSubmatch(r.ServerVersion); m != nil {
		return m[1]
	}
	return ""
}

// ChangesBetween lists the pull requests merged between two revisions.
//
// repo is a path to a git checkout. from and to are anything git resolves. The
// range is exclusive of from and inclusive of to, matching `git log from..to`.
func ChangesBetween(ctx context.Context, repo, from, to string) Changes {
	c := Changes{From: from, To: to}

	if from == "" || to == "" {
		c.Unavailable = "Neither build recorded which revision it was, so there is no range to look up. " +
			"A server reports its version over /api/info; one built without a version stamped in reports " +
			`"dev", and cannot be attributed to a commit.`
		return c
	}

	// Both ends must exist in this checkout. A shallow clone, or a report
	// generated somewhere the branch was never fetched, would otherwise produce
	// an empty list that reads as "nothing changed".
	for _, rev := range []string{from, to} {
		if _, err := git(ctx, repo, "rev-parse", "--verify", "--quiet", rev+"^{commit}"); err != nil {
			c.Unavailable = fmt.Sprintf(
				"Revision %s is not in this checkout, so the range could not be listed. "+
					"Fetch it, or run the report from a checkout that has both.", rev)
			return c
		}
	}

	rng := from + ".." + to

	if out, err := git(ctx, repo, "rev-list", "--count", "--no-merges", rng); err == nil {
		c.Commits, _ = strconv.Atoi(strings.TrimSpace(out))
	}

	// %x1f separates fields and %x1e separates records, because a commit body
	// contains newlines and blank lines and any line-based split would tear a
	// multi-paragraph message into fragments.
	out, err := git(ctx, repo, "log", "--merges", "--date=short",
		"--format=%H%x1f%s%x1f%ad%x1f%b%x1e", rng)
	if err != nil {
		c.Unavailable = "The revision range could not be read from git: " + err.Error()
		return c
	}

	seen := map[int]bool{}
	for _, record := range strings.Split(out, "\x1e") {
		record = strings.TrimLeft(record, "\n")
		if strings.TrimSpace(record) == "" {
			continue
		}
		fields := strings.SplitN(record, "\x1f", 4)
		if len(fields) < 4 {
			continue
		}
		commit, subject, date, body := fields[0], fields[1], fields[2], fields[3]

		m := mergeSubject.FindStringSubmatch(subject)
		if m == nil {
			continue
		}
		number, err := strconv.Atoi(m[1])
		if err != nil || seen[number] {
			continue
		}
		seen[number] = true

		pr := MergedPR{
			Number: number,
			Branch: strings.TrimPrefix(m[2], "kartoza/"),
			Title:  firstLine(body),
			Commit: commit,
			Date:   date,
		}
		if pr.Title == "" {
			pr.Title = pr.Branch
		}
		pr.Issues = issuesIn(ctx, repo, commit)
		c.PRs = append(c.PRs, pr)
	}

	// Newest first: a reader scanning for what changed recently should not have
	// to read to the bottom.
	sort.SliceStable(c.PRs, func(i, j int) bool { return c.PRs[i].Date > c.PRs[j].Date })

	union := map[int]bool{}
	for _, pr := range c.PRs {
		for _, n := range pr.Issues {
			union[n] = true
		}
	}
	for n := range union {
		c.Issues = append(c.Issues, n)
	}
	sort.Ints(c.Issues)

	if len(c.PRs) == 0 && c.Commits > 0 {
		c.Unavailable = fmt.Sprintf(
			"%d commit(s) landed in this range, but none arrived through a merged pull request, "+
				"so there is nothing to attribute them to.", c.Commits)
	}
	return c
}

// issuesIn returns the issue numbers referenced by the commits a merge brought
// in — that is, the second parent's commits up to the merge base, which is the
// pull request's own work and not everything that happened to be on main.
func issuesIn(ctx context.Context, repo, merge string) []int {
	out, err := git(ctx, repo, "log", "--format=%B", merge+"^1.."+merge+"^2")
	if err != nil {
		// A merge with one parent, or a rewritten history. The pull request is
		// still worth listing; only its issue links are lost.
		return nil
	}
	seen := map[int]bool{}
	var numbers []int
	for _, m := range issueRef.FindAllStringSubmatch(out, -1) {
		n, err := strconv.Atoi(m[1])
		if err != nil || seen[n] {
			continue
		}
		seen[n] = true
		numbers = append(numbers, n)
	}
	sort.Ints(numbers)
	return numbers
}

func firstLine(s string) string {
	for _, line := range strings.Split(s, "\n") {
		if t := strings.TrimSpace(line); t != "" {
			return t
		}
	}
	return ""
}

func git(ctx context.Context, repo string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", repo}, args...)...)
	out, err := cmd.Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}
