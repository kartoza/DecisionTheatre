package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
)

const appName = "decision-theatre"

// Config holds the application configuration
type Config struct {
	Port         int
	DataDir      string
	ResourcesDir string
	Version      string
}

// Settings holds persistent user settings saved to disk
type Settings struct {
	DataPackPath         string `json:"data_pack_path,omitempty"`
	DataPackDownloadPath string `json:"data_pack_download_path,omitempty"`
	ExecutableWindows    string `json:"executable_windows,omitempty"`
	ExecutableLinux      string `json:"executable_linux,omitempty"`
	ExecutableMacOS      string `json:"executable_macos,omitempty"`
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

	return os.WriteFile(path, data, 0o644)
}
