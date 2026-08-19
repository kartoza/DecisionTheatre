package bench

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// SweepOptions configure benchmarking a range of revisions.
//
// The shape of the problem: to know whether last week's work helped, each
// revision has to be built and run, because there is no other way to ask an old
// version how fast it was. That is minutes per revision, so the tool is
// deliberately explicit about what it will do before it does it.
type SweepOptions struct {
	// Repo is the git checkout to take revisions from. It is never modified: each
	// revision is built in its own detached worktree, which is removed afterwards.
	Repo string

	// From and To bound the range, inclusive of To. From is exclusive in git's
	// rev-list sense, so "the commit before the work started" is the natural
	// value.
	From string
	To   string

	// Max caps how many revisions are built, most recent first when the range is
	// larger. Building fifty revisions is hours; the tool should not discover
	// that halfway through.
	Max int

	// Every is a stride: 1 builds every revision, 5 builds every fifth. Useful
	// for finding roughly where a change happened before bisecting properly.
	Every int

	// MergesOnly restricts the sweep to merge commits, which for this repository
	// means one point per pull request rather than one per commit. Usually what
	// somebody means by "compare the versions".
	MergesOnly bool

	// DataDir and ResourcesDir are passed to each built server. They are shared
	// and read-only from the server's point of view — the datapack is opened
	// immutable — so one copy serves every revision.
	DataDir      string
	ResourcesDir string

	// Port is where each built server listens, in turn. One at a time, so a
	// benchmark is never competing with another server for the same disk cache.
	Port int

	// BuildTimeout bounds a single revision's build.
	BuildTimeout time.Duration

	// KeepBinaries leaves the built binaries in place for inspection.
	KeepBinaries bool

	// Bench is the measurement configuration applied to every revision.
	Bench Options

	// Log receives progress. A sweep is long enough that silence reads as a hang.
	Log func(format string, args ...any)
}

func (o *SweepOptions) applyDefaults() {
	if o.To == "" {
		o.To = "HEAD"
	}
	if o.Every <= 0 {
		o.Every = 1
	}
	if o.Max <= 0 {
		o.Max = 20
	}
	if o.Port <= 0 {
		o.Port = 8099
	}
	if o.BuildTimeout <= 0 {
		o.BuildTimeout = 15 * time.Minute
	}
	if o.Log == nil {
		o.Log = func(string, ...any) {}
	}
}

// Revision is one point in a sweep.
type Revision struct {
	Commit string
	Date   string
	Title  string
}

// Revisions lists what a sweep would measure, without measuring it.
//
// Separated from Sweep so a caller can show the plan and let a human stop before
// committing to an hour of builds.
func Revisions(opts SweepOptions) ([]Revision, error) {
	opts.applyDefaults()

	args := []string{"-C", opts.Repo, "rev-list", "--reverse"}
	if opts.MergesOnly {
		args = append(args, "--merges")
	}
	rng := opts.To
	if opts.From != "" {
		rng = opts.From + ".." + opts.To
	}
	args = append(args, rng)

	out, err := exec.Command("git", args...).Output()
	if err != nil {
		return nil, fmt.Errorf("list revisions %s: %w", rng, err)
	}

	var all []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if line != "" {
			all = append(all, line)
		}
	}
	if len(all) == 0 {
		return nil, fmt.Errorf("no revisions in %s", rng)
	}

	// Stride first, then cap. Capping first then striding would silently measure
	// a different range from the one asked for.
	var strided []string
	for i := 0; i < len(all); i += opts.Every {
		strided = append(strided, all[i])
	}
	// The tip is the point of the exercise; never drop it to a stride.
	if strided[len(strided)-1] != all[len(all)-1] {
		strided = append(strided, all[len(all)-1])
	}
	if len(strided) > opts.Max {
		strided = strided[len(strided)-opts.Max:]
	}

	revs := make([]Revision, 0, len(strided))
	for _, sha := range strided {
		revs = append(revs, describe(opts.Repo, sha))
	}
	return revs, nil
}

