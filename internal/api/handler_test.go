package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/gorilla/mux"
	"github.com/kartoza/decision-theatre/internal/config"
)

func newTestHandler() *Handler {
	cfg := config.Config{
		Port:    8080,
		DataDir: "/tmp/test",
		Version: "test",
	}
	return NewHandler(nil, nil, nil, cfg, nil)
}

func TestHealthEndpoint(t *testing.T) {
	handler := newTestHandler()
	r := mux.NewRouter()
	handler.RegisterRoutes(r)

	req := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	var response map[string]string
	json.NewDecoder(w.Body).Decode(&response)

	if response["status"] != "ok" {
		t.Errorf("Expected status 'ok', got '%s'", response["status"])
	}
}

func TestScenarioColoursEndpoint(t *testing.T) {
	handler := newTestHandler()
	r := mux.NewRouter()
	handler.RegisterRoutes(r)

	req := httptest.NewRequest("GET", "/scenarios/colours", nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	var response ScenarioColours
	if err := json.NewDecoder(w.Body).Decode(&response); err != nil {
		t.Fatalf("decoding response: %v", err)
	}

	// newTestHandler's DataDir has no colours.json, so this is the defaults
	// path end to end -- the override path is covered directly in
	// colours_cache_test.go.
	if response != defaultScenarioColours {
		t.Errorf("got %+v, want defaults %+v", response, defaultScenarioColours)
	}
}

func TestInfoEndpoint(t *testing.T) {
	handler := newTestHandler()
	r := mux.NewRouter()
	handler.RegisterRoutes(r)

	req := httptest.NewRequest("GET", "/info", nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	var response map[string]interface{}
	json.NewDecoder(w.Body).Decode(&response)

	if response["version"] != "test" {
		t.Errorf("Expected version 'test', got '%v'", response["version"])
	}
}

func TestListTilesetsEmpty(t *testing.T) {
	handler := newTestHandler()
	r := mux.NewRouter()
	handler.RegisterRoutes(r)

	req := httptest.NewRequest("GET", "/tilesets", nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}
}

func TestListScenariosEmpty(t *testing.T) {
	handler := newTestHandler()
	r := mux.NewRouter()
	handler.RegisterRoutes(r)

	req := httptest.NewRequest("GET", "/scenarios", nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}
}

func TestListColumnsEmpty(t *testing.T) {
	handler := newTestHandler()
	r := mux.NewRouter()
	handler.RegisterRoutes(r)

	req := httptest.NewRequest("GET", "/columns", nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}
}

func TestComparisonDataMissingParams(t *testing.T) {
	handler := newTestHandler()
	r := mux.NewRouter()
	handler.RegisterRoutes(r)

	req := httptest.NewRequest("GET", "/compare", nil)
	w := httptest.NewRecorder()

	r.ServeHTTP(w, req)

	// Should fail because no geo store and no params
	if w.Code == http.StatusOK {
		// With no geoStore, it should return an error
		var response map[string]string
		json.NewDecoder(w.Body).Decode(&response)
		if _, hasError := response["error"]; !hasError {
			t.Error("Expected error response")
		}
	}
}
