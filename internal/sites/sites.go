package sites

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/google/uuid"
)

// SiteCreationMethod represents how a site boundary was created
type SiteCreationMethod string

const (
	MethodShapefile  SiteCreationMethod = "shapefile"
	MethodGeoJSON    SiteCreationMethod = "geojson"
	MethodDrawn      SiteCreationMethod = "drawn"
	MethodCatchments SiteCreationMethod = "catchments"
)

// PaneState represents the state of a single comparison pane
type PaneState struct {
	LeftScenario  string `json:"leftScenario"`
	RightScenario string `json:"rightScenario"`
	Attribute     string `json:"attribute"`
}

// Site represents a saved site with its boundary and state
type Site struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	Thumbnail   *string `json:"thumbnail"`
	CreatedAt   string  `json:"createdAt"`
	UpdatedAt   string  `json:"updatedAt"`

	// Map state
	PaneStates  []*PaneState `json:"paneStates,omitempty"`
	LayoutMode  string       `json:"layoutMode,omitempty"`
	FocusedPane int          `json:"focusedPane,omitempty"`

	// Site boundary (geometry)
	Geometry       json.RawMessage    `json:"geometry,omitempty"` // GeoJSON geometry
	BoundingBox    *BoundingBox       `json:"boundingBox"`        // Pre-computed bbox for quick lookups
	Area           float64            `json:"area"`               // Area in square kilometers
	CreationMethod SiteCreationMethod `json:"creationMethod"`     // How the boundary was created
	CatchmentIDs   []string           `json:"catchmentIds"`       // If created from catchments, store their IDs

	// Site indicators (aggregated from catchments)
	Indicators *SiteIndicators `json:"indicators,omitempty"` // Aggregated indicator values
}

// BoundingBox represents a geographic bounding box
type BoundingBox struct {
	MinX float64 `json:"minX"` // West
	MinY float64 `json:"minY"` // South
	MaxX float64 `json:"maxX"` // East
	MaxY float64 `json:"maxY"` // North
}

// SiteIndicators holds aggregated indicator values for a site
// All values are area-weighted aggregations of constituent catchments
type SiteIndicators struct {
	// Reference scenario values (historical baseline)
	Reference map[string]float64 `json:"reference"`
	// Current scenario values (current observed conditions)
	Current map[string]float64 `json:"current"`
	// Ideal values (starts as copy of current, user-editable)
	Ideal map[string]float64 `json:"ideal"`
	// Metadata about the extraction
	ExtractedAt    string   `json:"extractedAt"`    // When indicators were extracted
	CatchmentCount int      `json:"catchmentCount"` // Number of catchments used
	TotalAreaKm2   float64  `json:"totalAreaKm2"`   // Total area in km²
	CatchmentIDs   []string `json:"catchmentIds"`   // IDs of catchments used
}

// Store handles site persistence
type Store struct {
	dataDir   string
	sitesDir  string
	imagesDir string
}

// NewStore creates a new site store
func NewStore(dataDir string) (*Store, error) {
	sitesDir := filepath.Join(dataDir, "sites")
	imagesDir := filepath.Join(dataDir, "images")

	// Ensure directories exist
	if err := os.MkdirAll(sitesDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create sites directory: %w", err)
	}
	if err := os.MkdirAll(imagesDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create images directory: %w", err)
	}

	return &Store{
		dataDir:   dataDir,
		sitesDir:  sitesDir,
		imagesDir: imagesDir,
	}, nil
}

// List returns all sites sorted by creation date (newest first)
func (s *Store) List() ([]*Site, error) {
	entries, err := os.ReadDir(s.sitesDir)
	if err != nil {
		return nil, fmt.Errorf("failed to read sites directory: %w", err)
	}

	var sites []*Site
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			site, err := s.loadSite(entry.Name())
			if err != nil {
				continue // Skip invalid sites
			}
			sites = append(sites, site)
		}
	}

	// Sort by creation date, newest first
	sort.Slice(sites, func(i, j int) bool {
		return sites[i].CreatedAt > sites[j].CreatedAt
	})

	return sites, nil
}

// Get retrieves a site by ID
func (s *Store) Get(id string) (*Site, error) {
	filename := fmt.Sprintf("%s.json", id)
	return s.loadSite(filename)
}

