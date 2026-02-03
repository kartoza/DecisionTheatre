package projects

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

// PaneState represents the state of a single comparison pane
type PaneState struct {
	LeftScenario  string `json:"leftScenario"`
	RightScenario string `json:"rightScenario"`
	Attribute     string `json:"attribute"`
}

// Project represents a saved project with all its state
type Project struct {
	ID          string       `json:"id"`
	Title       string       `json:"title"`
	Description string       `json:"description"`
	Thumbnail   *string      `json:"thumbnail"`
	CreatedAt   string       `json:"createdAt"`
	UpdatedAt   string       `json:"updatedAt"`
	PaneStates  []*PaneState `json:"paneStates,omitempty"`
	LayoutMode  string       `json:"layoutMode,omitempty"`
	FocusedPane int          `json:"focusedPane,omitempty"`
}

// Store handles project persistence
type Store struct {
	dataDir     string
	projectsDir string
	imagesDir   string
}

// NewStore creates a new project store
func NewStore(dataDir string) (*Store, error) {
	projectsDir := filepath.Join(dataDir, "projects")
	imagesDir := filepath.Join(dataDir, "images")

	// Ensure directories exist
	if err := os.MkdirAll(projectsDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create projects directory: %w", err)
	}
	if err := os.MkdirAll(imagesDir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create images directory: %w", err)
	}

	return &Store{
		dataDir:     dataDir,
		projectsDir: projectsDir,
		imagesDir:   imagesDir,
	}, nil
}

// List returns all projects sorted by creation date (newest first)
func (s *Store) List() ([]*Project, error) {
	entries, err := os.ReadDir(s.projectsDir)
	if err != nil {
		return nil, fmt.Errorf("failed to read projects directory: %w", err)
	}

	var projects []*Project
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".json") {
			project, err := s.loadProject(entry.Name())
			if err != nil {
				continue // Skip invalid projects
			}
			projects = append(projects, project)
		}
	}

	// Sort by creation date, newest first
	sort.Slice(projects, func(i, j int) bool {
		return projects[i].CreatedAt > projects[j].CreatedAt
	})

	return projects, nil
}

// Get retrieves a project by ID
func (s *Store) Get(id string) (*Project, error) {
	filename := fmt.Sprintf("%s.json", id)
	return s.loadProject(filename)
}

// Create creates a new project
func (s *Store) Create(project *Project) (*Project, error) {
	// Generate ID and timestamps
	project.ID = uuid.New().String()
	now := time.Now().UTC().Format(time.RFC3339)
	project.CreatedAt = now
	project.UpdatedAt = now

	// Set defaults if not provided
	if project.PaneStates == nil {
		project.PaneStates = []*PaneState{
			{LeftScenario: "reference", RightScenario: "current", Attribute: ""},
			{LeftScenario: "current", RightScenario: "future", Attribute: ""},
			{LeftScenario: "reference", RightScenario: "future", Attribute: ""},
			{LeftScenario: "reference", RightScenario: "current", Attribute: ""},
		}
	}
	if project.LayoutMode == "" {
		project.LayoutMode = "single"
	}

	// Save thumbnail image if provided
	if project.Thumbnail != nil && strings.HasPrefix(*project.Thumbnail, "data:image") {
		imagePath, err := s.saveThumbnail(project.ID, *project.Thumbnail)
		if err != nil {
			return nil, fmt.Errorf("failed to save thumbnail: %w", err)
		}
		project.Thumbnail = &imagePath
	}

	// Save project
	if err := s.saveProject(project); err != nil {
		return nil, err
	}

	return project, nil
}

// Update updates an existing project
func (s *Store) Update(id string, updates *Project) (*Project, error) {
	project, err := s.Get(id)
	if err != nil {
		return nil, err
	}

	// Apply updates
	if updates.Title != "" {
		project.Title = updates.Title
	}
	if updates.Description != "" {
		project.Description = updates.Description
	}
	if updates.Thumbnail != nil {
		// Handle new thumbnail upload
		if strings.HasPrefix(*updates.Thumbnail, "data:image") {
			imagePath, err := s.saveThumbnail(project.ID, *updates.Thumbnail)
			if err != nil {
				return nil, fmt.Errorf("failed to save thumbnail: %w", err)
			}
			project.Thumbnail = &imagePath
		} else {
			project.Thumbnail = updates.Thumbnail
		}
	}
	if updates.PaneStates != nil {
		project.PaneStates = updates.PaneStates
	}
	if updates.LayoutMode != "" {
		project.LayoutMode = updates.LayoutMode
	}
	project.FocusedPane = updates.FocusedPane

	project.UpdatedAt = time.Now().UTC().Format(time.RFC3339)

	if err := s.saveProject(project); err != nil {
		return nil, err
	}

	return project, nil
}

// Delete removes a project
func (s *Store) Delete(id string) error {
	project, err := s.Get(id)
	if err != nil {
		return err
	}

	// Delete thumbnail if exists
	if project.Thumbnail != nil && strings.HasPrefix(*project.Thumbnail, "/data/images/") {
		imagePath := filepath.Join(s.dataDir, strings.TrimPrefix(*project.Thumbnail, "/data/"))
		os.Remove(imagePath) // Ignore errors
	}

	// Delete project file
	filename := filepath.Join(s.projectsDir, fmt.Sprintf("%s.json", id))
	return os.Remove(filename)
}

// loadProject loads a project from disk
func (s *Store) loadProject(filename string) (*Project, error) {
	path := filepath.Join(s.projectsDir, filename)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read project file: %w", err)
	}

	var project Project
	if err := json.Unmarshal(data, &project); err != nil {
		return nil, fmt.Errorf("failed to parse project: %w", err)
	}

	return &project, nil
}

// saveProject saves a project to disk
func (s *Store) saveProject(project *Project) error {
	data, err := json.MarshalIndent(project, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal project: %w", err)
	}

	filename := filepath.Join(s.projectsDir, fmt.Sprintf("%s.json", project.ID))
	if err := os.WriteFile(filename, data, 0644); err != nil {
		return fmt.Errorf("failed to write project file: %w", err)
	}

	return nil
}

// saveThumbnail saves a base64 image to disk and returns the URL path
func (s *Store) saveThumbnail(projectID, dataURL string) (string, error) {
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

	// Save to file
	filename := fmt.Sprintf("%s%s", projectID, ext)
	path := filepath.Join(s.imagesDir, filename)
	if err := os.WriteFile(path, imageData, 0644); err != nil {
		return "", fmt.Errorf("failed to write image file: %w", err)
	}

	// Return URL path for serving
	return fmt.Sprintf("/data/images/%s", filename), nil
}
