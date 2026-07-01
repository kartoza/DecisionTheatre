package server

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	sevenzip "github.com/bodgit/sevenzip"
	"github.com/gorilla/mux"
	"github.com/ncruces/zenity"
	"github.com/kartoza/decision-theatre/internal/config"
	"github.com/kartoza/decision-theatre/internal/geodata"
	"github.com/kartoza/decision-theatre/internal/httputil"
	"github.com/kartoza/decision-theatre/internal/sites"
	"github.com/kartoza/decision-theatre/internal/tiles"
)

// datapackManifest describes the contents of a data pack zip
type datapackManifest struct {
	Format      string `json:"format"`
	Version     string `json:"version"`
	Description string `json:"description"`
	Created     string `json:"created"`
}

// handleDatapackStatus returns the current data pack status, including any in-progress install state.
func (s *Server) handleDatapackStatus(w http.ResponseWriter, r *http.Request) {
	s.installMu.Lock()
	installStatus := s.installStatus
	installErr := s.installErr
	installProgress := s.installProgress
	s.installMu.Unlock()

	// While installing, report progress without reading settings
	if installStatus == "installing" {
		httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{
			"installed":        false,
			"install_status":   installStatus,
			"install_progress": installProgress,
		})
		return
	}

	settings, err := config.LoadSettings()
	if err != nil {
		httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{
			"installed":      false,
			"install_status": installStatus,
			"install_error":  installErr,
			"error":          err.Error(),
		})
		return
	}

	if settings.DataPackPath == "" {
		httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{
			"installed":      false,
			"install_status": installStatus,
			"install_error":  installErr,
		})
		return
	}

	// Check if path still exists
	if _, err := os.Stat(settings.DataPackPath); err != nil {
		httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{
			"installed":      false,
			"install_status": installStatus,
			"install_error":  installErr,
			"error":          "data pack path no longer exists",
		})
		return
	}

	// Try to read manifest
	var manifest datapackManifest
	manifestPath := filepath.Join(settings.DataPackPath, "manifest.json")
	if data, err := os.ReadFile(manifestPath); err == nil {
		json.Unmarshal(data, &manifest)
	}

	httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{
		"installed":      true,
		"install_status": installStatus,
		"path":           settings.DataPackPath,
		"version":        manifest.Version,
		"description":    manifest.Description,
	})
}