func describe(repo, sha string) Revision {
	r := Revision{Commit: sha}
	out, err := exec.Command("git", "-C", repo, "show", "-s",
		"--format=%cs%x00%s", sha).Output()
	if err == nil {
		parts := strings.SplitN(strings.TrimSpace(string(out)), "\x00", 2)
		if len(parts) == 2 {
			r.Date, r.Title = parts[0], parts[1]
		}
	}
	return r
}

// Sweep builds and measures each revision in turn, saving results to resultsDir.
//
// It returns the runs it completed. A revision that fails to build is reported
// and skipped rather than aborting: in a range of twenty, one that does not
// compile should cost that one point, not the whole afternoon.
func Sweep(ctx context.Context, opts SweepOptions, resultsDir string) ([]Run, []error) {
	opts.applyDefaults()

	revs, err := Revisions(opts)
	if err != nil {
		return nil, []error{err}
	}

	var runs []Run
	var problems []error

	for i, rev := range revs {
		if ctx.Err() != nil {
			problems = append(problems, fmt.Errorf("stopped after %d of %d revisions", i, len(revs)))
			break
		}
		opts.Log("[%d/%d] %s %s — %s", i+1, len(revs), shortCommit(rev.Commit), rev.Date, rev.Title)

		run, err := measureRevision(ctx, opts, rev)
		if err != nil {
			problems = append(problems, fmt.Errorf("%s: %w", shortCommit(rev.Commit), err))
			opts.Log("      skipped: %v", err)
			continue
		}

		path, err := run.Save(resultsDir)
		if err != nil {
			problems = append(problems, err)
		} else {
			opts.Log("      saved %s", filepath.Base(path))
		}
		runs = append(runs, run)
	}

	return runs, problems
}

// measureRevision builds one revision in a throwaway worktree, runs it, measures
// it, and cleans up.
func measureRevision(ctx context.Context, opts SweepOptions, rev Revision) (Run, error) {
	var zero Run

	work, err := os.MkdirTemp("", "dtbench-rev-")
	if err != nil {
		return zero, fmt.Errorf("create build directory: %w", err)
	}
	tree := filepath.Join(work, "src")
	defer func() {
		// The worktree is registered with the parent repository, so removing the
		// directory alone would leave a dangling entry behind in someone else's
		// checkout. Always go through git.
		_ = exec.Command("git", "-C", opts.Repo, "worktree", "remove", "--force", tree).Run()
		_ = os.RemoveAll(work)
	}()

	if out, err := exec.Command("git", "-C", opts.Repo,
		"worktree", "add", "--detach", tree, rev.Commit).CombinedOutput(); err != nil {
		return zero, fmt.Errorf("check out: %w: %s", err, strings.TrimSpace(string(out)))
	}

	// The server embeds the built frontend and documentation. Building those for
	// every revision would multiply the sweep's cost several times over, and this
	// tool measures the HTTP API rather than the bundle. Placeholders satisfy the
	// embed directives so the binary links.
	for _, dir := range []string{"internal/server/static", "internal/server/docs_site"} {
		full := filepath.Join(tree, dir)
		if err := os.MkdirAll(full, 0o755); err != nil {
			return zero, fmt.Errorf("prepare embed directory: %w", err)
		}
		if err := os.WriteFile(filepath.Join(full, "index.html"),
			[]byte("<!doctype html><title>benchmark placeholder</title>\n"), 0o644); err != nil {
			return zero, fmt.Errorf("write embed placeholder: %w", err)
		}
	}

	binary := filepath.Join(work, "server")
	buildCtx, cancel := context.WithTimeout(ctx, opts.BuildTimeout)
	defer cancel()

	build := exec.CommandContext(buildCtx, "go", "build", "-o", binary, ".")
	build.Dir = tree
	build.Env = append(os.Environ(), webkitCompatEnv(tree)...)
	if out, err := build.CombinedOutput(); err != nil {
		return zero, fmt.Errorf("build: %w: %s", err, lastLines(string(out), 3))
	}

	if opts.KeepBinaries {
		_ = os.Rename(binary, filepath.Join(os.TempDir(),
			fmt.Sprintf("dtbench-%s", shortCommit(rev.Commit))))
	}

	server, err := startServer(ctx, binary, opts)
	if err != nil {
		return zero, err
	}
	defer server.stop()

	benchOpts := opts.Bench
	benchOpts.Target = fmt.Sprintf("http://127.0.0.1:%d", opts.Port)
	benchOpts.Commit = rev.Commit
	benchOpts.CommitDate = rev.Date
	benchOpts.CommitTitle = rev.Title
	if benchOpts.Label == "" {
		benchOpts.Label = shortCommit(rev.Commit)
	}

	return Execute(ctx, benchOpts)
}