// Create creates a new site
func (s *Store) Create(site *Site) (*Site, error) {
	// Generate ID and timestamps
	site.ID = uuid.New().String()
	now := time.Now().UTC().Format(time.RFC3339)
	site.CreatedAt = now
	site.UpdatedAt = now

	// Set defaults for pane states if not provided
	if site.PaneStates == nil {
		site.PaneStates = []*PaneState{
			{LeftScenario: "reference", RightScenario: "current", Attribute: ""},
			{LeftScenario: "current", RightScenario: "future", Attribute: ""},
			{LeftScenario: "reference", RightScenario: "future", Attribute: ""},
			{LeftScenario: "reference", RightScenario: "current", Attribute: ""},
		}
	}
	if site.LayoutMode == "" {
		site.LayoutMode = "single"
	}

	// Compute bounding box if geometry is provided and bbox is not
	if site.BoundingBox == nil && len(site.Geometry) > 0 {
		bbox, err := computeBoundingBox(site.Geometry)
		if err == nil {
			site.BoundingBox = bbox
		}
	}

	// Save thumbnail image if provided as data URL
	if site.Thumbnail != nil && strings.HasPrefix(*site.Thumbnail, "data:image") {
		imagePath, err := s.saveThumbnail(site.ID, *site.Thumbnail)
		if err != nil {
			return nil, fmt.Errorf("failed to save thumbnail: %w", err)
		}
		site.Thumbnail = &imagePath
	}

	// Save site
	if err := s.saveSite(site); err != nil {
		return nil, err
	}

	return site, nil
}

// Update updates an existing site
func (s *Store) Update(id string, updates *Site) (*Site, error) {
	site, err := s.Get(id)
	if err != nil {
		return nil, err
	}

	// Apply updates
	if updates.Title != "" {
		site.Title = updates.Title
	}
	if updates.Description != "" {
		site.Description = updates.Description
	}
	if updates.Thumbnail != nil {
		// Handle new thumbnail upload
		if strings.HasPrefix(*updates.Thumbnail, "data:image") {
			imagePath, err := s.saveThumbnail(site.ID, *updates.Thumbnail)
			if err != nil {
				return nil, fmt.Errorf("failed to save thumbnail: %w", err)
			}
			site.Thumbnail = &imagePath
		} else {
			site.Thumbnail = updates.Thumbnail
		}
	}
	if len(updates.Geometry) > 0 {
		site.Geometry = updates.Geometry
		// Recompute bounding box
		bbox, err := computeBoundingBox(updates.Geometry)
		if err == nil {
			site.BoundingBox = bbox
		}
	}
	if updates.Area > 0 {
		site.Area = updates.Area
	}

	// Map state updates
	if updates.PaneStates != nil {
		site.PaneStates = updates.PaneStates
	}
	if updates.LayoutMode != "" {
		site.LayoutMode = updates.LayoutMode
	}
	site.FocusedPane = updates.FocusedPane

	// Indicators update
	if updates.Indicators != nil {
		site.Indicators = updates.Indicators
	}

	site.UpdatedAt = time.Now().UTC().Format(time.RFC3339)

	if err := s.saveSite(site); err != nil {
		return nil, err
	}

	return site, nil
}

// Delete removes a site
func (s *Store) Delete(id string) error {
	site, err := s.Get(id)
	if err != nil {
		return err
	}

	// Delete thumbnail if exists
	if site.Thumbnail != nil && strings.HasPrefix(*site.Thumbnail, "/data/images/") {
		imagePath := filepath.Join(s.dataDir, strings.TrimPrefix(*site.Thumbnail, "/data/"))
		os.Remove(imagePath) // Ignore errors
	}

	// Delete site file
	filename := filepath.Join(s.sitesDir, fmt.Sprintf("%s.json", id))
	return os.Remove(filename)
}

// loadSite loads a site from disk
func (s *Store) loadSite(filename string) (*Site, error) {
	path := filepath.Join(s.sitesDir, filename)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read site file: %w", err)
	}

	var site Site
	if err := json.Unmarshal(data, &site); err != nil {
		return nil, fmt.Errorf("failed to parse site: %w", err)
	}

	return &site, nil
}

// saveSite saves a site to disk
func (s *Store) saveSite(site *Site) error {
	data, err := json.MarshalIndent(site, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal site: %w", err)
	}

	filename := filepath.Join(s.sitesDir, fmt.Sprintf("%s.json", site.ID))
	if err := os.WriteFile(filename, data, 0644); err != nil {
		return fmt.Errorf("failed to write site file: %w", err)
	}

	return nil
}