// handleDatapackInstall validates the archive then runs extraction asynchronously,
// returning 202 Accepted immediately so large archives don't exceed write timeouts.
func (s *Server) handleDatapackInstall(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Path == "" {
		httputil.RespondError(w, http.StatusBadRequest, "path is required")
		return
	}

	// Validate file exists and is a supported archive format
	if _, err := os.Stat(req.Path); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, fmt.Sprintf("file not found: %s", req.Path))
		return
	}
	lowerPath := strings.ToLower(req.Path)
	if !strings.HasSuffix(lowerPath, ".zip") && !strings.HasSuffix(lowerPath, ".7z") {
		httputil.RespondError(w, http.StatusBadRequest, "file must be a .zip or .7z archive")
		return
	}

	// Reject concurrent installs
	s.installMu.Lock()
	if s.installStatus == "installing" {
		s.installMu.Unlock()
		httputil.RespondError(w, http.StatusConflict, "installation already in progress")
		return
	}
	s.installStatus = "installing"
	s.installErr = ""
	s.installProgress = 0
	s.installMu.Unlock()

	// Install into the directory where the app binary lives
	exe, err := os.Executable()
	if err != nil {
		s.installMu.Lock()
		s.installStatus = "error"
		s.installErr = fmt.Sprintf("could not determine executable path: %v", err)
		s.installMu.Unlock()
		httputil.RespondError(w, http.StatusInternalServerError, s.installErr)
		return
	}
	packDir := filepath.Dir(exe)

	// Close existing data stores before removing files (required on Windows)
	if s.tileStore != nil {
		s.tileStore.Close()
		s.tileStore = nil
	}
	if s.gpkgStore != nil {
		s.gpkgStore.Close()
		s.gpkgStore = nil
	}

	// Acknowledge immediately — extraction runs in the background
	httputil.RespondJSON(w, http.StatusAccepted, map[string]interface{}{
		"install_status": "installing",
	})

	go func() {
		setErr := func(msg string) {
			log.Printf("Datapack install error: %s", msg)
			s.installMu.Lock()
			s.installStatus = "error"
			s.installErr = msg
			s.installMu.Unlock()
		}

		// A panic here runs on a goroutine with no caller to recover it, which
		// would otherwise crash the whole desktop app and force a manual restart.
		// Turn it into a reported install error instead.
		defer func() {
			if r := recover(); r != nil {
				setErr(fmt.Sprintf("installation failed unexpectedly: %v", r))
			}
		}()

		setProgress := func(percent float64) {
			s.installMu.Lock()
			s.installProgress = percent
			s.installMu.Unlock()
		}

		// Replace the existing data/ folder if present
		existingData := filepath.Join(packDir, "data")
		if _, err := os.Stat(existingData); err == nil {
			if err := os.RemoveAll(existingData); err != nil {
				setErr(fmt.Sprintf("could not remove existing data folder: %v", err))
				return
			}
		}

		// Extract archive
		var extractErr error
		if strings.HasSuffix(strings.ToLower(req.Path), ".7z") {
			extractErr = extract7zDatapack(req.Path, packDir, setProgress)
		} else {
			extractErr = extractDatapack(req.Path, packDir, setProgress)
		}
		if extractErr != nil {
			setErr(fmt.Sprintf("extraction failed: %v", extractErr))
			return
		}

		// Validate extracted contents
		if _, err := os.Stat(filepath.Join(packDir, "data")); err != nil {
			setErr("invalid data pack: missing data/ directory")
			return
		}

		// Save settings
		settings, _ := config.LoadSettings()
		settings.DataPackPath = packDir
		if err := config.SaveSettings(settings); err != nil {
			setErr(fmt.Sprintf("could not save settings: %v", err))
			return
		}

		// Reload data stores and routes
		s.reloadDataStores(packDir)

		log.Printf("Data pack installed: %s", packDir)
		s.installMu.Lock()
		s.installStatus = "done"
		s.installMu.Unlock()
	}()
}

// handleDatapackDownloadInfo returns metadata about the configured downloadable datapack archive.
// Returns { available: false } when no archive has been configured via settings.
func (s *Server) handleDatapackDownloadInfo(w http.ResponseWriter, r *http.Request) {
	settings, err := config.LoadSettings()
	if err != nil || settings.DataPackDownloadPath == "" {
		httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{"available": false})
		return
	}

	fi, err := os.Stat(settings.DataPackDownloadPath)
	if err != nil {
		httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{"available": false})
		return
	}

	httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{
		"available":  true,
		"filename":   filepath.Base(settings.DataPackDownloadPath),
		"size_bytes": fi.Size(),
	})
}

