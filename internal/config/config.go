package config

import (
	"encoding/json"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"

	"github.com/kartoza/decision-theatre/internal/fsutil"
)

const appName = "decision-theatre"

// DefaultBindAddress is the interface the server listens on unless told
// otherwise.
//
// Loopback, deliberately. Every endpoint is unauthenticated, so binding all
// interfaces puts the whole API — including the routes that write to disk in the
// desktop build — in reach of everyone on the user's network. A desktop
// application has no reason to accept a connection from another machine, and a
// container needs the opposite, so the container asks for it explicitly rather
// than being served by an unsafe default.
const DefaultBindAddress = "127.0.0.1"

// Config holds the application configuration
type Config struct {
	Port int

	// BindAddress is the interface to listen on. Empty means
	// DefaultBindAddress: the zero value must be the safe one, so a caller that
	// forgets the field does not accidentally publish to the network.
	//
	// Use "0.0.0.0" to accept connections from anywhere, which is what the
	// container deployment does — see deployments/docker-compose.yaml.
	BindAddress string

	DataDir      string
	ResourcesDir string
	Version      string

	// SatelliteTileURL is the raster basemap the client uses for satellite
	// imagery, an {x}/{y}/{z} template passed to maplibre.
	//
	// Configurable so that changing provider does not require a rebuild. The
	// default is Google's undocumented mt0.google.com endpoint, which needs no
	// key — which is exactly why using it falls outside the Google Maps terms of
	// service. Replacing it is a live decision (issue #65); this field is what
	// makes that decision a deployment change rather than a code change.
	SatelliteTileURL string

	// SatelliteAttribution is displayed on the map for the above. For most
	// providers this is a licence condition rather than a courtesy, so it travels
	// with the URL instead of being hardcoded in the client.
	SatelliteAttribution string

	// MapTilerKey authenticates the server's glyph fetches against
	// api.maptiler.com. Fonts are the only thing it buys: the vector tiles are
	// served from the local mbtiles file, so this is not what draws the map.
	//
	// It has no default and none is compiled in. The key that used to be written
	// here in the source was published in the repository, in every release
	// binary and in every data pack, which is why it now has to be supplied at
	// run time — see issue #31. Empty is a supported state, not an error: the
	// glyph proxy answers with no glyphs and the map renders without place
	// labels, exactly as it already does on a machine with no internet.
	//
	// Never build a URL from this without going through MapTilerGlyphURL, which
	// is what refuses to emit "key=" with nothing after it.
	MapTilerKey string

	// DesktopMode is true only when the process owns a desktop session and has
	// opened the embedded WebView window.
	//
	// It gates routes that are meaningless — and dangerous — without one.
	// /api/dialog/open-file calls zenity, which opens a native file picker on
	// whatever desktop the process is attached to and blocks until a human
	// answers it. On the hosted deployment nginx proxies every path, so that
	// endpoint was internet-reachable: a stranger could pop a window on the
	// server's desktop, and every call held a server goroutine for as long as
	// the dialog stood open.
	//
	// The zero value is the safe one. A caller that forgets to set it gets the
	// server build, without the desktop-only routes.
	DesktopMode bool
}

// DefaultSatelliteTileURL is used when nothing is configured. See
// SatelliteTileURL for why this particular endpoint is a known problem.
const DefaultSatelliteTileURL = "https://mt0.google.com/vt/lyrs=y&x={x}&y={y}&z={z}"

// DefaultSatelliteAttribution matches DefaultSatelliteTileURL.
const DefaultSatelliteAttribution = "© Google Maps"

// Satellite returns the configured basemap template and its attribution, applying
// the defaults.
func (c Config) Satellite() (tileURL, attribution string) {
	tileURL = c.SatelliteTileURL
	if tileURL == "" {
		tileURL = DefaultSatelliteTileURL
	}
	attribution = c.SatelliteAttribution
	if attribution == "" && tileURL == DefaultSatelliteTileURL {
		// Only default the attribution alongside the default URL: crediting
		// Google for somebody else's imagery would be worse than crediting
		// nobody.
		attribution = DefaultSatelliteAttribution
	}
	return tileURL, attribution
}

// MapTilerKeyEnv names the environment variable the key can be supplied in.
//
// The environment rather than a flag is the intended route for a deployment: a
// flag value is visible in `ps` to every user on the host and would have to be
// written into deployments/docker-compose.yaml, which is tracked. The flag
// exists as well because a developer running one command should not have to
// export anything.
const MapTilerKeyEnv = "DT_MAPTILER_API_KEY"

// mapTilerGlyphEndpoint is the upstream glyph URL, without its key.
const mapTilerGlyphEndpoint = "https://api.maptiler.com/fonts/%s/%s.pbf"

// MapTilerGlyphURL builds the upstream URL for one font range, reporting false
// when no key is configured.
//
// The boolean is the point of the signature. Returning a URL with an empty key
// parameter would be answered by MapTiler with a 403, which reaches the user as
// missing labels on the map with nothing in the interface to connect that to a
// missing setting; the caller is made to notice the absence instead.
//
// fontstack and glyphRange arrive from the request path and are escaped, so a
// crafted font name cannot append parameters of its own to the query string.
func (c Config) MapTilerGlyphURL(fontstack, glyphRange string) (string, bool) {
	key := strings.TrimSpace(c.MapTilerKey)
	if key == "" {
		return "", false
	}
	return fmt.Sprintf(mapTilerGlyphEndpoint,
		url.PathEscape(fontstack), url.PathEscape(glyphRange),
	) + "?key=" + url.QueryEscape(key), true
}

