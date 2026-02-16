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

	"github.com/kartoza/decision-theatre/internal/config"
	"github.com/kartoza/decision-theatre/internal/geodata"
	"github.com/kartoza/decision-theatre/internal/httputil"
	"github.com/kartoza/decision-theatre/internal/tiles"
)

// datapackManifest describes the contents of a data pack zip
type datapackManifest struct {
	Format      string `json:"format"`
	Version     string `json:"version"`
	Description string `json:"description"`
	Created     string `json:"created"`
}

// handleDatapackStatus returns the current data pack status
func (s *Server) handleDatapackStatus(w http.ResponseWriter, r *http.Request) {
	settings, err := config.LoadSettings()
	if err != nil {
		httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{
			"installed": false,
			"error":     err.Error(),
		})
		return
	}

	if settings.DataPackPath == "" {
		httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{
			"installed": false,
		})
		return
	}

	// Check if path still exists
	if _, err := os.Stat(settings.DataPackPath); err != nil {
		httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{
			"installed": false,
			"error":     "data pack path no longer exists",
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
		"installed":   true,
		"path":        settings.DataPackPath,
		"version":     manifest.Version,
		"description": manifest.Description,
	})
}

// handleDatapackInstall extracts a data pack zip and registers it
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

	// Validate file exists and is a zip
	if _, err := os.Stat(req.Path); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, fmt.Sprintf("file not found: %s", req.Path))
		return
	}
	if !strings.HasSuffix(strings.ToLower(req.Path), ".zip") {
		httputil.RespondError(w, http.StatusBadRequest, "file must be a .zip archive")
		return
	}

	// Determine extraction target
	storeDir, err := config.DataStoreDir()
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, fmt.Sprintf("could not determine data directory: %v", err))
		return
	}
	extractDir := filepath.Join(storeDir, "datapacks")
	if err := os.MkdirAll(extractDir, 0o755); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, fmt.Sprintf("could not create directory: %v", err))
		return
	}

	// Extract zip
	packDir, err := extractDatapack(req.Path, extractDir)
	if err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, fmt.Sprintf("extraction failed: %v", err))
		return
	}

	// Validate extracted contents
	if _, err := os.Stat(filepath.Join(packDir, "resources")); err != nil {
		httputil.RespondError(w, http.StatusBadRequest, "invalid data pack: missing resources/ directory")
		return
	}

	// Save settings
	settings, _ := config.LoadSettings()
	settings.DataPackPath = packDir
	if err := config.SaveSettings(settings); err != nil {
		httputil.RespondError(w, http.StatusInternalServerError, fmt.Sprintf("could not save settings: %v", err))
		return
	}

	// Reload data stores
	s.reloadDataStores(packDir)

	log.Printf("Data pack installed: %s", packDir)
	httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{
		"installed": true,
		"path":      packDir,
		"message":   "Data pack installed successfully. The application will reload.",
	})
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
	if s.geoStore != nil {
		s.geoStore.Close()
		s.geoStore = nil
	}

	// Reinitialize
	dataMBTilesDir := filepath.Join(dataDir, "mbtiles")
	tileStore, err := tiles.NewMBTilesStore(dataDir, dataMBTilesDir)
	if err != nil {
		log.Printf("Warning: MBTiles store not available after reload: %v", err)
	} else {
		s.tileStore = tileStore
	}

	geoStore, err := geodata.NewGeoParquetStore(dataDir)
	if err != nil {
		log.Printf("Warning: GeoParquet store not available after reload: %v", err)
	} else {
		s.geoStore = geoStore
	}

	// Update config for style JSON serving
	s.cfg.DataDir = dataDir
	s.cfg.ResourcesDir = resourcesDir
}

// extractDatapack unzips a data pack archive into the target directory.
// Returns the path to the extracted pack root directory.
func extractDatapack(zipPath, targetDir string) (string, error) {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return "", fmt.Errorf("could not open zip: %w", err)
	}
	defer r.Close()

	// Find the common root directory name from the zip
	var rootDir string
	for _, f := range r.File {
		parts := strings.SplitN(f.Name, "/", 2)
		if len(parts) > 0 {
			rootDir = parts[0]
			break
		}
	}
	if rootDir == "" {
		return "", fmt.Errorf("empty zip archive")
	}

	packDir := filepath.Join(targetDir, rootDir)

	// Remove existing extraction if present
	os.RemoveAll(packDir)

	for _, f := range r.File {
		// Sanitize path to prevent zip slip
		destPath := filepath.Join(targetDir, f.Name)
		if !strings.HasPrefix(destPath, filepath.Clean(targetDir)+string(os.PathSeparator)) {
			return "", fmt.Errorf("illegal file path in zip: %s", f.Name)
		}

		if f.FileInfo().IsDir() {
			os.MkdirAll(destPath, 0o755)
			continue
		}

		if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
			return "", fmt.Errorf("could not create directory: %w", err)
		}

		outFile, err := os.OpenFile(destPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, f.Mode())
		if err != nil {
			return "", fmt.Errorf("could not create file: %w", err)
		}

		rc, err := f.Open()
		if err != nil {
			outFile.Close()
			return "", fmt.Errorf("could not open zip entry: %w", err)
		}

		_, err = io.Copy(outFile, rc)
		rc.Close()
		outFile.Close()
		if err != nil {
			return "", fmt.Errorf("could not extract file: %w", err)
		}
	}

	return packDir, nil
}