// handleDatapackDownload streams the configured datapack archive to the client.
func (s *Server) handleDatapackDownload(w http.ResponseWriter, r *http.Request) {
	settings, err := config.LoadSettings()
	if err != nil || settings.DataPackDownloadPath == "" {
		http.Error(w, "no datapack download configured", http.StatusNotFound)
		return
	}

	fi, err := os.Stat(settings.DataPackDownloadPath)
	if err != nil {
		http.Error(w, "datapack file not found", http.StatusNotFound)
		return
	}

	f, err := os.Open(settings.DataPackDownloadPath)
	if err != nil {
		http.Error(w, "could not open datapack file", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	filename := filepath.Base(settings.DataPackDownloadPath)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", fi.Size()))
	http.ServeContent(w, r, filename, fi.ModTime(), f)
}

type executableInfo struct {
	Available bool   `json:"available"`
	Filename  string `json:"filename,omitempty"`
	SizeBytes int64  `json:"size_bytes,omitempty"`
}

// handleExecutablesInfo returns availability metadata for each platform executable.
func (s *Server) handleExecutablesInfo(w http.ResponseWriter, r *http.Request) {
	settings, err := config.LoadSettings()
	if err != nil {
		settings = &config.Settings{}
	}

	infoFor := func(path string) executableInfo {
		if path == "" {
			return executableInfo{Available: false}
		}
		fi, err := os.Stat(path)
		if err != nil {
			return executableInfo{Available: false}
		}
		return executableInfo{Available: true, Filename: filepath.Base(path), SizeBytes: fi.Size()}
	}

	httputil.RespondJSON(w, http.StatusOK, map[string]executableInfo{
		"windows": infoFor(settings.ExecutableWindows),
		"linux":   infoFor(settings.ExecutableLinux),
		"macos":   infoFor(settings.ExecutableMacOS),
	})
}

// handleExecutableDownload streams the executable for the requested platform.
// The platform is taken from the {platform} path variable: windows, linux, or macos.
func (s *Server) handleExecutableDownload(w http.ResponseWriter, r *http.Request) {
	platform := mux.Vars(r)["platform"]

	settings, err := config.LoadSettings()
	if err != nil {
		http.Error(w, "could not load settings", http.StatusInternalServerError)
		return
	}

	var filePath string
	switch platform {
	case "windows":
		filePath = settings.ExecutableWindows
	case "linux":
		filePath = settings.ExecutableLinux
	case "macos":
		filePath = settings.ExecutableMacOS
	default:
		http.Error(w, "unknown platform", http.StatusBadRequest)
		return
	}

	if filePath == "" {
		http.Error(w, "no executable configured for this platform", http.StatusNotFound)
		return
	}

	fi, err := os.Stat(filePath)
	if err != nil {
		http.Error(w, "executable file not found", http.StatusNotFound)
		return
	}

	f, err := os.Open(filePath)
	if err != nil {
		http.Error(w, "could not open executable file", http.StatusInternalServerError)
		return
	}
	defer f.Close()

	filename := filepath.Base(filePath)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filename))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Length", fmt.Sprintf("%d", fi.Size()))
	http.ServeContent(w, r, filename, fi.ModTime(), f)
}

// handleFileDialog opens a native OS file picker and returns the selected path.
// This is needed because the webview cannot expose native file paths to JavaScript.
func (s *Server) handleFileDialog(w http.ResponseWriter, r *http.Request) {
	path, err := zenity.SelectFile(
		zenity.Title("Select Data Pack"),
		zenity.FileFilters{
			{Name: "Data Packs", Patterns: []string{"*.zip", "*.7z"}},
		},
	)
	if err == zenity.ErrCanceled {
		httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{"path": ""})
		return
	}
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, fmt.Sprintf("could not open file dialog: %v", err))
		return
	}
	httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{"path": path})
}

// reloadDataStores reinitializes tile and geo stores from a new data pack path
func (s *Server) reloadDataStores(packDir string) {
	dataDir := filepath.Join(packDir, "data")
	resourcesDir := filepath.Join(packDir, "resources")

	// Close existing stores
	if s.tileStore != nil {
		s.tileStore.Close()
		s.tileStore = nil
	}
	if s.gpkgStore != nil {
		s.gpkgStore.Close()
		s.gpkgStore = nil
	}

	// Reinitialize
	dataMBTilesDir := filepath.Join(dataDir, "mbtiles")
	tileStore, err := tiles.NewMBTilesStore(dataDir, dataMBTilesDir)
	if err != nil {
		log.Printf("Warning: MBTiles store not available after reload: %v", err)
	} else {
		s.tileStore = tileStore
	}

	gpkgStore, err := geodata.NewGpkgStore(dataDir)
	if err != nil {
		log.Printf("Warning: GeoPackage store not available after reload: %v", err)
	} else {
		s.gpkgStore = gpkgStore
	}

	siteStore, err := sites.NewStore(dataDir)
	if err != nil {
		log.Printf("Warning: Sites store not available after reload: %v", err)
	} else {
		s.siteStore = siteStore
	}

	// Update config for style JSON serving
	s.cfg.DataDir = dataDir
	s.cfg.ResourcesDir = resourcesDir

	// Rebuild routes so the new apiHandler gets the updated store references
	// (gorilla/mux does not support updating routes in place)
	s.rebuildRoutes()
}