// ResolveMapTilerKey picks the key from the places it may be supplied, most
// specific instruction first: the command line, then the environment, then the
// saved settings.
//
// Three sources because there are three ways this application runs. A container
// has an environment and no user; a desktop install that was double-clicked has
// neither a command line nor an environment a person can reasonably set, so its
// key lives in settings.json alongside the data pack path. settings may be nil.
//
// Surrounding whitespace is dropped. A key pasted into a file or a compose
// environment block picks up a trailing newline easily, and MapTiler answers a
// key with a newline in it the same way it answers a wrong one.
func ResolveMapTilerKey(flagValue string, settings *Settings) string {
	if v := strings.TrimSpace(flagValue); v != "" {
		return v
	}
	if v := strings.TrimSpace(os.Getenv(MapTilerKeyEnv)); v != "" {
		return v
	}
	if settings != nil {
		if v := strings.TrimSpace(settings.MapTilerKey); v != "" {
			return v
		}
	}
	return ""
}

// ListenAddress returns the host:port to bind, applying the safe default.
func (c Config) ListenAddress() string {
	return c.ListenAddressForPort(c.Port)
}

// ListenAddressForPort is ListenAddress for a port other than the configured
// one, used by the auxiliary tile listeners.
func (c Config) ListenAddressForPort(port int) string {
	host := c.BindAddress
	if host == "" {
		host = DefaultBindAddress
	}
	return net.JoinHostPort(host, strconv.Itoa(port))
}

// LocalURL returns a URL this process can use to reach its own server: the
// address the webview loads and the readiness probe polls.
//
// A wildcard bind is not a usable destination, so it becomes localhost. Any other
// address is used as given, because a bind to one specific interface means
// localhost is not listening.
func (c Config) LocalURL() string {
	host := c.BindAddress
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		host = "localhost"
	}
	return "http://" + net.JoinHostPort(host, strconv.Itoa(c.Port))
}

// Settings holds persistent user settings saved to disk
type Settings struct {
	DataPackPath         string `json:"data_pack_path,omitempty"`
	DataPackDownloadPath string `json:"data_pack_download_path,omitempty"`
	ExecutableWindows    string `json:"executable_windows,omitempty"`
	ExecutableLinux      string `json:"executable_linux,omitempty"`
	ExecutableMacOS      string `json:"executable_macos,omitempty"`

	// MapTilerKey is how a desktop install supplies the glyph key. It is the
	// only route available to a build that was downloaded and double-clicked,
	// which has no command line and no environment of its own. See
	// Config.MapTilerKey for what happens when it is absent.
	MapTilerKey string `json:"maptiler_key,omitempty"`
}

// SettingsDir returns the platform-appropriate config directory.
// Linux: ~/.config/decision-theatre
// macOS: ~/Library/Application Support/decision-theatre
// Windows: %APPDATA%\decision-theatre
func SettingsDir() (string, error) {
	configDir, err := os.UserConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, appName), nil
}

// DataStoreDir returns the platform-appropriate, per-user writable directory
// for extracted data packs. This is deliberately independent of the
// executable's own location: on Windows the executable typically lives under
// Program Files, which standard (non-admin) users cannot write to, so
// installing a data pack there fails or hangs while Windows retries denied
// writes. Using a per-user directory instead — the same approach already
// used for SettingsDir — keeps installation working without elevation.
// Linux: $XDG_DATA_HOME/decision-theatre or ~/.local/share/decision-theatre
// macOS: ~/Library/Application Support/decision-theatre
// Windows: %LOCALAPPDATA%\decision-theatre
func DataStoreDir() (string, error) {
	switch runtime.GOOS {
	case "windows":
		dir := os.Getenv("LOCALAPPDATA")
		if dir == "" {
			home, err := os.UserHomeDir()
			if err != nil {
				return "", err
			}
			dir = filepath.Join(home, "AppData", "Local")
		}
		return filepath.Join(dir, appName), nil
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "Library", "Application Support", appName), nil
	default:
		if dir := os.Getenv("XDG_DATA_HOME"); dir != "" {
			return filepath.Join(dir, appName), nil
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, ".local", "share", appName), nil
	}
}

func settingsPath() (string, error) {
	dir, err := SettingsDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "settings.json"), nil
}

// LoadSettings reads settings from the config file. Returns default settings if file doesn't exist.
func LoadSettings() (*Settings, error) {
	path, err := settingsPath()
	if err != nil {
		return &Settings{}, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &Settings{}, nil
		}
		return &Settings{}, err
	}

	var s Settings
	if err := json.Unmarshal(data, &s); err != nil {
		return &Settings{}, err
	}
	return &s, nil
}

// SaveSettings writes settings to the config file.
func SaveSettings(s *Settings) error {
	path, err := settingsPath()
	if err != nil {
		return err
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}

	// Atomic, for the same reason as the site files: a truncate-then-write leaves
	// settings empty if the machine stops in between, and these name the datapack
	// the application loads at startup.
	return fsutil.WriteFileAtomic(path, data, 0o644)
}