// saveThumbnail saves a base64 image to disk and returns the URL path
func (s *Store) saveThumbnail(siteID, dataURL string) (string, error) {
	// Parse data URL: data:image/jpeg;base64,/9j/4AAQ...
	parts := strings.SplitN(dataURL, ",", 2)
	if len(parts) != 2 {
		return "", fmt.Errorf("invalid data URL format")
	}

	// Determine file extension from MIME type
	ext := ".jpg"
	if strings.Contains(parts[0], "png") {
		ext = ".png"
	} else if strings.Contains(parts[0], "gif") {
		ext = ".gif"
	} else if strings.Contains(parts[0], "webp") {
		ext = ".webp"
	}

	// Decode base64
	imageData, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return "", fmt.Errorf("failed to decode base64 image: %w", err)
	}

	// Save to file with site- prefix to distinguish from project thumbnails
	filename := fmt.Sprintf("site-%s%s", siteID, ext)
	path := filepath.Join(s.imagesDir, filename)
	if err := os.WriteFile(path, imageData, 0644); err != nil {
		return "", fmt.Errorf("failed to write image file: %w", err)
	}

	// Return URL path for serving
	return fmt.Sprintf("/data/images/%s", filename), nil
}

// computeBoundingBox extracts the bounding box from GeoJSON geometry
func computeBoundingBox(geometry json.RawMessage) (*BoundingBox, error) {
	var geom map[string]interface{}
	if err := json.Unmarshal(geometry, &geom); err != nil {
		return nil, err
	}

	bbox := &BoundingBox{
		MinX: 180,
		MinY: 90,
		MaxX: -180,
		MaxY: -90,
	}

	// Extract coordinates and compute bbox
	extractCoords(geom, bbox)

	return bbox, nil
}

// extractCoords recursively extracts coordinates from GeoJSON
func extractCoords(geom map[string]interface{}, bbox *BoundingBox) {
	geomType, _ := geom["type"].(string)

	switch geomType {
	case "Point":
		coords, ok := geom["coordinates"].([]interface{})
		if ok && len(coords) >= 2 {
			x, _ := coords[0].(float64)
			y, _ := coords[1].(float64)
			updateBBox(bbox, x, y)
		}
	case "LineString", "MultiPoint":
		coords, ok := geom["coordinates"].([]interface{})
		if ok {
			for _, c := range coords {
				pt, ok := c.([]interface{})
				if ok && len(pt) >= 2 {
					x, _ := pt[0].(float64)
					y, _ := pt[1].(float64)
					updateBBox(bbox, x, y)
				}
			}
		}
	case "Polygon", "MultiLineString":
		coords, ok := geom["coordinates"].([]interface{})
		if ok {
			for _, ring := range coords {
				r, ok := ring.([]interface{})
				if ok {
					for _, c := range r {
						pt, ok := c.([]interface{})
						if ok && len(pt) >= 2 {
							x, _ := pt[0].(float64)
							y, _ := pt[1].(float64)
							updateBBox(bbox, x, y)
						}
					}
				}
			}
		}
	case "MultiPolygon":
		coords, ok := geom["coordinates"].([]interface{})
		if ok {
			for _, polygon := range coords {
				p, ok := polygon.([]interface{})
				if ok {
					for _, ring := range p {
						r, ok := ring.([]interface{})
						if ok {
							for _, c := range r {
								pt, ok := c.([]interface{})
								if ok && len(pt) >= 2 {
									x, _ := pt[0].(float64)
									y, _ := pt[1].(float64)
									updateBBox(bbox, x, y)
								}
							}
						}
					}
				}
			}
		}
	case "GeometryCollection":
		geometries, ok := geom["geometries"].([]interface{})
		if ok {
			for _, g := range geometries {
				gmap, ok := g.(map[string]interface{})
				if ok {
					extractCoords(gmap, bbox)
				}
			}
		}
	}
}

func updateBBox(bbox *BoundingBox, x, y float64) {
	if x < bbox.MinX {
		bbox.MinX = x
	}
	if x > bbox.MaxX {
		bbox.MaxX = x
	}
	if y < bbox.MinY {
		bbox.MinY = y
	}
	if y > bbox.MaxY {
		bbox.MaxY = y
	}
}