// extractDatapack unzips a data pack archive into destDir, preserving the
// directory structure from the zip (e.g. a zip containing data/ will produce destDir/data/).
// onProgress, if non-nil, is called after each file with the cumulative percent (0-100) extracted.
func extractDatapack(zipPath, destDir string, onProgress func(percent float64)) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("could not open zip: %w", err)
	}
	defer r.Close()

	if len(r.File) == 0 {
		return fmt.Errorf("empty zip archive")
	}

	var totalBytes, doneBytes uint64
	for _, f := range r.File {
		totalBytes += f.UncompressedSize64
	}

	for _, f := range r.File {
		// Sanitize path to prevent zip slip
		destPath := filepath.Join(destDir, f.Name)
		if !strings.HasPrefix(destPath, filepath.Clean(destDir)+string(os.PathSeparator)) {
			return fmt.Errorf("illegal file path in zip: %s", f.Name)
		}

		if f.FileInfo().IsDir() {
			os.MkdirAll(destPath, 0o755)
			continue
		}

		if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
			return fmt.Errorf("could not create directory: %w", err)
		}

		outFile, err := os.OpenFile(destPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, f.Mode())
		if err != nil {
			return fmt.Errorf("could not create file: %w", err)
		}

		rc, err := f.Open()
		if err != nil {
			outFile.Close()
			return fmt.Errorf("could not open zip entry: %w", err)
		}

		_, err = io.Copy(outFile, rc)
		rc.Close()
		outFile.Close()
		if err != nil {
			return fmt.Errorf("could not extract file: %w", err)
		}

		doneBytes += f.UncompressedSize64
		if onProgress != nil && totalBytes > 0 {
			onProgress(float64(doneBytes) / float64(totalBytes) * 100)
		}
	}

	return nil
}

// extract7zDatapack extracts a 7z data pack archive into destDir.
// onProgress, if non-nil, is called after each file with the cumulative percent (0-100) extracted.
func extract7zDatapack(archivePath, destDir string, onProgress func(percent float64)) error {
	r, err := sevenzip.OpenReader(archivePath)
	if err != nil {
		return fmt.Errorf("could not open 7z archive: %w", err)
	}
	defer r.Close()

	if len(r.File) == 0 {
		return fmt.Errorf("empty 7z archive")
	}

	var totalBytes, doneBytes uint64
	for _, f := range r.File {
		totalBytes += f.UncompressedSize
	}

	for _, f := range r.File {
		// Sanitize path to prevent zip slip
		destPath := filepath.Join(destDir, f.Name)
		if !strings.HasPrefix(destPath, filepath.Clean(destDir)+string(os.PathSeparator)) {
			return fmt.Errorf("illegal file path in archive: %s", f.Name)
		}

		if f.FileInfo().IsDir() {
			os.MkdirAll(destPath, 0o755)
			continue
		}

		if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
			return fmt.Errorf("could not create directory: %w", err)
		}

		outFile, err := os.OpenFile(destPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, f.Mode())
		if err != nil {
			return fmt.Errorf("could not create file: %w", err)
		}

		rc, err := f.Open()
		if err != nil {
			outFile.Close()
			return fmt.Errorf("could not open archive entry: %w", err)
		}

		_, err = io.Copy(outFile, rc)
		rc.Close()
		outFile.Close()
		if err != nil {
			return fmt.Errorf("could not extract file: %w", err)
		}

		doneBytes += f.UncompressedSize
		if onProgress != nil && totalBytes > 0 {
			onProgress(float64(doneBytes) / float64(totalBytes) * 100)
		}
	}

	return nil
}
