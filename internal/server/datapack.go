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
	s.installMu.Unlock()

	// While installing, report progress without reading settings
	if installStatus == "installing" {
		httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{
			"installed":      false,
			"install_status": installStatus,
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
			extractErr = extract7zDatapack(req.Path, packDir)
		} else {
			extractErr = extractDatapack(req.Path, packDir)
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
func extractDatapack(zipPath, destDir string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return fmt.Errorf("could not open zip: %w", err)
	}
	defer r.Close()

	if len(r.File) == 0 {
		return fmt.Errorf("empty zip archive")
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
	}

	return nil
}

// extract7zDatapack extracts a 7z data pack archive into destDir.
func extract7zDatapack(archivePath, destDir string) error {
	r, err := sevenzip.OpenReader(archivePath)
	if err != nil {
		return fmt.Errorf("could not open 7z archive: %w", err)
	}
	defer r.Close()

	if len(r.File) == 0 {
		return fmt.Errorf("empty 7z archive")
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
	}

	return nil
}