// webkitCompatEnv reproduces what scripts/webkit-compat.sh sets.
//
// webview_go asks pkg-config for webkit2gtk-4.0 with no build tag for 4.1, and
// only 4.1 is packaged now, so a plain `go build` fails to import it. Calling the
// repository's own script keeps one answer to that problem rather than a second
// copy here that can drift.
func webkitCompatEnv(tree string) []string {
	script := filepath.Join(tree, "scripts", "webkit-compat.sh")
	if _, err := os.Stat(script); err != nil {
		return nil
	}
	out, err := exec.Command("bash", "-c", "eval \"$("+script+")\" && env").Output()
	if err != nil {
		return nil
	}

	var env []string
	for _, line := range strings.Split(string(out), "\n") {
		if strings.HasPrefix(line, "PKG_CONFIG_PATH=") ||
			strings.HasPrefix(line, "LD_LIBRARY_PATH=") ||
			strings.HasPrefix(line, "LIBRARY_PATH=") {
			env = append(env, line)
		}
	}
	return env
}

type runningServer struct {
	cmd *exec.Cmd
	log *os.File
}

func (s *runningServer) stop() {
	if s == nil {
		return
	}
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
		_, _ = s.cmd.Process.Wait()
	}
	if s.log != nil {
		name := s.log.Name()
		_ = s.log.Close()
		_ = os.Remove(name)
	}
}

// startServer launches a built binary and waits for it to answer.
func startServer(ctx context.Context, binary string, opts SweepOptions) (*runningServer, error) {
	if busy(opts.Port) {
		return nil, fmt.Errorf("port %d is already in use; benchmarking against someone else's server "+
			"would measure the wrong thing", opts.Port)
	}

	log, err := os.CreateTemp("", "dtbench-server-*.log")
	if err != nil {
		return nil, fmt.Errorf("create server log: %w", err)
	}

	args := []string{
		"--headless",
		"--port", fmt.Sprint(opts.Port),
		"--data-dir", opts.DataDir,
	}
	if opts.ResourcesDir != "" {
		args = append(args, "--resources-dir", opts.ResourcesDir)
	}

	cmd := exec.Command(binary, args...)
	cmd.Stdout = log
	cmd.Stderr = log
	if err := cmd.Start(); err != nil {
		_ = log.Close()
		return nil, fmt.Errorf("start server: %w", err)
	}
	server := &runningServer{cmd: cmd, log: log}

	base := fmt.Sprintf("http://127.0.0.1:%d", opts.Port)
	if err := waitForHealth(ctx, base, 120*time.Second); err != nil {
		tail := readTail(log.Name(), 6)
		server.stop()
		return nil, fmt.Errorf("%w\nserver log:\n%s", err, tail)
	}
	return server, nil
}

func waitForHealth(ctx context.Context, base string, limit time.Duration) error {
	client := &http.Client{Timeout: 3 * time.Second}
	deadline := time.Now().Add(limit)

	for time.Now().Before(deadline) {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/api/health", nil)
		if err != nil {
			return err
		}
		resp, err := client.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("server did not become healthy within %s", limit)
}

func busy(port int) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 300*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func readTail(path string, lines int) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return lastLines(string(data), lines)
}

func lastLines(s string, n int) string {
	all := strings.Split(strings.TrimRight(s, "\n"), "\n")
	if len(all) > n {
		all = all[len(all)-n:]
	}
	return strings.Join(all, "\n")
}
