package api

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadScenarioColours(t *testing.T) {
	t.Run("returns defaults when colours.json is absent", func(t *testing.T) {
		got := loadScenarioColours(t.TempDir())
		if got != defaultScenarioColours {
			t.Errorf("got %+v, want defaults %+v", got, defaultScenarioColours)
		}
	})

	t.Run("returns defaults when colours.json is not valid JSON", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "colours.json"), `{not valid json`)
		got := loadScenarioColours(dir)
		if got != defaultScenarioColours {
			t.Errorf("got %+v, want defaults %+v", got, defaultScenarioColours)
		}
	})

	t.Run("overrides every field when all three are set", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "colours.json"), `{
			"reference": "#111111",
			"current": "#222222",
			"target": "#333333"
		}`)
		got := loadScenarioColours(dir)
		want := ScenarioColours{Reference: "#111111", Current: "#222222", Target: "#333333"}
		if got != want {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})

	t.Run("overrides only the fields that are set, keeping the rest default", func(t *testing.T) {
		// An admin who only wants to change the target colour should not have
		// to also know and repeat the reference/current defaults.
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "colours.json"), `{"target": "#ff00ff"}`)
		got := loadScenarioColours(dir)
		want := ScenarioColours{
			Reference: defaultScenarioColours.Reference,
			Current:   defaultScenarioColours.Current,
			Target:    "#ff00ff",
		}
		if got != want {
			t.Errorf("got %+v, want %+v", got, want)
		}
	})

	t.Run("ignores a blank field rather than overriding with an empty colour", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "colours.json"), `{"reference": ""}`)
		got := loadScenarioColours(dir)
		if got != defaultScenarioColours {
			t.Errorf("got %+v, want defaults %+v", got, defaultScenarioColours)
		}
	})
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("writing %s: %v", path, err)
	}
}
